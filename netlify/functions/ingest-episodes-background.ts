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

async function downloadAudioAsArrayBuffer(audioUrl: string) {
  const res = await fetch(audioUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Audio download failed: ${res.status}`);
  return await res.arrayBuffer();
}

async function transcribeInChunks(openaiKey: string, audioUrl: string): Promise<string> {
  const buffer = await downloadAudioAsArrayBuffer(audioUrl);

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

    // Guardrail: avoid runaway invocation on extremely long audio
    if (part > 30) {
      console.log("INGEST_BG reached chunk cap (30). Stopping early.");
      break;
    }
  }

  return transcript.trim();
}

/* -------------------- handler -------------------- */

export const handler: Handler = async () => {
  let newestGuid: string | null = null;

  try {
    console.log("INGEST_BG start (backfill 7, transcribe newest only)");

    if (!supabaseAdmin) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    // 1) Fetch RSS
    const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) throw new Error(`RSS fetch failed: ${rssRes.status}`);
    const xml = await rssRes.text();

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);

    const items = parsed?.rss?.channel?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];
    if (!list.length) throw new Error("No RSS items found");

    const itemsToIngest = list.slice(0, 7);
    console.log(`INGEST_BG found ${list.length} RSS items, ingesting ${itemsToIngest.length}`);

    // 2) Upsert the latest 7 rows (fast, no transcription yet)
    for (let i = 0; i < itemsToIngest.length; i++) {
      const item = itemsToIngest[i];
      const title = item?.title ?? "AI Daily Brief";
      const pubDate = item?.pubDate;
      const guid = getGuid(item) || `${title}-${pubDate}`;
      const audioUrl = getEnclosureUrl(item);

      if (!pubDate || !audioUrl || !guid) {
        console.log("INGEST_BG skipping item missing fields", { hasPubDate: !!pubDate, hasAudio: !!audioUrl, hasGuid: !!guid });
        continue;
      }

      const published_at = new Date(pubDate).toISOString();
      const published_date = toYYYYMMDD_ET(pubDate);

      if (i === 0) newestGuid = guid;

      const { error: upsertErr } = await supabaseAdmin.from("episodes").upsert(
        [
          {
            id: guid,
            title,
            published_at,
            published_date,
            audio_url: audioUrl,
            // only set processing marker for newest if transcript isn't present yet
            ...(i === 0 ? { transcript: "__PROCESSING_TRANSCRIPT__" } : {}),
          },
        ],
        { onConflict: "id" }
      );

      if (upsertErr) throw new Error(`Upsert failed for ${guid}: ${upsertErr.message}`);
    }

    console.log("INGEST_BG upserted backfill rows", { newestGuid });

    // 3) Transcribe newest ONLY (keeps runtime safe)
    if (!newestGuid) throw new Error("Could not determine newestGuid");

    const { data: newestRow, error: newestErr } = await supabaseAdmin
      .from("episodes")
      .select("id, title, audio_url, transcript, published_at, published_date")
      .eq("id", newestGuid)
      .maybeSingle();

    if (newestErr) throw new Error(`Failed reading newest row: ${newestErr.message}`);
    if (!newestRow?.audio_url) throw new Error("Newest row missing audio_url");

    const existingTranscript = (newestRow as any)?.transcript as string | null | undefined;
    const hasRealTranscript =
      !!existingTranscript &&
      existingTranscript !== "__PROCESSING_TRANSCRIPT__" &&
      !existingTranscript.startsWith("__ERROR__") &&
      existingTranscript.length > 2000;

    if (hasRealTranscript) {
      console.log("INGEST_BG newest already has transcript, skipping transcription");
    } else {
      console.log("INGEST_BG transcribing newest", { newestGuid });

      const transcript = await transcribeInChunks(openaiKey, newestRow.audio_url as string);

      const { error: updateErr } = await supabaseAdmin
        .from("episodes")
        .update({
          transcript,
        })
        .eq("id", newestGuid);

      if (updateErr) throw new Error(`Update transcript failed: ${updateErr.message}`);

      console.log("INGEST_BG transcript saved", { newestGuid, chars: transcript.length });
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        newestGuid,
        ingested_count: itemsToIngest.length,
        note: "Backfilled latest 7 episodes; transcribed newest only (stage 1).",
      }),
    };
  } catch (e: any) {
    console.log("INGEST_BG error", e?.message || e);

    // Best-effort: mark newest row with error
    try {
      if (supabaseAdmin && newestGuid) {
        await supabaseAdmin
          .from("episodes")
          .update({ transcript: `__ERROR__: ${String(e?.message || e).slice(0, 500)}` })
          .eq("id", newestGuid);
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
