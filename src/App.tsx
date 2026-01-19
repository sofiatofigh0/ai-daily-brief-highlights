import { useEffect, useMemo, useState } from "react";
import "./App.css";

type Highlights = {
  one_sentence_summary: string;
  top_takeaways: string[];
  stories: { headline: string; why_it_matters: string }[];
  action_items?: string[];
};

type EpisodeRow = {
  id: string;
  title: string;
  published_date: string; // YYYY-MM-DD
  highlights: Highlights;
};

export default function App() {
  const [loading, setLoading] = useState(true);
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [episode, setEpisode] = useState<EpisodeRow | null>(null);
  const [error, setError] = useState<string>("");

  const apiBase = useMemo(() => "", []);

  async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${apiBase}${path}`);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError("");

        // 1) Load available dates
        const datesResp = await fetchJson<{ dates: string[] }>(
          "/.netlify/functions/dates"
        );
        setDates(datesResp.dates || []);

        // 2) Load latest episode
        const latest = await fetchJson<EpisodeRow>(
          "/.netlify/functions/latest"
        );
        setEpisode(latest);
        setSelectedDate(latest?.published_date || "");
      } catch (e: any) {
        setError(e?.message || "Something went wrong");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onChangeDate(date: string) {
    try {
      setSelectedDate(date);
      setLoading(true);
      setError("");

      const data = await fetchJson<EpisodeRow>(
        `/.netlify/functions/episode?date=${encodeURIComponent(date)}`
      );
      setEpisode(data);
    } catch (e: any) {
      setError(e?.message || "Failed to load that date");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <h1 style={{ marginBottom: 6 }}>AI Daily Brief Highlights</h1>
      <p style={{ marginTop: 0, opacity: 0.75 }}>
        Latest by default. Select a date to view past highlights.
      </p>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          margin: "16px 0 24px",
          flexWrap: "wrap",
        }}
      >
        <label style={{ fontWeight: 600 }}>Date</label>
        <select
          value={selectedDate}
          onChange={(e) => onChangeDate(e.target.value)}
          disabled={!dates.length}
          style={{ padding: "8px 10px", borderRadius: 8 }}
        >
          {dates.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        {episode?.published_date && (
          <span
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.2)",
              fontSize: 12,
              opacity: 0.9,
            }}
          >
            Showing: {episode.published_date}
          </span>
        )}
      </div>

      {loading && <p>Loading…</p>}

      {error && (
        <pre
          style={{
            background: "rgba(255,0,0,0.08)",
            padding: 12,
            borderRadius: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </pre>
      )}

      {!loading && !error && episode && (
        <div style={{ display: "grid", gap: 18 }}>
          <div
            style={{
              padding: 16,
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.15)",
            }}
          >
            <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 6 }}>
              {episode.title}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              {episode.highlights.one_sentence_summary}
            </div>
          </div>

          <section>
            <h2 style={{ marginBottom: 8 }}>Top takeaways</h2>
            <ul>
              {episode.highlights.top_takeaways.map((t, idx) => (
                <li key={idx} style={{ marginBottom: 6 }}>
                  {t}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 style={{ marginBottom: 8 }}>Stories</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {episode.highlights.stories.map((s, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: 14,
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{s.headline}</div>
                  <div style={{ opacity: 0.85, marginTop: 6 }}>
                    {s.why_it_matters}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {episode.highlights.action_items?.length ? (
            <section>
              <h2 style={{ marginBottom: 8 }}>Action items</h2>
              <ul>
                {episode.highlights.action_items.map((a, idx) => (
                  <li key={idx} style={{ marginBottom: 6 }}>
                    {a}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
