# Lighthaven Singalong

Live band karaoke for [Lighthaven](https://lighthaven.space): one host machine
runs the **dashboard** at the PA desk, and any number of computers around the
venue open **singalong.lighthaven.space** as fullscreen, synced **lyric
screens**. The crowd picks any song; lyrics come from
[LRCLIB](https://lrclib.net) (a free synced-lyrics database) and every screen
follows the host in real time.

Adapted from
[fooming-singalong](https://github.com/LessWrong2/fooming-singalong).

## Pages

- **`/`** — the lyrics screen. Open it on every display, hit ⚙ → Fullscreen.
  Each screen has its own font / size / spacing settings (persisted per
  device).
- **`/dashboard`** — the host desk. Search a song, add it to the queue, hit
  **Go**, then drive it in one of two modes:
  - **⏱ Auto mode** (default for songs with synced lyrics) — a virtual clock
    advances the words on the song's own LRC timestamps; no audio needed.
    **Space** starts/pauses, **←/→** jump a line, click a line to resync to
    wherever the band actually is, and the **tempo slider** (70–130%) matches
    the clock to a band playing faster or slower than the record.
  - **🎤 Band mode** — fully manual teleprompter: **Space / →** next line,
    **←** back, click any line to jump, Home for the title card. Works with
    synced *and* plain (untimed) lyrics.

  **🎸 Chords**: paste a chord sheet for the current song (the "Find chords ↗"
  link opens a search; there's no free chords API, so it's copy-paste). Any
  display can flip on **⚙ → 🎸 Band screen (chords)** to show that sheet in
  monospace — aligned chords over lyrics — auto-scrolling in time with the
  song. Point that screen at the band; the rest keep showing lyrics.

`/controller?s=CODE` and `/display?s=CODE` still exist for ad-hoc side
sessions; normal use is the single canonical session (`HAVEN`).

## How sync works

The server relays a tiny session state (queue metadata + transport + line
cursor — never the lyrics themselves) to every device over **SSE**
(`/api/session/[id]/events`).

- **Auto mode:** the host's virtual clock is the source of truth. Play,
  pause, seek, and tempo changes push `sync` anchors (isPlaying, position,
  duration, rate); every event carries `serverNow` so clients correct clock
  skew and extrapolate the live position each animation frame — elapsed time
  scaled by the tempo rate. Each screen has a ±2s offset slider.
- **Band mode:** there is no clock — the host's `line` commands carry an
  absolute line index and screens jump to it (~100 ms).

Lyrics are fetched by every client from `/api/lyrics/[id]` (a caching proxy to
LRCLIB) and parsed with one shared deterministic parser, so the controller and
all screens always agree on line numbers.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:3000/dashboard` and `http://localhost:3000/` side by
side. Without `REDIS_URL`, state lives in-process (fine for one machine / dev).

## Deploy (Vercel)

- Set **`REDIS_URL`** to a Redis connection string (e.g. Upstash's
  `rediss://…` TLS URL — the ioredis one, not the REST URL). Required on
  Vercel: the POST and SSE streams run in different instances and fan out via
  Redis pub/sub.
- The SSE route declares `maxDuration = 300`; screens auto-reconnect when a
  function recycles.
- Domain: `singalong.lighthaven.space` → CNAME `cname.vercel-dns.com`.

## Event runbook

1. Host opens `/dashboard`.
2. Each lyric screen opens the site root, ⚙ → Fullscreen, adjusts font size.
   The one facing the band can also turn on ⚙ → 🎸 Band screen (chords).
3. Someone requests a song → search it → check the badge (**synced** /
   **plain** / **no lyrics**) → Add → drag to order → **Go**.
4. Band plays: in auto mode hit **▶ Start** when they start and trim the
   tempo/click a line if they drift; in band mode Space through the lines as
   they're sung. For a break, ⟲ Title card puts the next song's name up.

## Notes

- LRCLIB coverage is broad but not universal; obscure songs may only have
  plain lyrics (band mode still works) or none.
- Anyone who opens `/dashboard` is a host — there's no auth. Fine for a
  venue LAN; don't advertise the URL.
