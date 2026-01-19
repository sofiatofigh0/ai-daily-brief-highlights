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

  // ~8MB chunks to reduce "input too large" risk and keep each request reasonable
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

    // Guardrails: avoid runaway invocations
    if (part > 30) {
      console.log("INGEST_BG reached chunk cap (30). Stopping early.");
      break;
    }
  }

  return transcript.trim();
}

/* -------------------- handler -------------------- */

export const handler: Handler = async () => {
  let guid: string | null = null;

  try {
    console.log("INGEST_BG start");

    if (!supabaseAdmin) {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    // 1) Fetch RSS
    const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) throw new Error(`RSS fetch failed: ${rssRes.status}`);

    const xml = await rssRes.text();
    console.log("INGEST_BG rss fetched");

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);

    const items = parsed?.rss?.channel?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];
    if (!list.length) throw new Error("No RSS items found");

    // Newest-first
    const newest = list[0];
    const title = newest?.title ?? "AI Daily Brief";
    const pubDate = newest?.pubDate;
    guid = getGuid(newest) || `${title}-${pubDate}`;
    const audioUrl = getEnclosureUrl(newest);

    if (!pubDate || !audioUrl) throw new Error("RSS item missing pubDate or audio enclosure");

    const published_at = new Date(pubDate).toISOString();
    const published_date = toYYYYMMDD_ET(pubDate);

    console.log("INGEST_BG newest episode", { guid, published_date });

    // 2) Upsert a row immediately (visible proof)
    // NOTE: requires a unique constraint on id (your primary key already is).
    const { error: upsertErr } = await supabaseAdmin.from("episodes").upsert(
      [
        {
          id: guid,
          title,
          published_at,
          published_date,
          audio_url: audioUrl,
          transcript: "__PROCESSING_TRANSCRIPT__",
        },
      ],
      { onConflict: "id" }
    );

    if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);
    console.log("INGEST_BG upserted processing marker");

    // 3) Fetch existing to decide whether to re-transcribe
    const { data: existing, error: existErr } = await supabaseAdmin
      .from("episodes")
      .select("id, transcript")
      .eq("id", guid)
      .maybeSingle();

    if (existErr) throw new Error(`DB check failed: ${existErr.message}`);

    const existingTranscript = (existing as any)?.transcript as string | null | undefined;

    const hasRealTranscript =
      !!existingTranscript &&
      existingTranscript !== "__PROCESSING_TRANSCRIPT__" &&
      existingTranscript.length > 2000;

    if (hasRealTranscript) {
      console.log("INGEST_BG transcript already present, skipping transcription");
    } else {
      // 4) Transcribe (chunked)
      console.log("INGEST_BG starting transcription");
      const transcript = await transcribeInChunks(openaiKey, audioUrl);
      console.log("INGEST_BG transcription done", { transcript_chars: transcript.length });

      // 5) Save transcript
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

      if (updateErr) throw new Error(`Update transcript failed: ${updateErr.message}`);
      console.log("INGEST_BG transcript saved");
    }

    // Background functions can return, but we only do it ONCE at the end
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        id: guid,
        note: "Background job finished (stage 1 transcript).",
      }),
    };
  } catch (e: any) {
    console.log("INGEST_BG error", e?.message || e);

    // If we created a row but errored, leave a clue in transcript field
    // (best effort; do not throw if this fails)
    try {
      if (supabaseAdmin && guid) {
        await supabaseAdmin
          .from("episodes")
          .update({ transcript: `__ERROR__: ${String(e?.message || e).slice(0, 500)}` })
          .eq("id", guid);
      }
    } catch {
      // ignore
    }

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e?.message || "Unknown error" }),
    };
  }
};
