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
  if (!Array.isArray(h.stories) || h.stories.length < 2) {
    throw new Error("stories must be an array with at least 2 items");
  }
  for (const s of h.stories) {
    if (!s || typeof s !== "object") throw new Error("story is not an object");
    if (typeof s.headline !== "string" || typeof s.why_it_matters !== "string") {
      throw new Error("story missing headline/why_it_matters");
    }
  }

  return h as Highlights;
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
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tavily search failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const results = (json?.results ?? []) as any[];

  return results
    .map((r) => ({
      title: String(r?.title || "").slice(0, 200),
      url: String(r?.url || ""),
      snippet: String(r?.content || r?.snippet || "").slice(0, 700),
    }))
    .filter((r) => r.url);
}

export const handler: Handler = async () => {
  try {
    console.log("SUM_BG start (summarize up to 2 episodes with Tavily)");

    if (!supabaseAdmin) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const client = new OpenAI({ apiKey: openaiKey });

    const { data: rows, error } = await supabaseAdmin
      .from("episodes")
      .select("id,title,published_at,published_date,transcript,highlights")
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) throw new Error(`Fetch episodes failed: ${error.message}`);

    const candidates = (rows || [])
      .filter((r: any) => r.highlights == null && isRealTranscript(r.transcript))
      .slice(0, 2);

    console.log("SUM_BG candidates", { found: candidates.length, ids: candidates.map((c: any) => c.id) });

    for (const ep of candidates) {
      const id = ep.id as string;

      try {
        const transcript: string = ep.transcript;

        const head = transcript.slice(0, 18000);
        const tail = transcript.length > 22000 ? transcript.slice(-4000) : "";
        const transcriptForModel = tail ? `${head}\n\n[...]\n\n${tail}` : head;

        // Retrieval query: lightweight + effective
        const retrievalQuery = `${ep.title} AI Daily Brief`;
        console.log("SUM_BG tavily search", { id, retrievalQuery });

        let sources: WebSource[] = [];
        try {
          sources = await tavilySearch(retrievalQuery, 5);
        } catch (tErr: any) {
          // Don't fail summarization if retrieval fails; proceed transcript-only
          console.log("SUM_BG tavily failed (continuing transcript-only)", {
            id,
            msg: String(tErr?.message || tErr).slice(0, 400),
          });
          sources = [];
        }

        const sourcesText =
          sources.length === 0
            ? "(No external sources available.)"
            : sources
                .map(
                  (s, i) =>
                    `(${i + 1}) ${s.title}\n${s.url}\n${(s.snippet || "").trim().slice(0, 500)}`
                )
                .join("\n\n");

        const system = `
You are a senior AI analyst producing a detailed daily brief from a podcast transcript.

Goal: help the reader understand the topic well enough to discuss it intelligently.

Primary source: the transcript. Use it to ground claims.
You will also receive external web context snippets with URLs. Use them to add detail and background.
Rules for web context:
- Prefer transcript if there is any conflict.
- Do not invent facts not supported by the transcript or the provided web snippets.
- Avoid phrasing like “according to recent reports” unless the snippet clearly supports it.
- If something is uncertain, frame it as interpretation ("This suggests...", "A common implication is...").

Tone:
- Analytical, clear, not hypey
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
          `  "top_takeaways": string[] (4-7 items; can be multi-sentence if helpful),\n` +
          `  "stories": { "headline": string, "why_it_matters": string }[] (3-5 items)\n` +
          `}\n` +
          `Guidelines:\n` +
          `- Make what_changed / why_it_matters_now / who_should_care substantive (2-5 sentences each).\n` +
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

        const { error: updateErr } = await supabaseAdmin
          .from("episodes")
          .update({ highlights, sources, highlights_error: null })
          .eq("id", id);

        if (updateErr) throw new Error(`Update highlights failed: ${updateErr.message}`);

        console.log("SUM_BG saved highlights + sources", { id, sources: sources.length });
      } catch (inner: any) {
        const msg = String(inner?.message || inner).slice(0, 800);
        console.log("SUM_BG failed episode", { id, msg });

        await supabaseAdmin.from("episodes").update({ highlights_error: msg }).eq("id", id);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok", processed: candidates.length }),
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
