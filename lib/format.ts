import type { LyricDoc, LyricLine } from "./types";

/** Format seconds as m:ss (clamped at zero). */
export function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

// Timestamp tag: [m:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] — possibly several
// per line ("[00:12.00][00:50.00]chorus repeats").
const CUE = /\[(\d+):(\d{1,2}(?:\.\d{1,3})?)\]/g;
// Metadata tags like [ar:...], [ti:...], [offset:+120] — non-numeric-minutes.
const OFFSET = /^\[offset:\s*([+-]?\d+)\]/i;

/**
 * Parse standard LRC text into timed lines, sorted by time.
 *
 * Band mode addresses lyrics by line index on both the controller and every
 * display, so this parser must be deterministic and must not drop lines
 * conditionally: empty cue text (a timing gap / instrumental break) becomes a
 * "♪" line rather than being skipped.
 */
export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let offsetMs = 0;
  let prevBlank = false;
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      prevBlank = true;
      continue;
    }
    const off = line.match(OFFSET);
    if (off) {
      offsetMs = parseInt(off[1], 10) || 0;
      continue;
    }
    CUE.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = CUE.exec(line)) !== null) {
      // Only consume tags at the start of the line (contiguous run).
      if (m.index !== lastEnd) break;
      times.push((parseInt(m[1], 10) || 0) * 60 + parseFloat(m[2]));
      lastEnd = CUE.lastIndex;
    }
    if (!times.length) {
      // Non-cue, non-blank line: metadata tag or stray text — skip.
      prevBlank = false;
      continue;
    }
    const content = line.slice(lastEnd).trim() || "♪";
    for (const t of times) {
      out.push({
        t: t - offsetMs / 1000,
        text: content,
        ...(prevBlank ? { sectionStart: true } : {}),
      });
    }
    prevBlank = false;
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out;
}

/** Parse plain (unsynced) lyrics into lines; blank source lines mark the next
 * line as a stanza start. */
export function parsePlain(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let prevBlank = false;
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      prevBlank = true;
      continue;
    }
    out.push({ t: null, text: line, ...(prevBlank ? { sectionStart: true } : {}) });
    prevBlank = false;
  }
  return out;
}

/** Build a LyricDoc from an LRCLIB-shaped record, preferring synced lyrics. */
export function toLyricDoc(rec: {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}): LyricDoc | null {
  if (rec.syncedLyrics) {
    const lines = parseLrc(rec.syncedLyrics);
    if (lines.length) return { synced: true, lines };
  }
  if (rec.plainLyrics) {
    const lines = parsePlain(rec.plainLyrics);
    if (lines.length) return { synced: false, lines };
  }
  return null;
}

/**
 * Index of the active lyric line for a given position (last cue at or before
 * pos). Returns -1 before the first cue. A small lookahead matches the line
 * just before it's sung, as karaoke displays do. Lines must be timed.
 */
export function activeLyricIndex(lyrics: LyricLine[], pos: number): number {
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    const t = lyrics[i].t;
    if (t !== null && t <= pos + 0.15) idx = i;
    else break;
  }
  return idx;
}
