"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { useLyrics } from "@/lib/useLyrics";
import { activeLyricIndex, fmt } from "@/lib/format";
import { APP_NAME, CANONICAL_ID } from "@/lib/config";
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
function SearchPanel({
  showQueue,
  onPick,
}: {
  showQueue: boolean;
  onPick: (item: QueueItem, playNow: boolean) => void;
}) {
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

  function pick(r: LyricsSearchResult, playNow: boolean) {
    onPick(
      {
        uid: crypto.randomUUID(),
        title: r.title,
        artist: r.artist,
        album: r.album || undefined,
        durationSec: r.durationSec || undefined,
        lrclibId: r.lrclibId,
        hasSynced: r.hasSynced,
        // Synced lyrics can auto-advance on their own timestamps; otherwise
        // the host drives lines by hand.
        defaultMode: r.hasSynced ? "auto" : "band",
      },
      playNow,
    );
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
                <span className="cluster" style={{ gap: "0.3rem", flexWrap: "nowrap" }}>
                  <button className="primary" onClick={() => pick(r, true)}>
                    Play
                  </button>
                  {showQueue && <button onClick={() => pick(r, false)}>+ Queue</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Paste-in chord sheet editor for the current song. The sheet is stored
 * server-side (chord store) and shown on displays that turn on "Band screen"
 * in their ⚙ settings, auto-scrolled in time with the song. */
function ChordsEditor({
  item,
  onSaved,
}: {
  item: QueueItem;
  onSaved: (hasChords: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!open && draft === null) {
      try {
        const r = await fetch(`/api/chords/${item.uid}`);
        setDraft(r.ok ? String((await r.json()).text ?? "") : "");
      } catch {
        setDraft("");
      }
    }
    setOpen((o) => !o);
  }

  async function save() {
    if (draft === null || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/chords/${item.uid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      const b = (await r.json()) as { ok: boolean; hasChords: boolean };
      if (b.ok) {
        onSaved(b.hasChords);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <div className="cluster">
        <button className="ghost" onClick={toggle} aria-expanded={open}>
          🎸 Chords{item.hasChords ? " ✓" : ""}
        </button>
        <a
          className="pill"
          href={`https://www.google.com/search?q=${encodeURIComponent(
            `${item.title} ${item.artist} chords`,
          )}`}
          target="_blank"
          rel="noreferrer"
          title="Find a chord sheet in a new tab, then paste it here"
        >
          Find chords ↗
        </a>
      </div>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <textarea
            className="chords-input"
            rows={10}
            placeholder={"Paste a chord sheet here (e.g. from a chords site):\n\n[Verse 1]\nA          G/A\nI hear the drums echoing tonight…"}
            value={draft ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="cluster" style={{ marginTop: "0.4rem" }}>
            <button className="primary" onClick={save} disabled={busy || draft === null}>
              {busy ? "Saving…" : "Save chords"}
            </button>
            <button className="ghost" onClick={() => setOpen(false)}>
              Close
            </button>
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              Shows on screens with &ldquo;🎸 Band screen&rdquo; turned on (⚙ on the display),
              scrolling in time with the song.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Next mode when clicking a queue row's chip: band ↔ auto (auto only when
 * the song has synced lyrics to drive it). */
function cycleMode(song: QueueItem): SongMode {
  if (song.defaultMode === "band" && song.hasSynced) return "auto";
  return "band";
}

const MODE_CHIP: Record<SongMode, string> = {
  band: "🎤 band",
  auto: "⏱ auto",
};

function ControllerInner({ sessionId: propSessionId }: { sessionId?: string }) {
  const params = useSearchParams();
  // Prop wins, then an explicit ?s= code, else the canonical session.
  const sessionId = propSessionId ?? params.get("s") ?? CANONICAL_ID;
  const isCanonical = sessionId.toUpperCase() === CANONICAL_ID;
  const { state, status, sendCommand } = useSession(sessionId);

  const [notFound, setNotFound] = useState(false);
  // The queue is a secondary tool — normally one song is up at a time and
  // "Play" swaps it directly; the queue panel is toggled open when the host
  // wants to line songs up.
  const [showQueue, setShowQueueState] = useState(false);
  useEffect(() => {
    setShowQueueState(window.localStorage.getItem("lighthaven:showQueue") === "1");
  }, []);
  const setShowQueue = (v: boolean) => {
    setShowQueueState(v);
    window.localStorage.setItem("lighthaven:showQueue", v ? "1" : "0");
  };
  // Drag-and-drop reorder state.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

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
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const linesLenRef = useRef(0);
  linesLenRef.current = lines.length;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;
  const idxRef = useRef(idx);
  idxRef.current = idx;

  // Reset the optimistic line cursor and the auto-mode clock when the song
  // changes.
  const currentUid = currentItem?.uid;
  useEffect(() => {
    sentLineRef.current = null;
    clockRef.current = { playing: false, pos: 0, atMs: 0, rate: 1 };
    setTempoState(1);
  }, [currentUid]);

  // ---- Auto mode: a virtual clock advances lyrics on the LRC timestamps ----
  //
  // No audio, no YouTube: the timing embedded in the synced lyrics (fetched
  // with the lyrics themselves) drives the words at the recording's pace. The
  // tempo slider scales the clock for a band playing faster or slower, and
  // clicking a line snaps the clock to that line's timestamp.

  const [tempo, setTempoState] = useState(1);
  const [, setClockTick] = useState(0); // re-render while the clock runs
  const clockRef = useRef({ playing: false, pos: 0, atMs: 0, rate: 1 });
  const lastClockSendRef = useRef(0);

  const lastCueSec = lines.length ? (lines[lines.length - 1].t ?? 0) : 0;
  const autoDuration = Math.max(currentItem?.durationSec ?? 0, lastCueSec + 8);
  const autoDurationRef = useRef(autoDuration);
  autoDurationRef.current = autoDuration;

  const clockPosNow = useCallback(() => {
    const c = clockRef.current;
    const pos = c.playing ? c.pos + ((Date.now() - c.atMs) / 1000) * c.rate : c.pos;
    return Math.min(pos, autoDurationRef.current);
  }, []);

  /** Re-anchor the clock at "now" and broadcast the transport. */
  const clockSync = useCallback(() => {
    const c = clockRef.current;
    c.pos = clockPosNow();
    c.atMs = Date.now();
    lastClockSendRef.current = c.atMs;
    sendCommand({
      type: "sync",
      isPlaying: c.playing,
      positionSec: c.pos,
      durationSec: autoDurationRef.current,
      rate: c.rate,
    });
    setClockTick((x) => x + 1);
  }, [clockPosNow, sendCommand]);

  const clockPlay = useCallback(() => {
    clockRef.current.playing = true;
    clockRef.current.atMs = Date.now();
    clockSync();
  }, [clockSync]);

  const clockPause = useCallback(() => {
    const c = clockRef.current;
    c.pos = clockPosNow();
    c.playing = false;
    clockSync();
  }, [clockPosNow, clockSync]);

  const clockSeek = useCallback(
    (sec: number) => {
      const c = clockRef.current;
      c.pos = Math.max(0, Math.min(autoDurationRef.current, sec));
      c.atMs = Date.now();
      clockSync();
    },
    [clockSync],
  );

  const setTempo = useCallback(
    (r: number) => {
      const c = clockRef.current;
      c.pos = clockPosNow(); // anchor at the old rate before switching
      c.atMs = Date.now();
      c.rate = r;
      setTempoState(r);
      clockSync();
    },
    [clockPosNow, clockSync],
  );

  /** Seek to the cue of the line `delta` away from the currently active one. */
  const clockStepLine = useCallback(
    (delta: number) => {
      const ls = linesRef.current;
      if (!ls.length) return;
      const cur = activeLyricIndex(ls, clockPosNow());
      const target = Math.max(0, Math.min(ls.length - 1, cur + delta));
      const t = ls[target].t;
      if (t !== null) clockSeek(t);
    },
    [clockPosNow, clockSeek],
  );

  // While auto mode runs: repaint, re-anchor every ~3s so displays can't
  // drift, and cue up the next song when the clock passes the end.
  useEffect(() => {
    if (mode !== "auto") return;
    const t = setInterval(() => {
      setClockTick((x) => x + 1);
      const c = clockRef.current;
      if (!c.playing) return;
      if (clockPosNow() >= autoDurationRef.current) {
        c.pos = autoDurationRef.current;
        c.playing = false;
        clockSync();
        const pl = playlistRef.current;
        const i = idxRef.current;
        if (i < pl.length - 1) sendCommand({ type: "select", index: i + 1 });
        return;
      }
      if (Date.now() - lastClockSendRef.current >= 3000) clockSync();
    }, 300);
    return () => clearInterval(t);
  }, [mode, clockPosNow, clockSync, sendCommand]);

  // Auto-mode readouts (recomputed on every clock-tick render).
  const autoPos = clockPosNow();
  const autoFrac = autoDuration > 0 ? Math.min(1, autoPos / autoDuration) : 0;
  const autoActive = mode === "auto" ? activeLyricIndex(lines, autoPos) : -1;
  const clockRunning = clockRef.current.playing;

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

  // Keyboard, unless a text field has focus. Band: space/arrows step lines.
  // Auto: space toggles the clock, arrows jump the clock a line.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = modeRef.current;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (m === "band") {
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
      } else if (m === "auto") {
        if (e.key === " ") {
          e.preventDefault();
          if (clockRef.current.playing) clockPause();
          else clockPlay();
        } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          clockStepLine(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          clockStepLine(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          clockSeek(0);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepLine, setLine, clockPause, clockPlay, clockStepLine, clockSeek]);

  const lineIndex = state?.lineIndex ?? -1;

  const goTo = useCallback(
    (target: number) => {
      sendCommand({ type: "select", index: target });
    },
    [sendCommand],
  );

  const setMode = useCallback(
    (m: SongMode) => {
      if (m !== "auto") {
        const c = clockRef.current;
        c.pos = clockPosNow();
        c.playing = false;
      }
      sendCommand({ type: "mode", mode: m });
    },
    [sendCommand, clockPosNow],
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
        Search a song and hit <strong>Play</strong> — it goes up on the screens right away.{" "}
        <strong>⏱ Auto</strong> advances the words on the song&apos;s own timing (tempo slider
        to match the band). <strong>🎤 Band</strong> is fully manual — Space / arrows step
        lines.
      </p>

      <SearchPanel
        showQueue={showQueue}
        onPick={(item, playNow) => {
          if (playNow) {
            // The new song lands at the end of the list; put it on stage.
            const target = playlistRef.current.length;
            sendCommand({ type: "add", item }).then(() =>
              sendCommand({ type: "select", index: target }),
            );
          } else {
            sendCommand({ type: "add", item });
          }
        }}
      />

      <div className="cluster" style={{ marginTop: "0.75rem" }}>
        <button className="ghost" onClick={() => setShowQueue(!showQueue)} aria-expanded={showQueue}>
          {showQueue ? "▾ Hide queue" : `▸ Queue (${playlist.length})`}
        </button>
      </div>

      {showQueue && (
      <div className="card" style={{ marginTop: "0.5rem" }}>
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
            Nothing queued — use &ldquo;+ Queue&rdquo; on a search result to line songs up.
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
                      title="How this song's lyrics advance — click to change: band = by hand, auto = on the song's own timing"
                      onClick={() =>
                        sendCommand({
                          type: "updateItem",
                          uid: song.uid,
                          patch: { defaultMode: cycleMode(song) },
                        })
                      }
                    >
                      {MODE_CHIP[song.defaultMode]}
                    </button>
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
      )}

      {/* Now playing */}
      {currentItem && (
        <div className="transport">
          <div className="cluster" style={{ justifyContent: "space-between" }}>
            <div style={{ minWidth: 0 }}>
              <div className="title" style={{ fontStyle: "italic" }}>
                {currentItem.title} <span className="muted">— {currentItem.artist}</span>
              </div>
              {showQueue && (
                <div className="muted">
                  Song {idx + 1} of {playlist.length}
                </div>
              )}
            </div>
            <div className="mode-toggle" role="group" aria-label="Lyric mode">
              <button
                className={mode === "band" ? "primary" : ""}
                title="Advance the words by hand (Space / arrows)"
                onClick={() => setMode("band")}
              >
                🎤 Band
              </button>
              <button
                className={mode === "auto" ? "primary" : ""}
                disabled={!currentItem.hasSynced}
                title={
                  currentItem.hasSynced
                    ? "Words advance on the song's own timing — no audio needed. Trim the tempo to match the band."
                    : "No synced lyrics for this song — band mode only"
                }
                onClick={() => setMode("auto")}
              >
                ⏱ Auto
              </button>
            </div>
          </div>

          <ChordsEditor
            key={currentItem.uid}
            item={currentItem}
            onSaved={(hasChords) =>
              sendCommand({ type: "updateItem", uid: currentItem.uid, patch: { hasChords } })
            }
          />

          {mode === "auto" ? (
            <>
              <div className="cluster" style={{ justifyContent: "center", marginTop: "0.75rem" }}>
                <button onClick={() => goTo(idx - 1)} disabled={idx === 0}>
                  ⏮
                </button>
                {clockRunning ? (
                  <button className="primary bigbtn" onClick={clockPause}>
                    ⏸ Pause
                  </button>
                ) : (
                  <button
                    className="primary bigbtn"
                    onClick={clockPlay}
                    disabled={lines.length === 0}
                  >
                    ▶ {autoPos > 0 ? "Resume" : "Start"}
                  </button>
                )}
                <button onClick={() => goTo(idx + 1)} disabled={idx === playlist.length - 1}>
                  ⏭
                </button>
              </div>
              <div
                ref={barRef}
                className="progress"
                onClick={(e) => {
                  const el = barRef.current;
                  if (!el || !autoDuration) return;
                  const rect = el.getBoundingClientRect();
                  const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  clockSeek(f * autoDuration);
                }}
                style={{ cursor: "pointer" }}
              >
                <span style={{ width: `${autoFrac * 100}%` }} />
              </div>
              <div className="times">
                <span>{fmt(autoPos)}</span>
                <span>{fmt(autoDuration)}</span>
              </div>
              <div className="cluster" style={{ marginTop: "0.4rem" }}>
                <span className="muted" style={{ fontSize: "0.85rem" }}>Tempo</span>
                <input
                  type="range"
                  min={0.7}
                  max={1.3}
                  step={0.01}
                  value={tempo}
                  onChange={(e) => setTempo(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ width: "3.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(tempo * 100)}%
                </span>
                <button className="ghost" onClick={() => setTempo(1)}>
                  Reset
                </button>
              </div>
              <div className="cluster" style={{ justifyContent: "center", marginTop: "0.4rem" }}>
                <button onClick={() => clockStepLine(-1)} disabled={lines.length === 0}>
                  ↶ Back a line
                </button>
                <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {lines.length ? `line ${Math.max(0, autoActive) + 1} / ${lines.length}` : ""}
                </span>
                <button onClick={() => clockStepLine(1)} disabled={lines.length === 0}>
                  Skip a line ↷
                </button>
              </div>
              <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
                Words advance on the song&apos;s own timing — watch any lyrics screen. Space =
                play/pause, ←/→ = jump a line to resync to the band, tempo slider if
                they&apos;re playing faster or slower than the record.
              </p>
            </>
          ) : (
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
              <p
                className="muted"
                style={{ margin: "0.4rem 0 0", fontSize: "0.85rem", textAlign: "center" }}
              >
                {lyStatus === "unavailable"
                  ? "No lyrics found for this song."
                  : lines.length
                    ? `Line ${lineIndex + 1} of ${lines.length} — watch any lyrics screen for the words.`
                    : "Loading lyrics…"}
              </p>
              <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
                Space / → advances a line, ← goes back, Home returns to the title card.
              </p>
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
