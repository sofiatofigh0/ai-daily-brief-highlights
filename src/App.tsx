import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { supabase } from "./lib/supabaseClient";

type Source = {
  title: string;
  url: string;
  snippet?: string;
};

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
  sources?: Source[] | null;
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
      .select("id,title,published_at,published_date,highlights,sources")
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
    return matches.length > 0 ? matches[0] : episodes[0];
  }, [episodes, selectedDate]);

  const hasNewFormat = (h: Highlights) =>
    Boolean(h.what_changed || h.why_it_matters_now || h.who_should_care);

  return (
    <div className="page">
      <div className="container">
        <h1 className="title">AI Daily Brief Highlights</h1>
        <p className="subtitle">Latest by default. Select a date to view past highlights.</p>

        <div className="controls">
          <label className="label" htmlFor="dateSelect">
            Date
          </label>

          <select
            id="dateSelect"
            className="select"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            disabled={loading || dateOptions.length === 0}
          >
            {dateOptions.length === 0 ? (
              <option value="">No episodes yet</option>
            ) : (
              dateOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))
            )}
          </select>

          <button className="button" onClick={loadEpisodes} disabled={loading}>
            Refresh
          </button>
        </div>

        {loading && <div className="card">Loading…</div>}

        {!loading && error && (
          <div className="card">
            <strong>Error</strong>
            <div>{error}</div>
          </div>
        )}

        {!loading && !error && !selectedEpisode && (
          <div className="card">No episodes found.</div>
        )}

        {!loading && !error && selectedEpisode && (
          <div className="card">
            <div className="episodeHeader">
              <div className="episodeTitle">{selectedEpisode.title}</div>
              <div className="episodeMeta">
                <span>{selectedEpisode.published_date}</span>
                <span>•</span>
                <span>{new Date(selectedEpisode.published_at).toLocaleString()}</span>
              </div>
            </div>

            {!selectedEpisode.highlights ? (
              <div className="processing">
                <strong>Highlights are processing…</strong>
                <div>Transcript is ready, summary coming shortly.</div>
              </div>
            ) : (
              <div className="highlights">
                <div className="summary">
                  <div className="sectionTitle">One-sentence summary</div>
                  <div>{selectedEpisode.highlights.one_sentence_summary}</div>
                </div>

                {hasNewFormat(selectedEpisode.highlights) && (
                  <div className="section">
                    <div className="sectionTitle">What changed</div>
                    <div>{selectedEpisode.highlights.what_changed}</div>

                    <div className="sectionTitle">Why it matters now</div>
                    <div>{selectedEpisode.highlights.why_it_matters_now}</div>

                    <div className="sectionTitle">Who should care</div>
                    <div>{selectedEpisode.highlights.who_should_care}</div>
                  </div>
                )}

                <div className="section">
                  <div className="sectionTitle">Top takeaways</div>
                  <ul>
                    {selectedEpisode.highlights.top_takeaways.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>

                <div className="section">
                  <div className="sectionTitle">Stories</div>
                  {selectedEpisode.highlights.stories.map((s, i) => (
                    <div key={i} className="story">
                      <div className="storyHeadline">{s.headline}</div>
                      <div>{s.why_it_matters}</div>
                    </div>
                  ))}
                </div>

                {selectedEpisode.sources?.length ? (
                  <div className="section">
                    <div className="sectionTitle">Sources</div>
                    <ul>
                      {selectedEpisode.sources.map((src, i) => (
                        <li key={i}>
                          <a href={src.url} target="_blank" rel="noreferrer">
                            {src.title}
                          </a>
                        </li>
                      ))}
                    </ul>
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
