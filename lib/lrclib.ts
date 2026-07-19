// Server-only client for LRCLIB (https://lrclib.net) — a free synced-lyrics
// database with an open API (no key, no rate limit). We proxy it through our
// own API routes so clients don't depend on third-party CORS and so responses
// get normalized + cached.
import type { LyricsRecord, LyricsSearchResult } from "./types";

const BASE = "https://lrclib.net/api";
// LRCLIB asks clients to identify themselves.
const CLIENT_HEADER = "Lighthaven Singalong (https://github.com/LessWrong2/lighthaven-singalong)";

interface RawRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export async function searchLyrics(q: string): Promise<LyricsSearchResult[]> {
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}`, {
    headers: { "Lrclib-Client": CLIENT_HEADER, "User-Agent": CLIENT_HEADER },
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`lrclib search failed: ${res.status}`);
  const rows = (await res.json()) as RawRecord[];
  return rows.map((r) => ({
    lrclibId: r.id,
    title: r.trackName,
    artist: r.artistName,
    album: r.albumName,
    durationSec: r.duration || 0,
    instrumental: Boolean(r.instrumental),
    hasSynced: Boolean(r.syncedLyrics && r.syncedLyrics.trim()),
    hasPlain: Boolean(r.plainLyrics && r.plainLyrics.trim()),
  }));
}

export async function getLyricsById(id: number): Promise<LyricsRecord | null> {
  const res = await fetch(`${BASE}/get/${id}`, {
    headers: { "Lrclib-Client": CLIENT_HEADER, "User-Agent": CLIENT_HEADER },
    // Records are effectively immutable — cache hard.
    next: { revalidate: 86400 },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib get failed: ${res.status}`);
  const r = (await res.json()) as RawRecord;
  return {
    lrclibId: r.id,
    title: r.trackName,
    artist: r.artistName,
    durationSec: r.duration || 0,
    syncedLyrics: r.syncedLyrics?.trim() ? r.syncedLyrics : null,
    plainLyrics: r.plainLyrics?.trim() ? r.plainLyrics : null,
  };
}
