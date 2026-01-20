// netlify/functions/summarize-episodes-background.ts
import type { Handler } from "@netlify/functions";
import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase";

type WebSource = {
  title: string;
  url: string;
  snippet?: string;
};

type Highlights = {
  one_sentence_summary: string;

  // New detailed sections (your preferred framing)
  what_changed: string;
  why_it_matters_now: string;
  who_should_care: string;

  top_takeaways: string[];
  stories: { headline: string; why_it_matters: string }[];
};

function isRealTranscript(t: any): boolean {
  if (!t || typeof t !== "string") return false;
  if (t === "__PROCESSING_TRANSCRIPT__") return false;
  if (t.startsWith("__ERROR__")) return false;
  return t.length > 2000;
}

function safeJsonParse<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found in model output");
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice) as T;
}

function validateHighlights(h: any): Highlights {
  if (!h || typeof h !== "object") throw new Error("Highlights not an object");

  if (typeof h.one_sentence_summary !== "string" || !h.one_sentence_summary.trim()) {
    throw new Error("Missing one_sentence_summary");
  }

  if (typeof h.what_changed !== "string" || !h.what_changed.trim()) {
    throw new Error("Missing what_changed");
  }

  if (typeof h.why_it_matters_now !== "string" || !h.why_it_matters_now.trim()) {
    throw new Error("Missing why_it_matters_now");
  }

  if (typeof h.who_should_care !== "string" || !h.who_should_care.trim()) {
    throw new Error("Missing who_should_care");
  }

  if (!Array.isArray(h.top_takeaways) || h.top_takeaways.length < 4) {
    throw new Error("top_takeaways must be an array with at least 4 items");
  }

  if (!Array.isArray(h.stories) || h.stories.length < 3) {
    throw new Error("stories must be an array with at least 3 items");
  }

  for (const s of h.stories) {
    if (!s || typeof s !== "object") throw new Error("story is not an object");
    if (typeof s.headline !== "string" || !s.headline.trim()) throw new Error("story missing headline");
    if (typeof s.why_it_matters !== "string" || !s.why_it_matters.trim()) throw new Error("story missing why_it_matters");
  }

  return h as Highlights;
}

function buildSourcesText(sources: WebSource[]): string {
  if (!sources.length) return "(none)";
  return sources
    .slice(0, 8)
    .map((s, i) => {
      const title = s.title?.trim() || "Untitled";
      const url = s.url?.trim() || "";
      const snippet = (s.snippet || "").trim();
      const snipLine = snippet ? `\n${snippet}` : "";
      return `(${i + 1}) ${title}\n${url}${snipLine}\n`;
    })
    .join("\n");
}

async function tavilySearch(query: string, maxResults = 5): Promise<WebSource[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY");

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Tavily error ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const json: any = await resp.json();
  const results = Array.isArray(json?.results) ? json.results : [];

  return results
    .map((r: any) => ({
      title: String(r?.title || "").slice(0, 200),
      url: String(r?.url || ""),
      snippet: String(r?.content || r?.snippet || "").slice(0, 500),
    }))
    .filter((r: WebSource) => r.url);
}

async function generateSearchQueries(
  client: OpenAI,
  title: string,
  publishedDate: string,
  transcriptSnippet: string
): Promise<string[]> {
  const system =
    "You create high-signal web search queries to find sources that match a podcast episode's claims. Return ONLY JSON.";

  const user =
    `Episode title: ${title}\n` +
    `Published date: ${publishedDate}\n\n` +
    `Transcript snippet:\n${transcriptSnippet}\n\n` +
    `Return ONLY valid JSON:\n` +
    `{\n` +
    `  "queries": string[]\n` +
    `}\n` +
    `Rules:\n` +
    `- Provide 2 to 4 queries.\n` +
    `- Queries should include specific entities (company/product/person), not generic AI terms.\n` +
    `- Prefer "<entity> <event/announcement> <month year>" style where possible.\n` +
    `- Avoid the podcast name unless needed.\n`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = resp.choices?.[0]?.message?.content ?? "";
  const parsed = safeJsonParse<{ queries: string[] }>(text);

  const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
  return queries
    .map((q) => String(q).trim())
    .filter(Boolean)
    .slice(0, 4);
}

