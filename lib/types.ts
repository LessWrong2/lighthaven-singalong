// Shared types for the singalong app.

/** How lyrics advance for a song. */
export type SongMode =
  | "playback" // host plays the recording (YouTube); lyrics follow its clock
  | "band"; // live band; host advances lines manually (teleprompter)

/** A song in the queue. Lyrics themselves are NOT stored here — clients fetch
 * them from /api/lyrics/[lrclibId] so session state (rebroadcast on every
 * command) stays small. */
export interface QueueItem {
  /** Client-generated uid; the same song can be queued twice. */
  uid: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  /** LRCLIB record id; null = no lyrics found (instrumental / not in LRCLIB). */
  lrclibId: number | null;
  /** Whether the LRCLIB record has synced (timestamped) lyrics. */
  hasSynced: boolean;
  /** YouTube video id for playback mode, if the host attached one. */
  youtubeVideoId?: string;
  /** Mode this song starts in when selected. */
  defaultMode: SongMode;
}

/**
 * Server-relayed state for a session.
 *
 * In playback mode the controller owns the real player and is the source of
 * truth; it pushes position/playing/duration here via `sync`. Position is an
 * anchor (positionSec captured at updatedAt, in server-clock ms) so displays
 * can extrapolate between pushes, correcting for client/server clock skew via
 * the `serverNow` field on each event.
 *
 * In band mode there is no clock: `lineIndex` is the whole story and displays
 * jump to it directly.
 */
export interface SessionState {
  id: string;
  /** Ordered queue. */
  playlist: QueueItem[];
  /** Index into playlist of the current song. */
  currentIndex: number;
  /** Effective lyric mode for the current song (host can flip it live). */
  mode: SongMode;
  /** Whether the controller's player is playing (playback mode). */
  isPlaying: boolean;
  /** Playback position (seconds) at the moment captured by updatedAt. */
  positionSec: number;
  /** Duration of the current song (seconds), reported by the controller. */
  durationSec: number;
  /** Band-mode cursor: index of the current lyric line; -1 = title card. */
  lineIndex: number;
  /** Server epoch ms when the transport fields were last set. */
  updatedAt: number;
}

/** Envelope pushed over SSE; serverNow lets clients estimate clock skew. */
export interface StateEnvelope {
  state: SessionState;
  serverNow: number;
}

/** Commands the controller can POST to mutate session state. */
export type Command =
  // Controller reports its real player transport (playback mode).
  | { type: "sync"; isPlaying: boolean; positionSec: number; durationSec: number }
  // Song selection (resets transport + line cursor, adopts the song's mode).
  | { type: "select"; index: number }
  | { type: "next" }
  | { type: "prev" }
  // Queue management.
  | { type: "add"; item: QueueItem }
  | { type: "remove"; uid: string }
  | {
      type: "updateItem";
      uid: string;
      patch: Partial<Pick<QueueItem, "youtubeVideoId" | "defaultMode">>;
    }
  | { type: "reorder"; from: number; to: number }
  | { type: "reset" }
  // Lyric mode for the current song.
  | { type: "mode"; mode: SongMode }
  // Band mode: jump to an absolute line index (-1 = back to the title card).
  // Absolute (not relative) so double-sends and out-of-order arrivals are
  // harmless. The server holds no lyrics, so it only enforces the -1 floor;
  // the upper bound is clamped client-side.
  | { type: "line"; index: number };

/** One parsed lyric line. */
export interface LyricLine {
  /** Start time in seconds; null for plain (unsynced) lyrics. */
  t: number | null;
  text: string;
  /** True when this line starts a new stanza (blank line above it in source). */
  sectionStart?: boolean;
}

/** Parsed lyrics for a song. */
export interface LyricDoc {
  /** True when lines carry timestamps (playback auto-sync possible). */
  synced: boolean;
  lines: LyricLine[];
}

/** Normalized LRCLIB search result (shape of /api/lyrics/search rows). */
export interface LyricsSearchResult {
  lrclibId: number;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  instrumental: boolean;
  hasSynced: boolean;
  hasPlain: boolean;
}

/** Normalized LRCLIB record (shape of /api/lyrics/[id] payload). */
export interface LyricsRecord {
  lrclibId: number;
  title: string;
  artist: string;
  durationSec: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}
