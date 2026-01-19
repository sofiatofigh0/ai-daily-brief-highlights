import type { Handler } from "@netlify/functions";
import { supabaseAdmin } from "./_supabase";
import { XMLParser } from "fast-xml-parser";

function toYYYYMMDD_ET(dateStr: string): string {
  // Convert RSS pubDate to America/New_York date string
  const d = new Date(dateStr);
  // Use Intl.DateTimeFormat to format in ET without extra deps
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // en-CA => YYYY-MM-DD
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
  if (!supabaseAdmin) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }),
    };
  }

  const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";

  const res = await fetch(rssUrl);
  if (!res.ok) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `RSS fetch failed: ${res.status}` }),
    };
  }

  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

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

  // RSS is typically newest-first; take the first item
  const newest = list[0];
  const title = newest?.title ?? "AI Daily Brief";
  const pubDate = newest?.pubDate;
  const guid = getGuid(newest) || `${title}-${pubDate}`;
  const audioUrl = getEnclosureUrl(newest);

  if (!pubDate) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Newest RSS item missing pubDate" }),
    };
  }

  const published_at = new Date(pubDate).toISOString();
  const published_date = toYYYYMMDD_ET(pubDate);

  // Check if we already have it
  const { data: existing, error: existErr } = await supabaseAdmin
    .from("episodes")
    .select("id")
    .eq("id", guid)
    .maybeSingle();

  if (existErr) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `DB check failed: ${existErr.message}` }),
    };
  }

  if (existing?.id) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "noop",
        message: "Latest episode already ingested",
        id: existing.id,
        published_date,
        title,
      }),
    };
  }

  // Placeholder highlights (v1). We’ll replace with transcription+LLM next.
  const highlights = {
    one_sentence_summary:
      "New episode detected. Highlights generation coming next (transcription + LLM).",
    top_takeaways: [
      "Episode ingested via RSS polling.",
      "Next step: transcribe audio and synthesize highlights with an LLM.",
      "UI can already browse by date once highlights are stored.",
    ],
    stories: [
      {
        headline: "Auto-ingest pipeline is live",
        why_it_matters:
          "This proves end-to-end orchestration: ingestion → persistence → UI rendering.",
      },
    ],
    action_items: ["Enable transcription + summarization in the ingest job."],
  };

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
    body: JSON.stringify({
      status: "inserted",
      id: guid,
      published_date,
      title,
      audio_url: audioUrl,
    }),
  };
};