function dedupeSources(sources: WebSource[], cap = 8): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const s of sources) {
    const url = (s.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * IMPORTANT:
 * This background function is now designed to:
 * - summarize up to 2 episodes per run
 * - backfill BOTH:
 *   (a) missing highlights (highlights is null)
 *   (b) missing sources even if highlights exist (sources is null)
 *
 * This fixes your current state where older rows have new-format highlights but no sources.
 */
export const handler: Handler = async () => {
  try {
    console.log("SUM_BG start (summarize up to 2 episodes)");

    if (!supabaseAdmin) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const client = new OpenAI({ apiKey: openaiKey });

    // 1) Fetch recent episodes (we’ll pick candidates from these)
    const { data: rows, error } = await supabaseAdmin
      .from("episodes")
      .select("id,title,published_at,published_date,transcript,highlights,sources,highlights_error")
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) throw new Error(`Fetch episodes failed: ${error.message}`);

    const all = rows || [];

    // Candidate rule:
    // - Must have a real transcript
    // - Must either be missing highlights OR missing sources
    // - Process newest first, up to 2
    const candidates = all
      .filter((r: any) => isRealTranscript(r.transcript) && (r.highlights == null || r.sources == null))
      .slice(0, 2);

    console.log("SUM_BG candidates", {
      found: candidates.length,
      ids: candidates.map((c: any) => c.id),
      needs: candidates.map((c: any) => ({
        id: c.id,
        needHighlights: c.highlights == null,
        needSources: c.sources == null,
      })),
    });

    let processed = 0;

    for (const ep of candidates) {
      const id = String(ep.id);

      try {
        const transcript: string = ep.transcript;

        // Keep prompt size sane.
        const head = transcript.slice(0, 18000);
        const tail = transcript.length > 22000 ? transcript.slice(-4000) : "";
        const transcriptForModel = tail ? `${head}\n\n[...]\n\n${tail}` : head;

        // 2) Retrieval: only do Tavily if sources are missing
        let sources: WebSource[] = Array.isArray(ep.sources) ? (ep.sources as WebSource[]) : [];
        if (ep.sources == null) {
          const snippetForQueries = transcriptForModel.slice(0, 6000);

          const queries = await generateSearchQueries(client, ep.title, ep.published_date, snippetForQueries);

          console.log("TAVILY_QUERIES", { id, queries });

          const allSources: WebSource[] = [];
          for (const q of queries) {
            try {
              const res = await tavilySearch(q, 3);
              allSources.push(...res);
            } catch (err: any) {
              console.log("TAVILY query failed", { id, q, msg: String(err?.message || err).slice(0, 200) });
            }
          }

          sources = dedupeSources(allSources, 8);

          console.log("TAVILY_RESULTS", {
            id,
            count: sources.length,
            urls: sources.slice(0, 5).map((s) => s.url),
          });
        }

        // Always persist sources if we computed them (even if highlights already exist)
        if (ep.sources == null) {
          const { error: sourcesErr } = await supabaseAdmin
            .from("episodes")
            .update({ sources })
            .eq("id", id);

          if (sourcesErr) throw new Error(`Update sources failed: ${sourcesErr.message}`);
        }

        // 3) Summarize only if highlights are missing
        if (ep.highlights == null) {
          const sourcesText = buildSourcesText(sources);

          const system = `
You are a senior AI analyst producing a detailed daily brief from a podcast transcript.

Goal: help the reader understand the topic well enough to discuss it intelligently.

Primary source: the transcript. Use it to ground claims.
You will also receive external web context snippets with URLs. Use them to add detail and background.

Rules for web context:
- Prefer the transcript if there is any conflict.
- Only use an external source if it clearly matches something mentioned in the transcript; otherwise ignore it.
- Do not invent facts not supported by the transcript or the provided web snippets.
- Avoid phrasing like “according to recent reports” unless the snippet clearly supports it.
- If something is uncertain, frame it as interpretation (e.g., “This suggests…”, “A common implication is…”).

Tone:
- Analytical
- Clear
- Not hypey
- More detailed than a generic summary

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
            `  "top_takeaways": string[] (4–7 items; can be multi-sentence if helpful),\n` +
            `  "stories": { "headline": string, "why_it_matters": string }[] (3–5 items)\n` +
            `}\n` +
            `Guidelines:\n` +
            `- Make what_changed / why_it_matters_now / who_should_care substantive (2–5 sentences each).\n` +
            `- Use web context to clarify background or implications, not to invent new events.\n` +
            `- top_takeaways should include enough detail to support conversation.\n` +
            `- stories should cover different angles, not repeats.\n`;

          console.log("SUM_BG calling OpenAI", { id });

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

          // Save highlights + clear prior error
          const { error: updateErr } = await supabaseAdmin
            .from("episodes")
            .update({ highlights, highlights_error: null })
            .eq("id", id);

          if (updateErr) throw new Error(`Update highlights failed: ${updateErr.message}`);

          console.log("SUM_BG saved highlights", { id });
        } else {
          console.log("SUM_BG skipped highlights (already present)", { id });
        }

        processed += 1;
      } catch (inner: any) {
        const msg = String(inner?.message || inner).slice(0, 800);
        console.log("SUM_BG failed episode", { id, msg });

        // Save error message (best effort)
        await supabaseAdmin.from("episodes").update({ highlights_error: msg }).eq("id", id);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        {
          status: "ok",
          processed,
        },
        null,
        2
      ),
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
