// netlify/functions/summarize-episodes-background.ts
import type { Handler, HandlerEvent } from "@netlify/functions";
import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase";

/* -------------------- config -------------------- */

const MAX_BACKFILL_DEPTH = 15; // Max self-chain iterations to prevent runaway
const EPISODES_PER_RUN = 2;   // How many summarizations per run

type WebSource = {
  title: string;
  url: string;
  snippet?: string;
};

type Highlights = {
  one_sentence_summary: string;
  what_changed: string;
  why_it_matters_now: string;
  who_should_care: string;
  top_takeaways: string[];
  stories: { headline: string; why_it_matters: string }[];
};

/* ------------------------- helpers ------------------------- */

function isRealTranscript(t: any): boolean {
  if (!t || typeof t !== "string") return false;
  if (t === "__PROCESSING_TRANSCRIPT__") return false;
  if (t.startsWith("__ERROR__")) return false;
  return t.length > 2000;
}

function isEmptyObject(v: any): boolean {
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

function isEmptySources(v: any): boolean {
  return v == null || (Array.isArray(v) && v.length === 0);
}

function safeJsonParse<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function validateHighlights(h: any): Highlights {
  if (!h || typeof h !== "object") throw new Error("Highlights not an object");

  const req = (k: keyof Highlights) => {
    const v = h[k];
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`Missing ${String(k)}`);
    }
  };

  req("one_sentence_summary");
  req("what_changed");
  req("why_it_matters_now");
  req("who_should_care");

  if (!Array.isArray(h.top_takeaways) || h.top_takeaways.length < 4) {
    throw new Error("top_takeaways must have at least 4 items");
  }

  if (!Array.isArray(h.stories) || h.stories.length < 3) {
    throw new Error("stories must have at least 3 items");
  }

  for (const s of h.stories) {
    if (!s || typeof s !== "object") throw new Error("story is not an object");
    if (typeof s.headline !== "string" || !s.headline.trim()) {
      throw new Error("story missing headline");
    }
    if (typeof s.why_it_matters !== "string" || !s.why_it_matters.trim()) {
      throw new Error("story missing why_it_matters");
    }
  }

  return h as Highlights;
}

function buildSourcesText(sources: WebSource[]): string {
  if (!sources.length) return "(No external sources available.)";

  return sources
    .slice(0, 5) // allow up to 5 sources for richer context
    .map((s, i) => {
      const title = (s.title || "").trim().slice(0, 200) || "Untitled";
      const url = (s.url || "").trim();
      const snippet = (s.snippet || "").trim().slice(0, 500);
      return `(${i + 1}) ${title}\n${url}${snippet ? `\n${snippet}` : ""}`;
    })
    .join("\n\n");
}

function dedupeSources(sources: WebSource[], cap = 3): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];

  for (const s of sources) {
    const url = (s.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: s.title, url, snippet: s.snippet });
    if (out.length >= cap) break;
  }

  return out;
}

/**
 * Retrieval policy:
 * - Prefer credible news/blog/research/video sources
 * - Avoid social networks and podcast hosts/directories
 */
const TAVILY_EXCLUDE_DOMAINS = [
  // social
  "facebook.com",
  "fb.com",
  "instagram.com",
  "threads.net",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "reddit.com",

  // podcast hosts/directories (avoid “referring back to the podcast”)
  "anchor.fm",
  "spotify.com",
  "open.spotify.com",
  "podcasts.apple.com",
  "player.fm",
  "listennotes.com",
  "podbean.com",
  "buzzsprout.com",
  "captivate.fm",
  "simplecast.com",
  "transistor.fm",
  "audacy.com",
  "iheartradio.com",
];

const TAVILY_INCLUDE_DOMAINS = [
  // research/papers
  "arxiv.org",
  "openreview.net",
  "paperswithcode.com",

  // reputable news/tech/business
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "ft.com",
  "wsj.com",
  "bloomberg.com",
  "theverge.com",
  "techcrunch.com",
  "wired.com",
  "venturebeat.com",

  // company blogs/docs (high-signal)
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "ai.googleblog.com",
  "googleblog.com",
  "microsoft.com",
  "azure.microsoft.com",
  "aws.amazon.com",
  "nvidia.com",

  // non-social video
  "youtube.com",
];

