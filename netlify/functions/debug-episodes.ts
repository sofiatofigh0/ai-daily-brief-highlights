import type { Handler } from "@netlify/functions";
import { supabaseAdmin } from "./_supabase";

function isRealTranscript(t: any): boolean {
  if (!t || typeof t !== "string") return false;
  if (t === "__PROCESSING_TRANSCRIPT__") return false;
  if (t.startsWith("__ERROR__")) return false;
  return t.length > 2000;
}

function isEmptyObject(v: any): boolean {
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

function isEmptySources(v: any): boolean {
  return v == null || (Array.isArray(v) && v.length === 0);
}

export const handler: Handler = async () => {
  try {
    if (!supabaseAdmin) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }) };
    }

    const { data: rows, error } = await supabaseAdmin
      .from("episodes")
      .select("id, title, published_at, published_date, transcript, highlights, sources, highlights_error")
      .order("published_at", { ascending: false })
      .limit(30);

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    const episodes = (rows || []).map((r: any) => {
      const transcriptStatus = !r.transcript
        ? "missing"
        : r.transcript === "__PROCESSING_TRANSCRIPT__"
        ? "processing"
        : r.transcript.startsWith("__ERROR__")
        ? `error: ${r.transcript.slice(0, 100)}`
        : `ok (${r.transcript.length} chars)`;

      const highlightsStatus = r.highlights == null || isEmptyObject(r.highlights)
        ? "missing"
        : "ok";

      const sourcesStatus = isEmptySources(r.sources)
        ? "missing"
        : `ok (${r.sources.length} sources)`;

      return {
        id: r.id?.slice(0, 50),
        title: r.title?.slice(0, 60),
        published_date: r.published_date,
        transcript: transcriptStatus,
        highlights: highlightsStatus,
        sources: sourcesStatus,
        error: r.highlights_error?.slice(0, 100) || null,
      };
    });

    // Summary stats
    const stats = {
      total: episodes.length,
      transcript_missing: episodes.filter((e: any) => e.transcript === "missing").length,
      transcript_processing: episodes.filter((e: any) => e.transcript === "processing").length,
      transcript_error: episodes.filter((e: any) => e.transcript.startsWith("error")).length,
      transcript_ok: episodes.filter((e: any) => e.transcript.startsWith("ok")).length,
      highlights_missing: episodes.filter((e: any) => e.highlights === "missing").length,
      highlights_ok: episodes.filter((e: any) => e.highlights === "ok").length,
      sources_missing: episodes.filter((e: any) => e.sources === "missing").length,
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stats, episodes }, null, 2),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
