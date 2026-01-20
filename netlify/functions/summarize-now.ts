import type { Handler } from "@netlify/functions";
import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase";

function isRealTranscript(t: any): boolean {
  if (!t || typeof t !== "string") return false;
  if (t === "__PROCESSING_TRANSCRIPT__") return false;
  if (t.startsWith("__ERROR__")) return false;
  return t.length > 2000;
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

    const system =
      "You are a precise news editor. Convert the podcast transcript into structured highlights JSON. " +
      "Be factual to the transcript, remove filler, keep phrasing crisp.";

    const user =
      `Episode title: ${ep.title}\nPublished date: ${ep.published_date}\n\nTranscript:\n${transcriptForModel}\n\n` +
      `Return ONLY valid JSON with this exact shape:\n` +
      `{\n` +
      `  "one_sentence_summary": string,\n` +
      `  "top_takeaways": string[] (5 items),\n` +
      `  "stories": { "headline": string, "why_it_matters": string }[] (3 items),\n` +
      `  "action_items": string[] (optional, 0-3 items)\n` +
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
    let highlights: any;
    try {
      highlights = JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      highlights = JSON.parse(text.slice(start, end + 1));
    }

    const { error: updateErr } = await supabaseAdmin
      .from("episodes")
      .update({ highlights })
      .eq("id", ep.id);

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
