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
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
    if (!supabaseAdmin) return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }) };

    const client = new OpenAI({ apiKey: openaiKey });

    const { data: rows, error } = await supabaseAdmin
      .from("episodes")
      .select("id,title,published_date,published_at,transcript,highlights")
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

    const candidates = (rows || []).filter((r: any) => r.highlights == null && isRealTranscript(r.transcript));
    const ep = candidates[0];

    if (!ep) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: true,
          message: "No candidates (need highlights=null AND real transcript)",
          candidates: candidates.length,
        }),
      };
    }

    const transcript: string = ep.transcript;
    const head = transcript.slice(0, 18000);
    const tail = transcript.length > 22000 ? transcript.slice(-4000) : "";
    const transcriptForModel = tail ? `${head}\n\n[...]\n\n${tail}` : head;

    const retrievalQuery = `${ep.title} AI Daily Brief`;
    let sources: WebSource[] = [];
    try {
      sources = await tavilySearch(retrievalQuery, 5);
    } catch {
      sources = [];
    }

    const sourcesText =
      sources.length === 0
        ? "(No external sources available.)"
        : sources
            .map((s, i) => `(${i + 1}) ${s.title}\n${s.url}\n${(s.snippet || "").trim().slice(0, 500)}`)
            .join("\n\n");

    const system = `
You are a senior AI analyst producing a detailed daily brief from a podcast transcript.

Primary source: transcript. You also have web snippets + URLs.
Prefer transcript if there is any conflict.
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
    const highlights = safeJsonParse<Highlights>(text);

    const { error: updateErr } = await supabaseAdmin
      .from("episodes")
      .update({ highlights, sources })
      .eq("id", ep.id);

    if (updateErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "Update failed", details: updateErr }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, updated_id: ep.id, title: ep.title, sources_count: sources.length, highlights }, null, 2),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
