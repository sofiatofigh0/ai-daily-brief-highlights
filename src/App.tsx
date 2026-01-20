// src/App.tsx
import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { supabase } from "./lib/supabaseClient";
import Calendar from "./Calendar";

type Highlights = {
  one_sentence_summary: string;
  what_changed?: string;
  why_it_matters_now?: string;
  who_should_care?: string;
  top_takeaways: string[];
  stories: { headline: string; why_it_matters: string }[];
};

type EpisodeRow = {
  id: string;
  title: string;
  published_at: string;
  published_date: string; // YYYY-MM-DD
  highlights: Highlights | null;
};

export default function App() {
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  async function loadEpisodes() {
    setLoading(true);
    setError("");

    const { data, error } = await supabase
      .from("episodes")
      .select("id,title,published_at,published_date,highlights")
      .order("published_at", { ascending: false });

    if (error) {
      setLoading(false);
      setError(error.message);
      return;
    }

    const rows = (data ?? []) as EpisodeRow[];
    setEpisodes(rows);

    if (rows.length > 0) {
      const latestDate = rows[0]?.published_date;
      if (!selectedDate && latestDate) setSelectedDate(latestDate);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadEpisodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dateOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of episodes) {
      if (e.published_date) set.add(e.published_date);
    }
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [episodes]);

  const selectedEpisode = useMemo(() => {
    if (!episodes.length) return null;

    const date = selectedDate || episodes[0].published_date;
    const matches = episodes.filter((e) => e.published_date === date);

    if (matches.length > 0) return matches[0];
    return episodes[0];
  }, [episodes, selectedDate]);

  const hasNewFormat = (h: Highlights) =>
    Boolean(h.what_changed?.trim() || h.why_it_matters_now?.trim() || h.who_should_care?.trim());

  return (
    <div className="page">
      <div className="container">
        <h1 className="title">AI Daily Brief Highlights</h1>
        <p className="subtitle">Latest by default. Select a date to view past highlights.</p>

        <div className="controls">
          <Calendar
            availableDates={dateOptions}
            selectedDate={selectedDate}
            onDateSelect={setSelectedDate}
            disabled={loading}
          />

          <button className="refresh-button" onClick={loadEpisodes} disabled={loading}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8C2 4.68629 4.68629 2 8 2C9.84566 2 11.4922 2.85839 12.5715 4.20991"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M14 4L12 6L10 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Refresh
          </button>
        </div>

        {loading && <div className="card">Loading…</div>}

        {!loading && error && (
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Error</div>
            <div style={{ opacity: 0.85 }}>{error}</div>
          </div>
        )}

        {!loading && !error && !selectedEpisode && (
          <div className="card">
            <div style={{ opacity: 0.85 }}>No episodes found.</div>
          </div>
        )}

        {!loading && !error && selectedEpisode && (
          <div className="card">
            <div className="episodeHeader">
              <div className="episodeTitle">{selectedEpisode.title}</div>
              <div className="episodeMeta">
                <span>{selectedEpisode.published_date}</span>
                <span style={{ opacity: 0.6 }}>•</span>
                <span style={{ opacity: 0.8 }}>{new Date(selectedEpisode.published_at).toLocaleString()}</span>
              </div>
            </div>

            {!selectedEpisode.highlights ? (
              <div className="processing">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Highlights are processing…</div>
                <div style={{ opacity: 0.8, marginBottom: 12 }}>
                  We have the episode metadata, but highlights haven’t been generated yet for this date.
                </div>
                <div style={{ opacity: 0.7 }}>Try Refresh in a minute.</div>
              </div>
            ) : (
              <div className="highlights">
                <div className="summary">
                  <div className="sectionTitle">One-sentence summary</div>
                  <div style={{ opacity: 0.9 }}>{selectedEpisode.highlights.one_sentence_summary}</div>
                </div>

                {hasNewFormat(selectedEpisode.highlights) ? (
                  <div className="section">
                    <div className="sectionTitle">What changed</div>
                    <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>
                      {selectedEpisode.highlights.what_changed || "—"}
                    </div>

                    <div className="sectionTitle" style={{ marginTop: 16 }}>
                      Why it matters now
                    </div>
                    <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>
                      {selectedEpisode.highlights.why_it_matters_now || "—"}
                    </div>

                    <div className="sectionTitle" style={{ marginTop: 16 }}>
                      Who should care
                    </div>
                    <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>
                      {selectedEpisode.highlights.who_should_care || "—"}
                    </div>
                  </div>
                ) : null}

                <div className="section">
                  <div className="sectionTitle">Top takeaways</div>
                  <ul>
                    {(selectedEpisode.highlights.top_takeaways ?? []).map((t, idx) => (
                      <li key={idx}>{t}</li>
                    ))}
                  </ul>
                </div>

                <div className="section">
                  <div className="sectionTitle">Stories</div>
                  <div className="stories">
                    {(selectedEpisode.highlights.stories ?? []).map((s, idx) => (
                      <div key={idx} className="story">
                        <div className="storyHeadline">{s.headline}</div>
                        <div className="storyWhy">{s.why_it_matters}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {!hasNewFormat(selectedEpisode.highlights) ? (
                  <div style={{ opacity: 0.6, marginTop: 12 }}>
                    Note: this episode uses the older highlights format. Newer episodes will include “What changed / Why it
                    matters now / Who should care.”
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
