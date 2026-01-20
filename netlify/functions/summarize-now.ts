// netlify/functions/summarize-now.ts
import type { Handler } from "@netlify/functions";
import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase";

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

    const system = `
You are a senior AI analyst producing a detailed daily brief from a podcast transcript.

Goal: help the reader understand the topic well enough to discuss it intelligently.

Primary source: the transcript. Use it to ground claims.
You MAY add helpful background context and explanations that are widely known, but:
- Do not invent specific new events, quotes, numbers, or “recent reports” not present in the transcript.
- If you add context beyond the transcript, keep it general (no precise claims that require browsing).
- If something is uncertain, frame it as interpretation ("This suggests...", "A common implication is...").

Tone:
- Analytical, clear, not hypey
- More detailed than a generic summary

Return ONLY valid JSON with the exact schema requested.
    `.trim();

    const user =
      `Episode title: ${ep.title}\nPublished date: ${ep.published_date}\n\nTranscript:\n${transcriptForModel}\n\n` +
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

    const { error: updateErr } = await supabaseAdmin.from("episodes").update({ highlights }).eq("id", ep.id);

    if (updateErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "Update failed", details: updateErr }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, updated_id: ep.id, title: ep.title, highlights }, null, 2),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