function hostFromUrl(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Extract searchable topics from transcript using LLM.
 * Returns 3-4 specific, concrete search queries based on actual content.
 */
async function extractSearchTopics(
  client: OpenAI,
  transcript: string,
  title: string
): Promise<string[]> {
  const excerpt = transcript.slice(0, 10000); // Use first ~10k chars for extraction

  const prompt = `Analyze this podcast transcript and extract 3-4 specific, searchable topics.

For each topic, create a short search query (5-10 words) that would find relevant news articles, blog posts, or research papers.

Focus on:
- Specific company announcements or product launches mentioned
- Named research papers or studies discussed
- Specific people and what they said/did
- Concrete claims or statistics that could be verified

Do NOT include:
- Generic topics like "AI news" or "technology trends"
- The podcast name or host
- Vague summaries

Episode title: ${title}

Transcript excerpt:
${excerpt}

Return ONLY a JSON array of 3-4 search query strings. Example:
["OpenAI GPT-5 release announcement 2024", "Anthropic Claude 3 safety research paper", "Sam Altman interview Davos AI regulation"]`;

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const text = resp.choices?.[0]?.message?.content ?? "[]";
    // Extract JSON array from response
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) return [];

    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((t: any) => typeof t === "string" && t.trim().length > 0)
      .slice(0, 4);
  } catch (e: any) {
    console.log("Topic extraction failed", e?.message || e);
    return [];
  }
}

async function tavilySearch(query: string, maxResults = 3): Promise<WebSource[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY");

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "advanced",
      include_answer: false,
      include_images: false,
      include_raw_content: false,
      include_domains: TAVILY_INCLUDE_DOMAINS,
      exclude_domains: TAVILY_EXCLUDE_DOMAINS,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Tavily error ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const json: any = await resp.json();
  const results = Array.isArray(json?.results) ? json.results : [];

  // hard-filter, in case Tavily still returns excluded domains
  const blocked = new Set(TAVILY_EXCLUDE_DOMAINS.map((d) => d.toLowerCase()));

  return results
    .map((r: any) => ({
      title: String(r?.title || "").slice(0, 200),
      url: String(r?.url || ""),
      snippet: String(r?.content || r?.snippet || "").slice(0, 700),
    }))
    .filter((r: WebSource) => {
      if (!r.url) return false;
      const host = hostFromUrl(r.url);
      if (!host) return false;
      if (blocked.has(host)) return false;
      return true;
    });
}

/* ------------------------- handler ------------------------- */

