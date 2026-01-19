import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";

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

export const handler: Handler = async () => {
  try {
    const url = process.env.SUPABASE_URL;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url) return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_URL" }) };
    if (!service) return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }) };

    const supabase = createClient(url, service, { auth: { persistSession: false } });

    const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) return { statusCode: 500, body: JSON.stringify({ error: `RSS fetch failed: ${rssRes.status}` }) };

    const xml = await rssRes.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];

    const itemsToIngest = list.slice(0, 7);

    const rows = itemsToIngest.map((item: any) => {
      const title = item?.title ?? "AI Daily Brief";
      const pubDate = item?.pubDate;
      const id = getGuid(item) || `${title}-${pubDate}`;
      const audioUrl = getEnclosureUrl(item);
      const published_at = pubDate ? new Date(pubDate).toISOString() : null;
      const published_date = pubDate ? toYYYYMMDD_ET(pubDate) : null;

      return {
        id,
        title,
        published_at,
        published_date,
        audio_url: audioUrl,
        // DO NOT include transcript/highlights here to avoid schema mismatch
      };
    });

    // Quick validation: drop any incomplete rows
    const cleaned = rows.filter((r) => r.id && r.published_at && r.published_date && r.audio_url);

    const { error: upsertErr } = await supabase
      .from("episodes")
      .upsert(cleaned, { onConflict: "id" });

    if (upsertErr) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Upsert failed",
          details: upsertErr,
          sample_row: cleaned[0] ?? null,
        }),
      };
    }

    const { count } = await supabase
      .from("episodes")
      .select("*", { count: "exact", head: true });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        {
          ok: true,
          ingested: cleaned.length,
          ids: cleaned.map((r) => r.id),
          total_rows_now: count,
        },
        null,
        2
      ),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
