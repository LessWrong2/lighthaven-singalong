"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { useLyrics } from "@/lib/useLyrics";
import { fmt } from "@/lib/format";
import { APP_NAME, CANONICAL_ID } from "@/lib/config";
import { extractVideoId, useYouTubePlayer } from "@/lib/youtube";
import type { LyricsSearchResult, QueueItem, SongMode } from "@/lib/types";

/** Format seconds as h:mm:ss (drops the hour part when zero). */
function fmtLong(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function badge(r: LyricsSearchResult): { label: string; cls: string } {
  if (r.instrumental) return { label: "instrumental", cls: "badge badge-plain" };
  if (r.hasSynced) return { label: "synced", cls: "badge badge-synced" };
  if (r.hasPlain) return { label: "plain", cls: "badge badge-plain" };
  return { label: "no lyrics", cls: "badge badge-plain" };
}

/** Song search against LRCLIB (via our proxy). */
function SearchPanel({ onAdd }: { onAdd: (item: QueueItem) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LyricsSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lyrics/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { results: LyricsSearchResult[] };
      setResults(body.results);
    } catch {
      setError("Search failed — check the connection and try again.");
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  function add(r: LyricsSearchResult) {
    onAdd({
      uid: crypto.randomUUID(),
      title: r.title,
      artist: r.artist,
      album: r.album || undefined,
      durationSec: r.durationSec || undefined,
      lrclibId: r.lrclibId,
      hasSynced: r.hasSynced,
      // Playback needs a YouTube video attached before it can actually run;
      // band mode is the safe default for a live-band event.
      defaultMode: "band",
    });
  }

  return (
    <div className="card search-panel" style={{ marginTop: "1rem" }}>
      <form className="cluster" onSubmit={search} style={{ flexWrap: "nowrap" }}>
        <input
          type="text"
          placeholder="Search any song — title and artist…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          aria-label="Song search"
        />
        <button className="primary" type="submit" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="muted" style={{ marginBottom: 0 }}>{error}</p>}
      {results && results.length === 0 && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Nothing found. Try “title artist” with fewer words.
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="search-results">
          {results.map((r) => {
            const b = badge(r);
            return (
              <li key={r.lrclibId} className="result-row">
                <span className="title" title={`${r.title} — ${r.artist}`}>
                  {r.title} <span className="muted">— {r.artist}</span>
                  {r.album ? <span className="muted"> · {r.album}</span> : null}
                </span>
                <span className={b.cls}>{b.label}</span>
                <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {r.durationSec ? fmt(r.durationSec) : ""}
                </span>
                <button onClick={() => add(r)}>Add</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Paste-a-YouTube-link field for one queue row. */
function YtField({
  item,
  onSet,
}: {
  item: QueueItem;
  onSet: (videoId: string | undefined) => void;
}) {
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);

  if (item.youtubeVideoId) {
    return (
      <span className="cluster" style={{ gap: "0.3rem" }}>
        <span className="badge badge-synced" title={`Video: ${item.youtubeVideoId}`}>
          ✓ video
        </span>
        <button className="ghost" title="Remove video" onClick={() => onSet(undefined)}>
          ✕
        </button>
      </span>
    );
  }

  function commit() {
    const id = extractVideoId(draft);
    if (id) {
      setDraft("");
      setBad(false);
      onSet(id);
    } else {
      setBad(draft.trim().length > 0);
    }
  }

  return (
    <span className="cluster" style={{ gap: "0.3rem", flexWrap: "nowrap" }}>
      <input
        type="text"
        className={`yt-input ${bad ? "bad" : ""}`}
        placeholder="Paste YouTube link"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setBad(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <a
        className="pill"
        href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
          `${item.title} ${item.artist}`,
        )}`}
        target="_blank"
        rel="noreferrer"
        title="Search YouTube for this song in a new tab, then paste the link here"
      >
        YT ↗
      </a>
    </span>
  );
}

function ControllerInner({ sessionId: propSessionId }: { sessionId?: string }) {
  const params = useSearchParams();
  // Prop wins, then an explicit ?s= code, else the canonical session.
  const sessionId = propSessionId ?? params.get("s") ?? CANONICAL_ID;
  const isCanonical = sessionId.toUpperCase() === CANONICAL_ID;
  const { state, status, sendCommand } = useSession(sessionId);

  const [notFound, setNotFound] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  // Drag-and-drop reorder state.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Whether playback should continue across song changes (auto-advance).
  const wantPlayRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/session/${sessionId}/state`).then((r) => setNotFound(r.status === 404));
  }, [sessionId]);

  const playlist = state?.playlist ?? [];
  const idx = state?.currentIndex ?? 0;
  const currentItem = playlist[idx];
  const mode: SongMode = state?.mode ?? "band";

  const { status: lyStatus, doc } = useLyrics(currentItem);
  const lines = doc?.lines ?? [];

  // Refs so event handlers (keyboard, player events) never go stale.
  const stateRef = useRef(state);
  stateRef.current = state;
  const linesLenRef = useRef(0);
  linesLenRef.current = lines.length;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;
  const idxRef = useRef(idx);
  idxRef.current = idx;

  // ---- Playback mode: YouTube player feeds `sync` commands ----

  // Throttle: send immediately on play/pause or a seek-sized jump, else at
  // most every 3s (the original app's heartbeat cadence).
  const lastSentRef = useRef<{ atMs: number; positionSec: number; isPlaying: boolean } | null>(
    null,
  );
  const onTransport = useCallback(
    (t: { isPlaying: boolean; positionSec: number; durationSec: number }) => {
      if (modeRef.current !== "playback") return;
      const now = Date.now();
      const last = lastSentRef.current;
      let send = false;
      if (!last || last.isPlaying !== t.isPlaying) send = true;
      else if (now - last.atMs >= 3000) send = true;
      else {
        const expected = last.isPlaying
          ? last.positionSec + (now - last.atMs) / 1000
          : last.positionSec;
        if (Math.abs(t.positionSec - expected) > 0.75) send = true; // seek/stall
      }
      if (!send) return;
      lastSentRef.current = { atMs: now, positionSec: t.positionSec, isPlaying: t.isPlaying };
      sendCommand({
        type: "sync",
        isPlaying: t.isPlaying,
        positionSec: t.positionSec,
        durationSec: t.durationSec,
      });
    },
    [sendCommand],
  );

  const onEnded = useCallback(() => {
    const pl = playlistRef.current;
    const i = idxRef.current;
    if (i < pl.length - 1) {
      wantPlayRef.current = true;
      sendCommand({ type: "select", index: i + 1 });
    } else {
      wantPlayRef.current = false;
    }
  }, [sendCommand]);

  const player = useYouTubePlayer({
    videoId: currentItem?.youtubeVideoId ?? null,
    containerId: "yt-player",
    onTransport,
    onEnded,
    onError: (msg) => setYtError(msg),
    getAutoplay: () => wantPlayRef.current && modeRef.current === "playback",
  });

  // Clear stale player errors, the sync-throttle anchor, and the optimistic
  // line cursor when the song changes.
  const currentUid = currentItem?.uid;
  useEffect(() => {
    setYtError(null);
    lastSentRef.current = null;
    sentLineRef.current = null;
  }, [currentUid]);

  // ---- Band mode: line cursor ----

  // Optimistic cursor: rapid key presses must not wait for the server echo
  // (each SSE round-trip is ~50-150ms), so steps are based on the last index
  // we *sent*, reconciled to the server whenever it pushes a new value.
  const sentLineRef = useRef<number | null>(null);

  const setLine = useCallback(
    (index: number) => {
      const clamped = Math.max(-1, Math.min(linesLenRef.current - 1, index));
      sentLineRef.current = clamped;
      sendCommand({ type: "line", index: clamped });
    },
    [sendCommand],
  );

  const stepLine = useCallback(
    (delta: number) => {
      const s = stateRef.current;
      if (!s) return;
      const base = sentLineRef.current ?? s.lineIndex;
      setLine(base + delta);
    },
    [setLine],
  );

  // Keyboard: space/arrows drive the teleprompter (band mode only), unless a
  // text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modeRef.current !== "band") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        stepLine(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        stepLine(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setLine(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepLine, setLine]);

  // Keep the current band line visible in the controller's line list.
  const activeLineRef = useRef<HTMLLIElement>(null);
  const lineIndex = state?.lineIndex ?? -1;
  useEffect(() => {
    if (modeRef.current === "band")
      activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [lineIndex]);

  const goTo = useCallback(
    (target: number, andPlay = false) => {
      wantPlayRef.current = andPlay;
      sendCommand({ type: "select", index: target });
    },
    [sendCommand],
  );

  const setMode = useCallback(
    (m: SongMode) => {
      if (m === "band") player.pause();
      sendCommand({ type: "mode", mode: m });
    },
    [player, sendCommand],
  );

  // ---- Drag-and-drop reorder ----
  function onDragStart(i: number, e: React.DragEvent) {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = "move";
    // Firefox requires data to be set for the drag to initiate.
    e.dataTransfer.setData("text/plain", String(i));
  }
  function onDragOver(i: number, e: React.DragEvent) {
    if (dragIndex === null) return;
    e.preventDefault(); // allow drop
    e.dataTransfer.dropEffect = "move";
    if (i !== overIndex) setOverIndex(i);
  }
  function onDrop(i: number, e: React.DragEvent) {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== i) {
      sendCommand({ type: "reorder", from: dragIndex, to: i });
    }
    setDragIndex(null);
    setOverIndex(null);
  }
  function onDragEnd() {
    setDragIndex(null);
    setOverIndex(null);
  }

  if (notFound)
    return (
      <div className="wrap">
        <div className="card">
          Session <strong>{sessionId}</strong> not found.{" "}
          <a href="/dashboard">Back to the dashboard →</a>
        </div>
      </div>
    );
  if (!state) return <div className="wrap muted">Connecting…</div>;

  const displayHref = isCanonical ? "/" : `/display?s=${state.id}`;
  const knownTotal = playlist.reduce((acc, s) => acc + (s.durationSec ?? 0), 0);

  const playbackReady = Boolean(currentItem?.hasSynced && currentItem?.youtubeVideoId);
  const dur = state.durationSec;
  const pos = state.positionSec; // anchor; good enough for the host's readout
  const frac = dur > 0 ? Math.min(1, pos / dur) : 0;

  function seekFromEvent(e: React.MouseEvent) {
    const el = barRef.current;
    if (!el || !dur) return;
    const rect = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    player.seekTo(f * dur);
  }

  return (
    <div className="wrap">
      <div className="cluster" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 className="app">{APP_NAME} — Host</h1>
          <div className="muted">
            {isCanonical ? (
              <>Screens follow along at the main page (<code>/</code>).</>
            ) : (
              <>
                Session code:{" "}
                <strong style={{ letterSpacing: "0.15em", color: "var(--text)" }}>{state.id}</strong>
              </>
            )}
          </div>
        </div>
        <div className="cluster">
          <span className="pill">
            <span className={`dot ${status.connected ? "live" : ""}`} />
            {status.connected ? "Live" : "Reconnecting…"}
          </span>
          <a className="pill" href={displayHref} target="_blank" rel="noreferrer">
            Open lyrics screen ↗
          </a>
        </div>
      </div>

      <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
        Search a song, add it to the queue, hit Go. In <strong>band</strong> mode you advance
        the words by hand (Space / arrow keys) while the band plays. In{" "}
        <strong>playback</strong> mode this device plays the YouTube audio and the words follow
        it automatically.
      </p>

      <SearchPanel onAdd={(item) => sendCommand({ type: "add", item })} />

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="cluster" style={{ justifyContent: "space-between" }}>
          <strong>Queue ({playlist.length})</strong>
          <button
            className="ghost"
            onClick={() => {
              if (playlist.length === 0 || window.confirm("Clear the whole queue?"))
                sendCommand({ type: "reset" });
            }}
          >
            Clear queue
          </button>
        </div>
        {playlist.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Search for a song above to get started.
          </p>
        ) : (
          <>
            <ol className="playlist" style={{ marginTop: "0.75rem" }}>
              {playlist.map((song, i) => (
                <li
                  key={song.uid}
                  className={`track ${i === idx ? "current" : ""} ${
                    i === dragIndex ? "dragging" : ""
                  } ${i === overIndex && dragIndex !== null && i !== dragIndex ? "drag-over" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(i, e)}
                  onDragOver={(e) => onDragOver(i, e)}
                  onDrop={(e) => onDrop(i, e)}
                  onDragEnd={onDragEnd}
                >
                  <span className="handle" title="Drag to reorder" aria-hidden>
                    ⠿
                  </span>
                  <span className="idx">{i + 1}</span>
                  <span className="title" title={`${song.title} — ${song.artist}`}>
                    {song.title} <span className="muted">— {song.artist}</span>
                    {!song.hasSynced && (
                      <span className="badge badge-plain" style={{ marginLeft: "0.4rem" }}>
                        {song.lrclibId === null ? "no lyrics" : "plain"}
                      </span>
                    )}
                  </span>
                  <span className="controls">
                    <button
                      className="ghost mode-chip"
                      title={
                        song.defaultMode === "band"
                          ? "Band mode (manual advance) — click for playback"
                          : "Playback mode (YouTube audio) — click for band"
                      }
                      onClick={() =>
                        sendCommand({
                          type: "updateItem",
                          uid: song.uid,
                          patch: {
                            defaultMode: song.defaultMode === "band" ? "playback" : "band",
                          },
                        })
                      }
                    >
                      {song.defaultMode === "band" ? "🎤 band" : "▶ playback"}
                    </button>
                    <YtField
                      item={song}
                      onSet={(videoId) =>
                        sendCommand({ type: "updateItem", uid: song.uid, patch: { youtubeVideoId: videoId } })
                      }
                    />
                    <button title="Remove" onClick={() => sendCommand({ type: "remove", uid: song.uid })}>
                      ✕
                    </button>
                    <button className={i === idx ? "primary" : ""} onClick={() => goTo(i)}>
                      {i === idx ? "On stage" : "Go"}
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <div
              className="cluster"
              style={{
                justifyContent: "space-between",
                marginTop: "0.75rem",
                paddingTop: "0.75rem",
                borderTop: "1px solid var(--line-strong)",
              }}
            >
              <span className="muted">
                {playlist.length} song{playlist.length === 1 ? "" : "s"}
              </span>
              <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                Total (recorded lengths): {fmtLong(knownTotal)}
              </strong>
            </div>
          </>
        )}
      </div>

      {/* Now playing */}
      {currentItem && (
        <div className="transport">
          <div className="cluster" style={{ justifyContent: "space-between" }}>
            <div style={{ minWidth: 0 }}>
              <div className="title" style={{ fontStyle: "italic" }}>
                {currentItem.title} <span className="muted">— {currentItem.artist}</span>
              </div>
              <div className="muted">
                Song {idx + 1} of {playlist.length}
              </div>
            </div>
            <div className="mode-toggle" role="group" aria-label="Lyric mode">
              <button
                className={mode === "band" ? "primary" : ""}
                onClick={() => setMode("band")}
              >
                🎤 Band
              </button>
              <button
                className={mode === "playback" ? "primary" : ""}
                disabled={!playbackReady}
                title={
                  playbackReady
                    ? "Play the recording on this device; words follow automatically"
                    : !currentItem.hasSynced
                      ? "No synced lyrics for this song — band mode only"
                      : "Paste a YouTube link on the queue row first"
                }
                onClick={() => setMode("playback")}
              >
                ▶ Playback
              </button>
            </div>
          </div>

          {/* The YouTube player stays mounted (and visible, per its TOS) even
              in band mode, just smaller and paused. */}
          <div
            className={`yt-wrap ${mode === "playback" && currentItem.youtubeVideoId ? "" : "yt-mini"}`}
            style={{ display: currentItem.youtubeVideoId ? undefined : "none" }}
          >
            <div className="yt-frame">
              <div id="yt-player" />
            </div>
          </div>
          {ytError && mode === "playback" && (
            <p style={{ color: "var(--accent)", margin: "0.5rem 0 0" }}>{ytError}</p>
          )}

          {mode === "band" ? (
            <>
              <div className="bigline-btns">
                <button onClick={() => stepLine(-1)} disabled={lineIndex <= -1}>
                  ↑ Back
                </button>
                {lineIndex < 0 ? (
                  <button
                    className="primary bigbtn"
                    onClick={() => setLine(0)}
                    disabled={lines.length === 0}
                  >
                    ▶ Start lyrics
                  </button>
                ) : (
                  <button
                    className="primary bigbtn"
                    onClick={() => stepLine(1)}
                    disabled={lineIndex >= lines.length - 1}
                  >
                    ↓ Next line
                  </button>
                )}
                <button className="ghost" onClick={() => setLine(-1)} title="Back to the title card">
                  ⟲ Title card
                </button>
              </div>
              <p className="muted" style={{ margin: "0.4rem 0 0.6rem", fontSize: "0.85rem" }}>
                Space / → advances a line, ← goes back. Click any line to jump there.
              </p>
              <ol className="line-list">
                {lyStatus === "loading" && <li className="muted">Loading lyrics…</li>}
                {lyStatus === "unavailable" && (
                  <li className="muted">No lyrics found for this song.</li>
                )}
                {lines.map((line, i) => (
                  <li
                    key={i}
                    ref={i === lineIndex ? activeLineRef : undefined}
                    className={`line-row ${i === lineIndex ? "current" : ""} ${
                      line.sectionStart ? "section-gap" : ""
                    }`}
                    onClick={() => setLine(i)}
                  >
                    <span className="idx">{i + 1}</span>
                    <span>{line.text}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <div className="cluster" style={{ justifyContent: "center", marginTop: "0.75rem" }}>
                <button onClick={() => goTo(idx - 1)} disabled={idx === 0}>
                  ⏮
                </button>
                {state.isPlaying ? (
                  <button className="primary bigbtn" onClick={() => player.pause()}>
                    ⏸ Pause
                  </button>
                ) : (
                  <button
                    className="primary bigbtn"
                    onClick={() => {
                      wantPlayRef.current = true;
                      player.play();
                    }}
                    disabled={!player.ready}
                  >
                    ▶ Play
                  </button>
                )}
                <button onClick={() => goTo(idx + 1, true)} disabled={idx === playlist.length - 1}>
                  ⏭
                </button>
              </div>
              <div
                ref={barRef}
                className="progress"
                onClick={seekFromEvent}
                style={{ cursor: "pointer" }}
              >
                <span style={{ width: `${frac * 100}%` }} />
              </div>
              <div className="times">
                <span>{fmt(pos)}</span>
                <span>{fmt(dur)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Controller(props: { sessionId?: string }) {
  return (
    <Suspense fallback={<div className="wrap muted">Loading…</div>}>
      <ControllerInner {...props} />
    </Suspense>
  );
}
