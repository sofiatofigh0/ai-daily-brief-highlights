import type { Handler, HandlerEvent } from "@netlify/functions";
import { supabaseAdmin } from "./_supabase";
import { XMLParser } from "fast-xml-parser";

/* -------------------- config -------------------- */

const MAX_BACKFILL_DEPTH = 10; // Max self-chain iterations to prevent runaway
const EPISODES_PER_RUN = 2;   // How many transcriptions per run
const RSS_ITEMS_TO_INGEST = 15; // Fetch more RSS items to catch missed days

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

    // Guardrail: don’t run forever on very long audio
    if (part > 30) {
      console.log("INGEST_BG reached chunk cap (30). Stopping early.");
      break;
    }
  }

  return transcript.trim();
}

function isRealTranscript(t: any): boolean {
  if (!t || typeof t !== "string") return false;
  if (t === "__PROCESSING_TRANSCRIPT__") return false;
  if (t.startsWith("__ERROR__")) return false;
  return t.length > 2000;
}

/* -------------------- handler -------------------- */

export const handler: Handler = async (event: HandlerEvent) => {
  // Parse depth from query params (for backfill chaining)
  const depth = parseInt(event.queryStringParameters?.depth || "0", 10);
  const resetStuck = event.queryStringParameters?.reset_stuck === "true";

  try {
    console.log(`INGEST_BG start (depth=${depth}, reset_stuck=${resetStuck}, transcribe up to ${EPISODES_PER_RUN} missing)`);

    if (!supabaseAdmin) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    // Always reset __PROCESSING_TRANSCRIPT__ episodes (if we're starting a new run, old process died)
    // Only reset __ERROR__ episodes when reset_stuck=true (manual retry)
    if (depth === 0) {
      // Always clear processing markers - they indicate a dead process
      const { data: processingRows } = await supabaseAdmin
        .from("episodes")
        .select("id")
        .eq("transcript", "__PROCESSING_TRANSCRIPT__")
        .limit(50);

      if (processingRows && processingRows.length > 0) {
        const processingIds = processingRows.map((r: any) => r.id);
        console.log(`INGEST_BG clearing ${processingIds.length} stale processing markers`, processingIds);
        await supabaseAdmin
          .from("episodes")
          .update({ transcript: null })
          .in("id", processingIds);
      }

      // Only reset error states when explicitly requested
      if (resetStuck) {
        const { data: errorRows } = await supabaseAdmin
          .from("episodes")
          .select("id")
          .like("transcript", "__ERROR__%")
          .limit(50);

        if (errorRows && errorRows.length > 0) {
          const errorIds = errorRows.map((r: any) => r.id);
          console.log(`INGEST_BG resetting ${errorIds.length} error episodes`, errorIds);
          await supabaseAdmin
            .from("episodes")
            .update({ transcript: null })
            .in("id", errorIds);
        }
      }
    }

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

    const itemsToIngest = list.slice(0, RSS_ITEMS_TO_INGEST);
    console.log(`INGEST_BG RSS total=${list.length}, ingesting=${itemsToIngest.length}`);

    // 2) Upsert latest 7 rows (no transcript/highlights required)
    const cleanedRows: any[] = [];

    for (const item of itemsToIngest) {
      const title = item?.title ?? "AI Daily Brief";
      const pubDate = item?.pubDate;
      const id = getGuid(item) || `${title}-${pubDate}`;
      const audioUrl = getEnclosureUrl(item);

      if (!pubDate || !audioUrl || !id) {
        console.log("INGEST_BG skipping item missing fields", {
          hasPubDate: !!pubDate,
          hasAudio: !!audioUrl,
          hasId: !!id,
        });
        continue;
      }

      cleanedRows.push({
        id,
        title,
        published_at: new Date(pubDate).toISOString(),
        published_date: toYYYYMMDD_ET(pubDate),
        audio_url: audioUrl,
      });
    }

    if (!cleanedRows.length) throw new Error("No valid RSS rows to upsert");

    const { error: upsertErr } = await supabaseAdmin
      .from("episodes")
      .upsert(cleanedRows, { onConflict: "id" });

    if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);

    console.log("INGEST_BG upserted rows", { count: cleanedRows.length });

    // 3) Transcribe episodes missing a real transcript
    // Query ALL recent episodes from database (not just ones we upserted)
    // This ensures we catch any missed days from previous failed runs
    const { data: rows, error: fetchErr } = await supabaseAdmin
      .from("episodes")
      .select("id, title, audio_url, transcript, published_at")
      .order("published_at", { ascending: false })
      .limit(30); // Check last 30 episodes for missing transcripts

    if (fetchErr) throw new Error(`Fetch episodes failed: ${fetchErr.message}`);

    const candidates = (rows || []).filter((r: any) => !isRealTranscript(r.transcript));
    const toProcess = candidates.slice(0, EPISODES_PER_RUN);

    console.log("INGEST_BG transcript candidates", {
      total_candidates: candidates.length,
      processing_now: toProcess.map((r: any) => r.id),
    });

    for (const row of toProcess) {
      const id = row.id as string;
      const audioUrl = row.audio_url as string | null;

      if (!audioUrl) {
        console.log("INGEST_BG skipping missing audio_url", { id });
        continue;
      }

      // Mark processing (so you see activity in Supabase immediately)
      const { error: markErr } = await supabaseAdmin
        .from("episodes")
        .update({ transcript: "__PROCESSING_TRANSCRIPT__" })
        .eq("id", id);

      if (markErr) {
        console.log("INGEST_BG failed to mark processing", { id, err: markErr.message });
        // keep going to next
        continue;
      }

      try {
        console.log("INGEST_BG transcribing", { id, title: row.title });

        const transcript = await transcribeInChunks(openaiKey, audioUrl);

        const { error: saveErr } = await supabaseAdmin
          .from("episodes")
          .update({ transcript })
          .eq("id", id);

        if (saveErr) throw new Error(saveErr.message);

        console.log("INGEST_BG transcript saved", { id, chars: transcript.length });
      } catch (err: any) {
        const msg = String(err?.message || err).slice(0, 500);
        console.log("INGEST_BG transcription failed", { id, msg });

        await supabaseAdmin
          .from("episodes")
          .update({ transcript: `__ERROR__: ${msg}` })
          .eq("id", id);
      }
    }

    // Check if there are more unprocessed episodes (backfill needed)
    const remainingCandidates = candidates.length - toProcess.length;
    let chainTriggered = false;

    if (remainingCandidates > 0 && depth < MAX_BACKFILL_DEPTH) {
      // Trigger another run to continue backfill
      const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
      if (base) {
        const nextDepth = depth + 1;
        const nextUrl = `${base}/.netlify/functions/ingest-episodes-background?depth=${nextDepth}`;
        console.log(`INGEST_BG triggering backfill chain (depth=${nextDepth}, remaining=${remainingCandidates})`);

        // Fire-and-forget next run
        fetch(nextUrl).catch((e) =>
          console.log("INGEST_BG chain trigger failed", e?.message || e)
        );
        chainTriggered = true;
      }
    } else if (remainingCandidates > 0) {
      console.log(`INGEST_BG backfill max depth reached (${MAX_BACKFILL_DEPTH}), ${remainingCandidates} episodes still pending`);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        depth,
        ingested_count: cleanedRows.length,
        transcribed_this_run: toProcess.length,
        remaining_candidates: remainingCandidates,
        chain_triggered: chainTriggered,
      }),
    };
  } catch (e: any) {
    console.log("INGEST_BG error", e?.message || e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e?.message || "Unknown error" }),
    };
  }
};
