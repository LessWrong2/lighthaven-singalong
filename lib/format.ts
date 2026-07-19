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
 * Chord sheets are stored per *song*, not per queue entry, so replaying a song
 * next week reuses its saved chords. Keyed by LRCLIB id when we have one,
 * else a slug of title+artist.
 */
export function chordKeyFor(item: {
  lrclibId: number | null;
  title: string;
  artist: string;
}): string {
  if (item.lrclibId !== null) return `lrc-${item.lrclibId}`;
  const slug = `${item.title} ${item.artist}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `t-${slug || "unknown"}`;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map each lyric line to the chord-sheet line that carries the same words, so
 * the chords screen can follow the active lyric instead of guessing
 * proportionally. Greedy and monotonic-first: search forward from the last
 * match (verses appear in order), wrapping to the top for repeats a sheet
 * writes only once (choruses). Unmatched lines stay -1 — the caller holds the
 * previous position.
 */
export function mapLyricsToSheet(lyrics: LyricLine[], sheetLines: string[]): number[] {
  const norms = sheetLines.map(normalizeForMatch);
  const map = new Array<number>(lyrics.length).fill(-1);
  let cursor = 0;
  const matches = (a: string, b: string) =>
    a === b || (a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a)));
  for (let i = 0; i < lyrics.length; i++) {
    const n = normalizeForMatch(lyrics[i].text);
    if (n.length < 4) continue; // "♪", "oh", etc. — too weak to anchor on
    let found = -1;
    for (let j = cursor; j < norms.length; j++) {
      if (norms[j] && matches(norms[j], n)) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      for (let j = 0; j < cursor; j++) {
        if (norms[j] && matches(norms[j], n)) {
          found = j;
          break;
        }
      }
    }
    if (found >= 0) {
      map[i] = found;
      cursor = found + 1;
    }
  }
  return map;
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
