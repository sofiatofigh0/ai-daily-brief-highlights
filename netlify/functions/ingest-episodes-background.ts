import type { Handler } from "@netlify/functions";
import { supabaseAdmin } from "./_supabase";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

/* -------------------- helpers -------------------- */

function toYYYYMMDD_ET(dateStr: string): string {
  const d = new Date(dateStr);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function getGuid(item: any): string {
  if (!item?.guid) return "";
  if (typeof item.guid === "string") return item.guid;
  return item.guid["#text"] || "";
}

function getEnclosureUrl(item: any): string | null {
  const enc = item?.enclosure;
  if (!enc) return null;
  if (Array.isArray(enc)) return enc[0]?.["@_url"] || null;
  return enc["@_url"] || null;
}

/* -------------------- audio + transcription -------------------- */

async function downloadAudioAsArrayBuffer(audioUrl: string) {
  const res = await fetch(audioUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Audio download failed: ${res.status}`);
  return await res.arrayBuffer();
}

async function transcribeInChunks(openaiKey: string, audioUrl: string): Promise<string> {
  const buffer = await downloadAudioAsArrayBuffer(audioUrl);

  // ~8MB chunks keeps us under model limits
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const fastMode = process.env.LOCAL_FAST_MODE === "true";

  let offset = 0;
  let part = 1;
  let transcript = "";

  while (offset < buffer.byteLength) {
    const slice = buffer.slice(offset, offset + CHUNK_SIZE);
    offset += CHUNK_SIZE;

    const blob = new Blob([slice], { type: "audio/mpeg" });
    const form = new FormData();
    form.append("file", blob, `part-${part}.mp3`);
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("response_format", "json");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Chunk ${part} transcription failed: ${resp.status} ${txt}`);
    }

    const json = await resp.json();
    if (!json?.text) throw new Error(`Chunk ${part} missing text`);

    transcript += json.text + "\n\n";
    part++;

    // 🔒 Local dev guard: avoids 30s netlify dev timeout
    if (fastMode && part > 2) break; // transcribe only first chunk locally
  }

  return transcript.trim();
}

/* -------------------- summarization (Responses API via fetch) -------------------- */

const HighlightsSchema = z.object({
  one_sentence_summary: z.string(),
  top_takeaways: z.array(z.string()).min(3).max(7),
  stories: z
    .array(
      z.object({
        headline: z.string(),
        why_it_matters: z.string(),
      })
    )
    .min(2)
    .max(6),
  action_items: z.array(z.string()).min(1).max(5).optional(),
});

type Highlights = z.infer<typeof HighlightsSchema>;

/**
 * Extracts the model's text output from a Responses API response JSON.
 * Works even if the shape changes slightly.
 */
function extractOutputText(respJson: any): string {
  // Common helper field in some SDKs / responses
  if (typeof respJson?.output_text === "string" && respJson.output_text.trim()) {
    return respJson.output_text;
  }

  const output = respJson?.output;
  if (!Array.isArray(output)) return "";

  // Look for output_text content blocks
  let collected = "";
  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        collected += c.text + "\n";
      }
    }
  }
  return collected.trim();
}

/**
 * Calls Responses API and returns validated highlights JSON.
 * Uses JSON schema response_format so the model is strongly encouraged to return valid JSON.
 */
async function summarizeTranscript(openaiKey: string, title: string, transcript: string): Promise<Highlights> {
  const fastMode = process.env.LOCAL_FAST_MODE === "true";

  // Keep local runs snappy so netlify dev doesn't time out
  const transcriptForModel = fastMode ? transcript.slice(0, 12000) : transcript;

  const instructions =
    "You are a crisp AI news synthesizer. Produce concise, factual highlights from the transcript. " +
    "Do not invent facts. Prefer short, concrete phrasing.";

  // JSON Schema for response_format (keeps output reliably structured)
  const jsonSchema = {
    name: "highlights",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        one_sentence_summary: { type: "string" },
        top_takeaways: {
          type: "array",
          minItems: 3,
          maxItems: 7,
          items: { type: "string" },
        },
        stories: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              why_it_matters: { type: "string" },
            },
            required: ["headline", "why_it_matters"],
          },
        },
        action_items: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string" },
        },
      },
      required: ["one_sentence_summary", "top_takeaways", "stories"],
    },
  };

  const body = {
    model: "gpt-5-mini",
    instructions,
    input:
      `Podcast title: ${title}\n\n` +
      "Return ONLY valid JSON matching the schema.\n\n" +
      "Transcript:\n" +
      transcriptForModel,
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    },
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Summarization failed: ${resp.status} ${txt}`);
  }

  const json = await resp.json();
  const text = extractOutputText(json);
  if (!text) throw new Error("Summarization returned no output text");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Model returned non-JSON output. First 400 chars: ${text.slice(0, 400)}`);
  }

  const validated = HighlightsSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Highlights JSON failed validation: ${validated.error.message}`);
  }

  return validated.data;
}

/* -------------------- handler -------------------- */

export const handler: Handler = async () => {
  try {
    if (!supabaseAdmin) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }),
      };
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }

    const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `RSS fetch failed: ${rssRes.status}` }),
      };
    }

    const xml = await rssRes.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);

    const items = parsed?.rss?.channel?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];
    if (!list.length) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "No RSS items found" }),
      };
    }

    const newest = list[0];
    const title = newest?.title ?? "AI Daily Brief";
    const pubDate = newest?.pubDate;
    const guid = getGuid(newest) || `${title}-${pubDate}`;
    const audioUrl = getEnclosureUrl(newest);

    if (!pubDate || !audioUrl) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "RSS item missing pubDate or audio enclosure" }),
      };
    }

    const published_at = new Date(pubDate).toISOString();
    const published_date = toYYYYMMDD_ET(pubDate);

    const { data: existing, error: existErr } = await supabaseAdmin
      .from("episodes")
      .select("id, highlights")
      .eq("id", guid)
      .maybeSingle();

    if (existErr) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `DB check failed: ${existErr.message}` }),
      };
    }

    const existingSummary = (existing as any)?.highlights?.one_sentence_summary as string | undefined;
    const isPlaceholder =
      !existingSummary || existingSummary.toLowerCase().includes("new episode detected");

    // 1) Transcribe (chunked)
    const transcript = await transcribeInChunks(openaiKey, audioUrl);

    // 2) Summarize (structured JSON)
    const highlights = await summarizeTranscript(openaiKey, title, transcript);

    if (existing?.id && !isPlaceholder) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "noop",
          message: "Already ingested with real highlights",
          id: existing.id,
          published_date,
          title,
        }),
      };
    }

    if (existing?.id && isPlaceholder) {
      const { error: updateErr } = await supabaseAdmin
        .from("episodes")
        .update({
          title,
          published_at,
          published_date,
          audio_url: audioUrl,
          highlights,
        })
        .eq("id", guid);

      if (updateErr) {
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Update failed: ${updateErr.message}` }),
        };
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "updated", id: guid, published_date, title }),
      };
    }

    const { error: insertErr } = await supabaseAdmin.from("episodes").insert([
      {
        id: guid,
        published_at,
        published_date,
        title,
        audio_url: audioUrl,
        highlights,
      },
    ]);

    if (insertErr) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Insert failed: ${insertErr.message}` }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "inserted", id: guid, published_date, title }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e?.message || "Unknown error" }),
    };
  }
};
