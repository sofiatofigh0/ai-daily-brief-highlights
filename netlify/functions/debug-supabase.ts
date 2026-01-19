import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

export const handler: Handler = async () => {
  try {
    const url = process.env.SUPABASE_URL;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url) return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_URL" }) };
    if (!service) return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }) };

    const supabase = createClient(url, service, { auth: { persistSession: false } });

    // Count rows
    const { count, error: countErr } = await supabase
      .from("episodes")
      .select("*", { count: "exact", head: true });

    if (countErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "Count failed", details: countErr }) };
    }

    // Force a brand-new row (proves you’ll see row count increase)
    const id = `debug-${Date.now()}`;
    const { error: insertErr } = await supabase.from("episodes").insert([
      {
        id,
        title: "DEBUG ROW",
        published_at: new Date().toISOString(),
        published_date: new Date().toISOString().slice(0, 10),
        audio_url: null,
        transcript: "debug write ok",
        highlights: { one_sentence_summary: "debug", top_takeaways: ["a", "b", "c"], stories: [{ headline: "debug", why_it_matters: "debug" }] },
      },
    ]);

    if (insertErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "Insert failed", details: insertErr }) };
    }

    // Re-count after insert
    const { count: count2, error: count2Err } = await supabase
      .from("episodes")
      .select("*", { count: "exact", head: true });

    if (count2Err) {
      return { statusCode: 500, body: JSON.stringify({ error: "Recount failed", details: count2Err }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        supabase_url_prefix: url.slice(0, 35),
        before_count: count,
        after_count: count2,
        inserted_id: id,
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
