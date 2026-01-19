import type { Handler } from "@netlify/functions";
import { supabaseAdmin } from "./_supabase";
import { XMLParser } from "fast-xml-parser";

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

    // Safety: avoid runaway time in serverless
    if (part > 30) break; // very long eps: cap chunks
  }

  return transcript.trim();
}

/* -------------------- handler -------------------- */

export const handler: Handler = async () => {
  try {
    console.log("INGEST_BG stage1 start");

    if (!supabaseAdmin) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }),
      };
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }

    // 1) Fetch RSS
    const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `RSS fetch failed: ${rssRes.status}` }),
      };
    }
    const xml = await rssRes.text();
    console.log("INGEST_BG rss fetched");

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);

    const items = parsed?.rss?.channel?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];
    if (!list.length) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "No RSS items found" }),
      };
    }

    // Newest-first
    const newest = list[0];
    const title = newest?.title ?? "AI Daily Brief";
    const pubDate = newest?.pubDate;
    const guid = getGuid(newest) || `${title}-${pubDate}`;
    const audioUrl = getEnclosureUrl(newest);

    if (!pubDate || !audioUrl) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "RSS item missing pubDate or audio enclosure" }),
      };
    }

    const published_at = new Date(pubDate).toISOString();
    const published_date = toYYYYMMDD_ET(pubDate);

    console.log("INGEST_BG newest", { guid, published_date });

    // 2) Ensure row exists (insert placeholder if missing)
    const { data: existing, error: existErr } = await supabaseAdmin
      .from("episodes")
      .select("id, transcript")
      .eq("id", guid)
      .maybeSingle();

    if (existErr) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `DB check failed: ${existErr.message}` }),
      };
    }

    if (!existing?.id) {
      const { error: insErr } = await supabaseAdmin.from("episodes").insert([
        {
          id: guid,
          title,
          published_at,
          published_date,
          audio_url: audioUrl,
          // transcript will be filled next
        },
      ]);
      if (insErr) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Insert placeholder failed: ${insErr.message}` }),
        };
      }
      console.log("INGEST_BG inserted placeholder row");
    }

    // 3) If transcript already exists and looks non-empty, skip
    if (existing?.transcript && (existing.transcript as string).length > 2000) {
      console.log("INGEST_BG transcript already present, noop");
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "noop",
          message: "Transcript already saved",
          id: guid,
          published_date,
        }),
      };
    }

    // 4) Transcribe (chunked)
    console.log("INGEST_BG starting transcription");
    const transcript = await transcribeInChunks(openaiKey, audioUrl);
    console.log("INGEST_BG transcription done", { transcript_chars: transcript.length });

    // 5) Save transcript (stage 1)
    const { error: updateErr } = await supabaseAdmin
      .from("episodes")
      .update({
        title,
        published_at,
        published_date,
        audio_url: audioUrl,
        transcript,
      })
      .eq("id", guid);

    if (updateErr) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Update transcript failed: ${updateErr.message}` }),
      };
    }

    console.log("INGEST_BG transcript saved");

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "transcript_saved",
        id: guid,
        published_date,
        transcript_chars: transcript.length,
      }),
    };
  } catch (e: any) {
    console.log("INGEST_BG error", e?.message || e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e?.message || "Unknown error" }),
    };
  }
};
