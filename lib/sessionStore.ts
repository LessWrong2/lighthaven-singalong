import Redis from "ioredis";
import type { Command, SessionState } from "./types";

// Session store + pub/sub for SSE fan-out, with two interchangeable backends:
//
//  - "memory"  — in-process Map + in-process subscribers. Zero config. Correct
//                only for a single Node process (local dev, the sandbox, or any
//                single-instance host). This is the default when REDIS_URL is
//                unset.
//  - "redis"   — state in Redis (one JSON blob per session) and cross-instance
//                fan-out via Redis pub/sub. Required on serverless/multi-instance
//                hosts like Vercel, where the controller's POST and a display's
//                SSE stream run in different isolated instances. Enabled
//                automatically when REDIS_URL is set.
//
// The public surface (createSession/getSession/applyCommand/subscribe) is async
// in both cases so call sites don't care which backend is live.

// ---------------------------------------------------------------------------
// Shared, backend-agnostic helpers
// ---------------------------------------------------------------------------

type Subscriber = (state: SessionState) => void;

const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars

function makeId(len = 4): string {
  let id = "";
  for (let i = 0; i < len; i++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

function freshState(id: string): SessionState {
  return {
    id,
    playlist: [],
    currentIndex: 0,
    mode: "band",
    isPlaying: false,
    positionSec: 0,
    durationSec: 0,
    rate: 1,
    lineIndex: -1,
    updatedAt: Date.now(),
  };
}

/** Live position implied by the transport anchor at a given server time. */
export function livePosition(state: SessionState, now = Date.now()): number {
  if (!state.isPlaying) return state.positionSec;
  return state.positionSec + ((now - state.updatedAt) / 1000) * (state.rate ?? 1);
}

function clampIndex(state: SessionState, i: number): number {
  if (state.playlist.length === 0) return 0;
  return Math.max(0, Math.min(state.playlist.length - 1, i));
}

/** Reset per-song fields after the current song changes. */
function onSongChange(state: SessionState): void {
  state.positionSec = 0;
  state.durationSec = 0;
  state.rate = 1;
  state.isPlaying = false;
  state.lineIndex = -1;
  // Coerce unknown values (e.g. items from a retired mode) to band.
  const dm = state.playlist[state.currentIndex]?.defaultMode;
  state.mode = dm === "auto" ? "auto" : "band";
}

/** Apply a command's effect to a state object in place. Pure logic, no I/O. */
function mutate(state: SessionState, cmd: Command): void {
  const now = Date.now();
  switch (cmd.type) {
    case "sync":
      // Controller's transport is authoritative; just record + re-anchor.
      state.isPlaying = cmd.isPlaying;
      state.positionSec = Math.max(0, cmd.positionSec);
      if (cmd.durationSec > 0) state.durationSec = cmd.durationSec;
      state.rate = cmd.rate && cmd.rate > 0 ? cmd.rate : 1;
      state.updatedAt = now;
      break;
    case "next":
      state.currentIndex = clampIndex(state, state.currentIndex + 1);
      onSongChange(state);
      state.updatedAt = now;
      break;
    case "prev":
      state.currentIndex = clampIndex(state, state.currentIndex - 1);
      onSongChange(state);
      state.updatedAt = now;
      break;
    case "select":
      state.currentIndex = clampIndex(state, cmd.index);
      onSongChange(state);
      state.updatedAt = now;
      break;
    case "add":
      state.playlist.push(cmd.item);
      // First song added to an empty queue becomes current (with its mode).
      if (state.playlist.length === 1) onSongChange(state);
      state.updatedAt = now;
      break;
    case "remove": {
      const i = state.playlist.findIndex((s) => s.uid === cmd.uid);
      if (i < 0) break;
      const removingCurrent = i === state.currentIndex;
      state.playlist.splice(i, 1);
      if (i < state.currentIndex) state.currentIndex -= 1;
      state.currentIndex = clampIndex(state, state.currentIndex);
      if (removingCurrent) onSongChange(state);
      state.updatedAt = now;
      break;
    }
    case "updateItem": {
      const item = state.playlist.find((s) => s.uid === cmd.uid);
      if (!item) break;
      if (cmd.patch.hasChords !== undefined) item.hasChords = cmd.patch.hasChords;
      if (cmd.patch.chordsRev !== undefined) item.chordsRev = cmd.patch.chordsRev;
      if (cmd.patch.defaultMode !== undefined) {
        item.defaultMode = cmd.patch.defaultMode;
        // Changing the current song's default also flips the live mode, so the
        // queue chips behave as a mode switch for the song on stage.
        if (state.playlist[state.currentIndex]?.uid === cmd.uid) {
          state.mode = cmd.patch.defaultMode;
        }
      }
      state.updatedAt = now;
      break;
    }
    case "reorder": {
      const { from, to } = cmd;
      const n = state.playlist.length;
      if (from < 0 || from >= n || to < 0 || to >= n || from === to) break;
      const currentUid = state.playlist[state.currentIndex]?.uid;
      const [moved] = state.playlist.splice(from, 1);
      state.playlist.splice(to, 0, moved);
      // Keep "current song" pointing at the same song after the move.
      if (currentUid) {
        const newIdx = state.playlist.findIndex((s) => s.uid === currentUid);
        if (newIdx >= 0) state.currentIndex = newIdx;
      }
      state.updatedAt = now;
      break;
    }
    case "reset":
      state.playlist = [];
      state.currentIndex = 0;
      onSongChange(state);
      state.updatedAt = now;
      break;
    case "mode":
      state.mode = cmd.mode === "auto" ? "auto" : "band";
      // Entering band mode freezes the clock; leaving it starts paused.
      state.isPlaying = false;
      state.updatedAt = now;
      break;
    case "line":
      // Upper bound is clamped by clients (the server holds no lyrics).
      state.lineIndex = Math.max(-1, Math.floor(cmd.index));
      state.updatedAt = now;
      break;
  }
}

interface Backend {
  create(): Promise<SessionState>;
  /** Get the session with this exact id, creating it (empty queue) if absent. */
  ensure(id: string): Promise<SessionState>;
  get(id: string): Promise<SessionState | undefined>;
  apply(id: string, cmd: Command): Promise<SessionState | undefined>;
  /** Subscribe to state changes; resolves to an unsubscribe function. */
  subscribe(id: string, fn: Subscriber): Promise<() => void | Promise<void>>;
  /** Chord sheets, keyed by queue-item uid. Side-channel: too big to ride
   * along in session state, which is rebroadcast on every command. */
  chordsGet(uid: string): Promise<string | null>;
  chordsSet(uid: string, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory backend (single process)
// ---------------------------------------------------------------------------

interface MemoryStore {
  sessions: Map<string, SessionState>;
  subscribers: Map<string, Set<Subscriber>>;
  chords: Map<string, string>;
}

function makeMemoryBackend(): Backend {
  // Stashed on globalThis so Next.js's dev hot-reload doesn't wipe it on every
  // module re-evaluation.
  const g = globalThis as unknown as { __singalongStore?: MemoryStore };
  const store: MemoryStore =
    g.__singalongStore ??
    (g.__singalongStore = { sessions: new Map(), subscribers: new Map(), chords: new Map() });
  store.chords ??= new Map(); // hot-reload from an older store shape

  const broadcast = (state: SessionState) => {
    const subs = store.subscribers.get(state.id);
    if (!subs) return;
    for (const fn of subs) {
      try {
        fn(state);
      } catch {
        /* a dead subscriber shouldn't break the others */
      }
    }
  };

  return {
    async create() {
      let id = makeId();
      while (store.sessions.has(id)) id = makeId();
      const state = freshState(id);
      store.sessions.set(id, state);
      return state;
    },
    async ensure(id) {
      const key = id.toUpperCase();
      let state = store.sessions.get(key);
      if (!state) {
        state = freshState(key);
        store.sessions.set(key, state);
      }
      return state;
    },
    async get(id) {
      return store.sessions.get(id.toUpperCase());
    },
    async apply(id, cmd) {
      const state = store.sessions.get(id.toUpperCase());
      if (!state) return undefined;
      mutate(state, cmd);
      broadcast(state);
      return state;
    },
    async subscribe(id, fn) {
      const key = id.toUpperCase();
      let subs = store.subscribers.get(key);
      if (!subs) {
        subs = new Set();
        store.subscribers.set(key, subs);
      }
      subs.add(fn);
      return () => {
        subs!.delete(fn);
        if (subs!.size === 0) store.subscribers.delete(key);
      };
    },
    async chordsGet(uid) {
      return store.chords.get(uid) ?? null;
    },
    async chordsSet(uid, text) {
      if (text) store.chords.set(uid, text);
      else store.chords.delete(uid);
    },
  };
}

// ---------------------------------------------------------------------------
// Redis backend (cross-instance, for serverless)
// ---------------------------------------------------------------------------

// Abandoned sessions self-expire; refreshed on every write.
const SESSION_TTL_SEC = 60 * 60 * 24;
const stateKey = (id: string) => `lighthaven:session:${id.toUpperCase()}`;
const channel = (id: string) => `lighthaven:chan:${id.toUpperCase()}`;

/** Rebuild a well-formed connection URL from however REDIS_URL was pasted.
 * Real-world values arrive scheme-less (`user:pass@host:port`), protocol-
 * relative (`//user:pass@host:port`), or with stray whitespace/newlines from
 * dashboard line-wrap; ioredis silently treats malformed ones as unix socket
 * paths and dies with ENOENT. */
function normalizeRedisUrl(url: string): string {
  let clean = url.replace(/\s+/g, "");
  // A whole `REDIS_URL=...` line pasted as the value, possibly quoted.
  clean = clean.replace(/^["']+|["']+$/g, "");
  clean = clean.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
  clean = clean.replace(/^["']+|["']+$/g, "");
  const m = clean.match(/^(rediss?):\/+(.*)$/i);
  if (m) return `${m[1].toLowerCase()}://${m[2]}`;
  return `redis://${clean.replace(/^\/+/, "")}`;
}

/** An unhandled ioredis "error" event crashes the serverless function; log it
 * and let ioredis's built-in retries do their thing instead. */
function quietErrors<T extends Redis>(conn: T): T {
  conn.on("error", (err) => console.error("[redis]", err?.message ?? err));
  return conn;
}

function makeRedisBackend(rawUrl: string): Backend {
  const url = normalizeRedisUrl(rawUrl);
  // One shared command/publish connection, reused across invocations on a warm
  // instance (subscriptions get their own connections — a subscribed client
  // can't issue normal commands).
  const g = globalThis as unknown as { __singalongRedis?: Redis };
  const cmd =
    g.__singalongRedis ??
    (g.__singalongRedis = quietErrors(
      new Redis(url, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
      }),
    ));

  const write = async (state: SessionState) => {
    await cmd.set(stateKey(state.id), JSON.stringify(state), "EX", SESSION_TTL_SEC);
  };

  return {
    async create() {
      // Reserve a free id atomically with SET NX.
      for (let attempt = 0; attempt < 8; attempt++) {
        const id = makeId();
        const state = freshState(id);
        const ok = await cmd.set(
          stateKey(id),
          JSON.stringify(state),
          "EX",
          SESSION_TTL_SEC,
          "NX",
        );
        if (ok) return state;
      }
      throw new Error("could not allocate a session id");
    },
    async ensure(id) {
      const key = id.toUpperCase();
      // Create only if absent; then read back the authoritative copy and
      // refresh its TTL so the canonical session stays alive while in use.
      await cmd.set(stateKey(key), JSON.stringify(freshState(key)), "EX", SESSION_TTL_SEC, "NX");
      const raw = await cmd.get(stateKey(key));
      await cmd.expire(stateKey(key), SESSION_TTL_SEC);
      return raw ? (JSON.parse(raw) as SessionState) : freshState(key);
    },
    async get(id) {
      const raw = await cmd.get(stateKey(id));
      return raw ? (JSON.parse(raw) as SessionState) : undefined;
    },
    async apply(id, command) {
      const raw = await cmd.get(stateKey(id));
      if (!raw) return undefined;
      const state = JSON.parse(raw) as SessionState;
      mutate(state, command);
      await write(state);
      // Fan out to every subscribed SSE stream, on any instance.
      await cmd.publish(channel(id), JSON.stringify(state));
      return state;
    },
    async subscribe(id, fn) {
      const sub = quietErrors(new Redis(url, { maxRetriesPerRequest: null }));
      const ch = channel(id);
      sub.on("message", (_ch, msg) => {
        try {
          fn(JSON.parse(msg) as SessionState);
        } catch {
          /* ignore malformed payload */
        }
      });
      await sub.subscribe(ch);
      return async () => {
        try {
          await sub.unsubscribe(ch);
        } catch {
          /* best effort */
        }
        sub.disconnect();
      };
    },
    async chordsGet(uid) {
      return cmd.get(`lighthaven:chords:${uid}`);
    },
    async chordsSet(uid, text) {
      const key = `lighthaven:chords:${uid}`;
      if (text) await cmd.set(key, text, "EX", SESSION_TTL_SEC);
      else await cmd.del(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL?.trim();

/** True when the Redis backend is active (multi-instance safe). */
export const usingRedis = Boolean(REDIS_URL);

const backend: Backend = REDIS_URL ? makeRedisBackend(REDIS_URL) : makeMemoryBackend();

export function createSession(): Promise<SessionState> {
  return backend.create();
}

export function ensureSession(id: string): Promise<SessionState> {
  return backend.ensure(id);
}

export function getSession(id: string): Promise<SessionState | undefined> {
  return backend.get(id);
}

export function applyCommand(id: string, cmd: Command): Promise<SessionState | undefined> {
  return backend.apply(id, cmd);
}

export function subscribe(
  id: string,
  fn: Subscriber,
): Promise<() => void | Promise<void>> {
  return backend.subscribe(id, fn);
}

export function getChords(uid: string): Promise<string | null> {
  return backend.chordsGet(uid);
}

export function setChords(uid: string, text: string): Promise<void> {
  return backend.chordsSet(uid, text);
}
