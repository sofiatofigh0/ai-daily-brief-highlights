import type { Handler } from "@netlify/functions";
import { XMLParser } from "fast-xml-parser";

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
    const rssUrl = "https://anchor.fm/s/f7cac464/podcast/rss";
    const rssRes = await fetch(rssUrl);
    if (!rssRes.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: `RSS fetch failed: ${rssRes.status}` }) };
    }

    const xml = await rssRes.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);

    const items = parsed?.rss?.channel?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];

    const sample = list.slice(0, 10).map((it: any, idx: number) => {
      const title = it?.title ?? null;
      const pubDate = it?.pubDate ?? null;
      const guid = getGuid(it) || null;
      const audioUrl = getEnclosureUrl(it);
      return {
        idx,
        title,
        pubDate,
        guid,
        hasAudio: !!audioUrl,
        audioUrlPrefix: audioUrl ? String(audioUrl).slice(0, 60) : null,
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        {
          total_items: list.length,
          sample_count: sample.length,
          sample,
        },
        null,
        2
      ),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "Unknown error" }) };
  }
};