export const handler: Handler = async (event: HandlerEvent) => {
  // Parse depth from query params (for backfill chaining)
  const depth = parseInt(event.queryStringParameters?.depth || "0", 10);

  try {
    console.log(`SUM_BG start (depth=${depth}, up to ${EPISODES_PER_RUN} episodes)`);

    if (!supabaseAdmin) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const client = new OpenAI({ apiKey: openaiKey });

    const { data: rows, error } = await supabaseAdmin
      .from("episodes")
      .select("id,title,published_at,published_date,transcript,highlights,sources,highlights_error")
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) throw new Error(`Fetch episodes failed: ${error.message}`);

    const allCandidates = (rows || [])
      .filter((r: any) => {
        if (!isRealTranscript(r.transcript)) return false;
        const missingHighlights = r.highlights == null || isEmptyObject(r.highlights);
        const missingSources = isEmptySources(r.sources);
        return missingHighlights || missingSources;
      });

    const candidates = allCandidates.slice(0, EPISODES_PER_RUN);

    console.log("SUM_BG candidates", candidates.map((c: any) => c.id));

    let processed = 0;

    for (const ep of candidates) {
      const id = String(ep.id);

      try {
        const transcript: string = ep.transcript;
        const head = transcript.slice(0, 18000);
        const tail = transcript.length > 22000 ? transcript.slice(-4000) : "";
        const transcriptForModel = tail ? `${head}\n\n[...]\n\n${tail}` : head;

        /* ---- retrieval (sources) ---- */
        let sources: WebSource[] = Array.isArray(ep.sources) ? ep.sources : [];
        const needSources = isEmptySources(ep.sources);

        if (needSources) {
          // Extract specific searchable topics from transcript
          const topics = await extractSearchTopics(client, transcript, ep.title);
          console.log("SUM_BG extracted topics", { id, topics });

          // Run parallel searches for each topic
          let allResults: WebSource[] = [];

          if (topics.length > 0) {
            const searchPromises = topics.slice(0, 3).map((topic) =>
              tavilySearch(topic, 2).catch((e: any) => {
                console.log("TAVILY topic search failed", { topic, err: e?.message });
                return [] as WebSource[];
              })
            );

            const results = await Promise.all(searchPromises);
            allResults = results.flat();
          }

          // Fallback: if no topics extracted or no results, try title-based search
          if (allResults.length === 0) {
            console.log("SUM_BG falling back to title search", { id });
            const fallbackQuery = `${ep.title} ${ep.published_date} AI news announcement`;
            try {
              allResults = await tavilySearch(fallbackQuery, 3);
            } catch (e: any) {
              console.log("TAVILY fallback failed", String(e?.message || e).slice(0, 200));
            }
          }

          // Dedupe and cap at 5 sources (more variety from multiple topics)
          sources = dedupeSources(allResults, 5);
          console.log("SUM_BG sources found", { id, count: sources.length });

          const { error: srcErr } = await supabaseAdmin
            .from("episodes")
            .update({ sources })
            .eq("id", id);

          if (srcErr) throw new Error(`Update sources failed: ${srcErr.message}`);
        }

        /* ---- summarization ---- */
        const needHighlights = ep.highlights == null || isEmptyObject(ep.highlights);

        if (needHighlights) {
          const sourcesText = buildSourcesText(sources);

          const system = `
You are a senior AI analyst producing a detailed daily brief from a podcast transcript.

Primary source: the transcript.
Use external web snippets only to clarify background or implications.
Prefer transcript if there is any conflict.
Do not invent facts.
If uncertain, frame as interpretation.

Return ONLY valid JSON with the exact schema requested.
          `.trim();

          const user =
            `Episode title: ${ep.title}\n` +
            `Published date: ${ep.published_date}\n\n` +
            `Transcript:\n${transcriptForModel}\n\n` +
            `External web context (snippets + URLs):\n${sourcesText}\n\n` +
            `Return ONLY valid JSON with this exact shape:\n` +
            `{\n` +
            `  "one_sentence_summary": string,\n` +
            `  "what_changed": string,\n` +
            `  "why_it_matters_now": string,\n` +
            `  "who_should_care": string,\n` +
            `  "top_takeaways": string[] (4–7 items),\n` +
            `  "stories": { "headline": string, "why_it_matters": string }[] (3–5 items)\n` +
            `}\n`;

          const resp = await client.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.2,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          });

          const text = resp.choices?.[0]?.message?.content ?? "";
          const parsed = safeJsonParse<Highlights>(text);
          const highlights = validateHighlights(parsed);

          const { error: updErr } = await supabaseAdmin
            .from("episodes")
            .update({ highlights, highlights_error: null })
            .eq("id", id);

          if (updErr) throw new Error(`Update highlights failed: ${updErr.message}`);
        }

        processed += 1;
      } catch (inner: any) {
        const msg = String(inner?.message || inner).slice(0, 800);
        console.log("SUM_BG failed", { id, msg });
        await supabaseAdmin.from("episodes").update({ highlights_error: msg }).eq("id", id);
      }
    }

    // Check if there are more unprocessed episodes (backfill needed)
    const remainingCandidates = allCandidates.length - candidates.length;
    let chainTriggered = false;

    if (remainingCandidates > 0 && depth < MAX_BACKFILL_DEPTH) {
      // Trigger another run to continue backfill
      const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
      if (base) {
        const nextDepth = depth + 1;
        const nextUrl = `${base}/.netlify/functions/summarize-episodes-background?depth=${nextDepth}`;
        console.log(`SUM_BG triggering backfill chain (depth=${nextDepth}, remaining=${remainingCandidates})`);

        // Fire-and-forget next run
        fetch(nextUrl).catch((e) =>
          console.log("SUM_BG chain trigger failed", e?.message || e)
        );
        chainTriggered = true;
      }
    } else if (remainingCandidates > 0) {
      console.log(`SUM_BG backfill max depth reached (${MAX_BACKFILL_DEPTH}), ${remainingCandidates} episodes still pending`);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        depth,
        processed,
        remaining_candidates: remainingCandidates,
        chain_triggered: chainTriggered,
      }, null, 2),
    };
  } catch (e: any) {
    console.log("SUM_BG error", e?.message || e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e?.message || "Unknown error" }),
    };
  }
};
