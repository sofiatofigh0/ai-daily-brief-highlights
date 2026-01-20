import type { Handler } from "@netlify/functions";
import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase";

type Highlights = {
  one_sentence_summary: string;
  top_takeaways: string[];
  stories: { headline: string; why_it_matters: string }[];
  action_items?: string[];
};

function isRealTranscript(t: any): boolean {
  if (!t || typeof t !== "string") return false;
  if (t === "__PROCESSING_TRANSCRIPT__") return false;
  if (t.startsWith("__ERROR__")) return false;
  return t.length > 2000;
}

function safeJsonParse<T>(text: string): T {
  // If the model returns extra text, try to grab the first JSON object
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
  if (!Array.isArray(h.top_takeaways) || h.top_takeaways.length < 3) {
    throw new Error("top_takeaways must be an array with at least 3 items");
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
  // Action items optional
  if (h.action_items && !Array.isArray(h.action_items)) throw new Error("action_items must be an array if present");
  return h as Highlights;
}

export const handler: Handler = async () => {
  try {
    console.log("SUM_BG start (summarize up to 2 episodes)");

    if (!supabaseAdmin) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const client = new OpenAI({ apiKey: openaiKey });

    // 1) Fetch candidate episodes (recent first)
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

        // Keep prompt size sane: summarize from the first N chars + last M chars
        // (Most episodes are short, but this protects us.)
        const head = transcript.slice(0, 18000);
        const tail = transcript.length > 22000 ? transcript.slice(-4000) : "";
        const transcriptForModel = tail ? `${head}\n\n[...]\n\n${tail}` : head;

        const system =
          "You are a precise news editor. Convert the podcast transcript into structured highlights. " +
          "Be factual to the transcript, avoid speculation, remove filler, keep phrasing crisp.";

        const user =
          `Episode title: ${ep.title}\n` +
          `Published date: ${ep.published_date}\n\n` +
          `Transcript:\n${transcriptForModel}\n\n` +
          `Return ONLY valid JSON with this exact shape:\n` +
          `{\n` +
          `  "one_sentence_summary": string,\n` +
          `  "top_takeaways": string[] (5 items),\n` +
          `  "stories": { "headline": string, "why_it_matters": string }[] (3 items),\n` +
          `  "action_items": string[] (optional, 0-3 items)\n` +
          `}\n` +
          `Constraints:\n` +
          `- one_sentence_summary: 1 sentence, no emojis\n` +
          `- top_takeaways: short bullets, no more than ~14 words each\n` +
          `- stories: each headline <= 10 words; why_it_matters 1-2 sentences\n`;

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

        // 2) Save highlights + clear any prior error
        const { error: updateErr } = await supabaseAdmin
          .from("episodes")
          .update({ highlights, highlights_error: null })
          .eq("id", id);

        if (updateErr) throw new Error(`Update highlights failed: ${updateErr.message}`);

        console.log("SUM_BG saved highlights", { id });
      } catch (inner: any) {
        const msg = String(inner?.message || inner).slice(0, 800);
        console.log("SUM_BG failed episode", { id, msg });

        // Save error message (best effort)
        await supabaseAdmin
          .from("episodes")
          .update({ highlights_error: msg })
          .eq("id", id);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        processed: candidates.length,
      }),
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
