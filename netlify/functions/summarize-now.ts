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

function isEmptyObject(v: any): boolean {
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

function isEmptySources(v: any): boolean {
  return v == null || (Array.isArray(v) && v.length === 0);
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

  const reqStr = (k: keyof Highlights) => {
    const v = (h as any)[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${String(k)}`);
  };

  reqStr("one_sentence_summary");
  reqStr("what_changed");
  reqStr("why_it_matters_now");
  reqStr("who_should_care");

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
  if (!sources.length) return "(No external sources available.)";
  return sources
    .slice(0, 8)
    .map((s, i) => {
      const title = (s.title || "").trim().slice(0, 200) || "Untitled";
      const url = (s.url || "").trim();
      const snippet = (s.snippet || "").trim().slice(0, 500);
      return `(${i + 1}) ${title}\n${url}${snippet ? `\n${snippet}` : ""}`;
    })
    .join("\n\n");
}

function dedupeSources(sources: WebSource[], cap = 8): WebSource[] {
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

async function tavilySearch(query: string, maxResults = 5): Promise<WebSource[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("Missing TAVILY_API_KEY");

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_images: false,
      include_raw_content: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Tavily search failed: ${resp.status} ${text.slice(0, 300)}`);
  }

  const json: any = await resp.json();
  const results = Array.isArray(json?.results) ? json.results : [];

  return results
    .map((r: any) => ({
      title: String(r?.title || "").slice(0, 200),
      url: String(r?.url || ""),
      snippet: String(r?.content || r?.snippet || "").slice(0, 700),
    }))
    .filter((r: WebSource) => r.url);
}

export const handler: Handler = async () => {
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
    if (!supabaseAdmin) return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }) };

    const client = new OpenAI({ apiKey: openaiKey });

    const { data: rows, error } = await supabaseAdmin
      .from("episodes")
      .select("id,title,published_date,published_at,transcript,highlights,sources,highlights_error")
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

    const all = rows || [];

    // Candidate rule (fixed):
    // - Must have a real transcript
    // - Must be missing highlights (NULL or {})
    //   OR missing sources (NULL or [])
    const candidates = all.filter((r: any) => {
      if (!isRealTranscript(r.transcript)) return false;

      const missingHighlights = r.highlights == null || isEmptyObject(r.highlights);
      const missingSources = isEmptySources(r.sources);

      return missingHighlights || missingSources;
    });

    const ep = candidates[0];

    if (!ep) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: true,
          message: "No candidates (need missing highlights (NULL or {}) OR missing sources (NULL or []), plus real transcript)",
          candidates: 0,
        }),
      };
    }

    const transcript: string = ep.transcript;
    const head = transcript.slice(0, 18000);
    const tail = transcript.length > 22000 ? transcript.slice(-4000) : "";
    const transcriptForModel = tail ? `${head}\n\n[...]\n\n${tail}` : head;

    // 1) Retrieval: only fetch if sources missing
    let sources: WebSource[] = Array.isArray(ep.sources) ? (ep.sources as WebSource[]) : [];
    const needSources = isEmptySources(ep.sources);

    if (needSources) {
      // Minimal improvement: include title + date (helps relevance), avoid podcast name bias
      const retrievalQuery = `${ep.title} ${ep.published_date}`;
      try {
        const raw = await tavilySearch(retrievalQuery, 5);
        sources = dedupeSources(raw, 8);
      } catch (e: any) {
        // Don't fail the whole run if retrieval fails
        sources = [];
        console.log("TAVILY failed", String(e?.message || e).slice(0, 200));
      }

      const { error: srcErr } = await supabaseAdmin.from("episodes").update({ sources }).eq("id", ep.id);
      if (srcErr) throw new Error(`Update sources failed: ${srcErr.message}`);
    }

    // 2) Summarize: only if highlights missing (NULL or {})
    const needHighlights = ep.highlights == null || isEmptyObject(ep.highlights);

    if (!needHighlights) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          {
            ok: true,
            updated_id: ep.id,
            title: ep.title,
            message: "Sources backfilled; highlights already present",
            sources_count: sources.length,
          },
          null,
          2
        ),
      };
    }

    const sourcesText = buildSourcesText(sources);

    const system = `
You are a senior AI analyst producing a detailed daily brief from a podcast transcript.

Primary source: transcript. You also have web snippets + URLs.
Prefer transcript if there is any conflict.
Only use external sources if they clearly match something in the transcript.
Do not invent facts not supported by transcript or snippets.
If uncertain, frame as interpretation.

Return ONLY valid JSON with the exact schema requested.
`.trim();

    const user =
      `Episode title: ${ep.title}\nPublished date: ${ep.published_date}\n\n` +
      `Transcript:\n${transcriptForModel}\n\n` +
      `External web context (snippets + URLs):\n${sourcesText}\n\n` +
      `Return ONLY valid JSON with this exact shape:\n` +
      `{\n` +
      `  "one_sentence_summary": string,\n` +
      `  "what_changed": string,\n` +
      `  "why_it_matters_now": string,\n` +
      `  "who_should_care": string,\n` +
      `  "top_takeaways": string[] (4-7 items),\n` +
      `  "stories": { "headline": string, "why_it_matters": string }[] (3-5 items)\n` +
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

    const { error: updateErr } = await supabaseAdmin
      .from("episodes")
      .update({ highlights, highlights_error: null })
      .eq("id", ep.id);

    if (updateErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "Update failed", details: updateErr }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        { ok: true, updated_id: ep.id, title: ep.title, sources_count: sources.length, highlights },
        null,
        2
      ),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
