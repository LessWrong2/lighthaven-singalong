"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { activeLyricIndex, fmt } from "@/lib/format";
import { APP_NAME, CANONICAL_ID } from "@/lib/config";
import { useLyrics } from "@/lib/useLyrics";

// Lyric typeface choices. All are device-available system stacks (no web-font
// loading), so the picker works instantly and offline. "serif" is the default.
const FONTS: { key: string; label: string; stack: string }[] = [
  {
    key: "serif",
    label: "Serif",
    stack:
      '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif',
  },
  {
    key: "sans",
    label: "Sans",
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  {
    key: "mono",
    label: "Mono",
    stack: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
  {
    key: "condensed",
    label: "Condensed",
    stack: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", system-ui, sans-serif',
  },
];

function fontStackFor(key: string): string {
  return (FONTS.find((f) => f.key === key) ?? FONTS[0]).stack;
}

function DisplayInner({
  sessionId: propSessionId,
  concert,
  chords: wantChords,
}: {
  sessionId?: string;
  concert?: boolean;
  /** Prefer the song's chord sheet over lyrics when one exists (the /chords
   * screen, pointed at the band). */
  chords?: boolean;
}) {
  const params = useSearchParams();
  // Prop wins, then an explicit ?s= code, else the canonical session.
  const sessionId = propSessionId ?? params.get("s") ?? CANONICAL_ID;
  const { state, status, deviceOffsetMs, setDeviceOffsetMs, livePositionNow } =
    useSession(sessionId);

  const [notFound, setNotFound] = useState(false);
  const [pos, setPos] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const chordsPreRef = useRef<HTMLPreElement>(null);
  const [chordSheet, setChordSheet] = useState<{ uid: string; text: string | null } | null>(
    null,
  );

  // Per-device lyric appearance, persisted in localStorage so each display
  // screen keeps its own font size / line spacing across reloads.
  const [fontScale, setFontScale] = useState(1);
  const [lineSpace, setLineSpace] = useState(0.3);
  const [fontKey, setFontKey] = useState("serif");
  useEffect(() => {
    const fs = Number(window.localStorage.getItem("lighthaven:fontScale"));
    const ls = window.localStorage.getItem("lighthaven:lineSpace");
    const fk = window.localStorage.getItem("lighthaven:fontKey");
    if (Number.isFinite(fs) && fs > 0) setFontScale(fs);
    if (ls !== null && Number.isFinite(Number(ls))) setLineSpace(Number(ls));
    if (fk && FONTS.some((f) => f.key === fk)) setFontKey(fk);
  }, []);
  const updateFontScale = (v: number) => {
    setFontScale(v);
    window.localStorage.setItem("lighthaven:fontScale", String(v));
  };
  const updateLineSpace = (v: number) => {
    setLineSpace(v);
    window.localStorage.setItem("lighthaven:lineSpace", String(v));
  };
  const updateFontKey = (k: string) => {
    setFontKey(k);
    window.localStorage.setItem("lighthaven:fontKey", k);
  };

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/session/${sessionId}/state`).then((r) => setNotFound(r.status === 404));
  }, [sessionId]);

  const current = state?.playlist[state.currentIndex];
  const { status: lyStatus, doc } = useLyrics(current);
  const lines = doc?.lines ?? [];

  // Refs the animation loop reads (it must never go stale between renders).
  const modeRef = useRef(state?.mode);
  modeRef.current = state?.mode;
  const durRef = useRef(0);
  durRef.current = state?.durationSec ?? 0;
  const lineIndexRef = useRef(-1);
  lineIndexRef.current = state?.lineIndex ?? -1;
  const linesLenRef = useRef(0);
  linesLenRef.current = lines.length;

  // Tick the synced position and ease the scroll: the active lyric line
  // drifts to center, or (band screen) the chord sheet scrolls proportionally
  // to song progress. Hand-rolled because scrollIntoView({behavior:"smooth"})
  // gets cancelled by the per-frame re-renders and never completes. rAF stops
  // in occluded windows, so a coarse interval keeps the position moving too.
  useEffect(() => {
    const tick = () => {
      setPos(livePositionNow());
      const pre = chordsPreRef.current;
      if (pre) {
        // Proportional follow for the chord sheet.
        const frac =
          modeRef.current === "band"
            ? (lineIndexRef.current + 1) / Math.max(1, linesLenRef.current)
            : durRef.current > 0
              ? Math.min(1, livePositionNow() / durRef.current)
              : 0;
        const target = frac * Math.max(0, pre.scrollHeight - pre.clientHeight);
        const delta = target - pre.scrollTop;
        if (Math.abs(delta) > 2) pre.scrollTop += delta * 0.06;
        return;
      }
      const el = activeRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const delta = rect.top + rect.height / 2 - window.innerHeight / 2;
        if (Math.abs(delta) > 4) window.scrollBy(0, delta * 0.08);
      }
    };
    let raf: number;
    const loop = () => {
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const fallback = setInterval(tick, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(fallback);
    };
  }, [livePositionNow]);

  // Fetch the chord sheet when this is the /chords screen and the current
  // song has one pasted.
  const currentUid = current?.uid;
  const currentHasChords = Boolean(current?.hasChords);
  useEffect(() => {
    if (!wantChords || !currentUid || !currentHasChords) return;
    if (chordSheet?.uid === currentUid && chordSheet.text !== null) return;
    let cancelled = false;
    fetch(`/api/chords/${currentUid}`)
      .then(async (r) => (r.ok ? String((await r.json()).text ?? "") : ""))
      .catch(() => "")
      .then((text) => {
        if (!cancelled) setChordSheet({ uid: currentUid, text });
      });
    return () => {
      cancelled = true;
    };
  }, [wantChords, currentUid, currentHasChords, chordSheet]);

  // What this screen shows for the current song: the chord sheet when we're
  // the /chords screen and one exists (fall back to lyrics when it doesn't,
  // or when the sheet fails to load).
  const sheetText =
    chordSheet && currentUid && chordSheet.uid === currentUid ? chordSheet.text : null;
  const chordsActive =
    Boolean(wantChords) && currentHasChords && (sheetText === null || sheetText.length > 0);

  // Band mode when the host says so, or forced when there are no timestamps
  // to follow (plain lyrics can only be driven by hand).
  const bandMode = state?.mode === "band" || (doc !== null && !doc.synced);
  const active = !state
    ? -1
    : bandMode
      ? Math.min(state.lineIndex, lines.length - 1)
      : lyStatus === "ready" && doc?.synced
        ? activeLyricIndex(lines, pos)
        : -1;

  // (Centering the active line happens continuously in the RAF loop above.)

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  if (notFound)
    return (
      <div className="wrap">
        <div className="card">
          Session <strong>{sessionId}</strong> not found. <a href="/">Back to the main screen →</a>
        </div>
      </div>
    );
  if (!state) return <div className="wrap muted">Connecting…</div>;

  const dur = state.durationSec;
  const frac = dur > 0 ? Math.min(1, pos / dur) : 0;

  // Band mode holds on a title card until the host starts the first line.
  const showTitleCard = Boolean(current) && bandMode && state.lineIndex < 0;

  const settings = (
    <div
      className={`settings-zone ${showControls ? "open" : ""}`}
      onMouseLeave={() => setShowControls(false)}
    >
      <button
        className="ghost gear"
        onClick={() => setShowControls((s) => !s)}
        title="Settings"
        aria-label="Settings"
      >
        ⚙
      </button>

      {showControls && (
        <div className="card settings-panel">
          <div className="cluster" style={{ justifyContent: "space-between" }}>
            <strong>This screen</strong>
            <button className="ghost" onClick={toggleFullscreen}>
              ⛶ Fullscreen
            </button>
          </div>


          {!bandMode && (
            <>
              <strong style={{ display: "block", marginTop: "0.6rem" }}>Sync offset</strong>
              <p className="muted" style={{ margin: "0.3rem 0 0.6rem" }}>
                Drag if the words land ahead of or behind the music here. Positive = jump ahead.
              </p>
              <div className="cluster">
                <input
                  type="range"
                  min={-2000}
                  max={2000}
                  step={50}
                  value={deviceOffsetMs}
                  onChange={(e) => setDeviceOffsetMs(Number(e.target.value))}
                />
                <span style={{ width: "5.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {deviceOffsetMs > 0 ? "+" : ""}
                  {(deviceOffsetMs / 1000).toFixed(2)}s
                </span>
                <button className="ghost" onClick={() => setDeviceOffsetMs(0)}>
                  Reset
                </button>
              </div>
              <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "0.8rem 0" }} />
            </>
          )}

          <strong>Lyric size</strong>
          <div className="cluster" style={{ marginTop: "0.3rem" }}>
            <input
              type="range"
              min={0.5}
              max={5}
              step={0.05}
              value={fontScale}
              onChange={(e) => updateFontScale(Number(e.target.value))}
            />
            <span style={{ width: "5.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {Math.round(fontScale * 100)}%
            </span>
            <button className="ghost" onClick={() => updateFontScale(1)}>
              Reset
            </button>
          </div>

          <strong style={{ display: "block", marginTop: "0.6rem" }}>Line spacing</strong>
          <div className="cluster" style={{ marginTop: "0.3rem" }}>
            <input
              type="range"
              min={-1.5}
              max={2}
              step={0.05}
              value={lineSpace}
              onChange={(e) => updateLineSpace(Number(e.target.value))}
            />
            <span style={{ width: "5.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {lineSpace > 0 ? "+" : ""}
              {lineSpace.toFixed(2)}em
            </span>
            <button className="ghost" onClick={() => updateLineSpace(0.3)}>
              Reset
            </button>
          </div>

          <strong style={{ display: "block", marginTop: "0.6rem" }}>Font</strong>
          <div className="cluster" style={{ marginTop: "0.3rem" }}>
            {FONTS.map((f) => (
              <button
                key={f.key}
                className={fontKey === f.key ? "primary" : "ghost"}
                style={{ fontFamily: f.stack, padding: "0.25rem 0.6rem" }}
                onClick={() => updateFontKey(f.key)}
                aria-pressed={fontKey === f.key}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // Empty queue: a quiet poster while the host lines songs up.
  if (!current)
    return (
      <div className="display">
        {settings}
        <div className="poster">
          <div className="poster-kicker">Live Karaoke</div>
          <h1 className="poster-title">{APP_NAME}</h1>
          <p className="poster-foot muted">
            The words appear here when a song starts.
          </p>
        </div>
      </div>
    );

  return (
    <div className="display">
      {settings}

      {concert && <div className="concert-mark">{APP_NAME}</div>}

      {chordsActive ? (
        <>
          <div className="display-head">
            <h1 className="display-title">
              {current.title} <span className="display-artist">· {current.artist}</span>
            </h1>
            <div className="cluster">
              <span className="display-sub">
                {fmt(pos)}
                {dur > 0 ? ` / ${fmt(dur)}` : ""}
              </span>
              <span className="pill">
                <span className={`dot ${status.connected ? "live" : ""}`} />
                {status.connected ? "🎸 Chords" : "…"}
              </span>
            </div>
          </div>
          <div className="lyrics chords-mode" style={{ "--lyric-scale": fontScale } as CSSProperties}>
            {sheetText ? (
              <pre ref={chordsPreRef} className="chord-sheet">
                {sheetText}
              </pre>
            ) : (
              <p className="lyric-line active muted">Loading chords…</p>
            )}
          </div>
        </>
      ) : showTitleCard ? (
        <div className="poster">
          <div className="poster-kicker">Up now</div>
          <h1 className="poster-title">{current.title}</h1>
          <div className="titlecard-artist">{current.artist}</div>
          <p className="poster-foot muted">Get ready to sing…</p>
        </div>
      ) : (
        <>
          <div className="display-head">
            <h1 className="display-title">
              {current.title} <span className="display-artist">· {current.artist}</span>
            </h1>
            <div className="cluster">
              <span className="display-sub">
                {bandMode
                  ? lines.length
                    ? `${Math.max(0, active) + 1} / ${lines.length}`
                    : ""
                  : `${fmt(pos)}${dur > 0 ? ` / ${fmt(dur)}` : ""}`}
              </span>
              <span className="pill">
                <span className={`dot ${status.connected ? "live" : ""}`} />
                {status.connected
                  ? bandMode
                    ? "Live"
                    : state.isPlaying
                      ? "Synced"
                      : "Paused"
                  : "…"}
              </span>
            </div>
          </div>

          <div
            className="lyrics"
            style={
              {
                "--lyric-scale": fontScale,
                "--lyric-space": lineSpace,
                "--lyric-font": fontStackFor(fontKey),
              } as CSSProperties
            }
          >
            {lyStatus === "loading" && <p className="lyric-line active">Loading lyrics…</p>}
            {lyStatus === "unavailable" && (
              <p className="lyric-line active muted">No lyrics found for this song.</p>
            )}
            {lyStatus === "ready" &&
              lines.map((line, i) => (
                <p
                  key={i}
                  ref={i === active ? activeRef : undefined}
                  className={`lyric-line ${i === active ? "active" : ""} ${
                    line.sectionStart ? "section-gap" : ""
                  }`}
                >
                  {line.text}
                </p>
              ))}
          </div>

          <div className="display-foot">
            {!bandMode && (
              <div className="progress">
                <span style={{ width: `${frac * 100}%` }} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Display(props: {
  sessionId?: string;
  concert?: boolean;
  chords?: boolean;
}) {
  return (
    <Suspense fallback={<div className="wrap muted">Loading…</div>}>
      <DisplayInner {...props} />
    </Suspense>
  );
}
