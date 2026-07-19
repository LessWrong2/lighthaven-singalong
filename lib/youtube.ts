"use client";

// YouTube IFrame Player API integration for the controller.
//
// The player lives on the host machine only (audio goes to the PA); displays
// never load YouTube. Per the API TOS the player must stay visible — don't
// hide or shrink it below 200x200.

import { useCallback, useEffect, useRef, useState } from "react";

export interface YtTransport {
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
}

// Minimal typings for the pieces of the IFrame API we use.
interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  loadVideoById(id: string): void;
  cueVideoById(id: string): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

interface YtNamespace {
  Player: new (
    el: string | HTMLElement,
    opts: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YtPlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Pull a video id out of a pasted YouTube URL (or a bare 11-char id). */
export function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  const idOk = (v: string | null | undefined) =>
    v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
  if (host === "youtu.be") return idOk(url.pathname.split("/")[1]);
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const fromParam = idOk(url.searchParams.get("v"));
    if (fromParam) return fromParam;
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

/** Human-readable message for YT player error codes. */
export function ytErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return "Invalid video id.";
    case 5:
      return "This video can't be played in the embedded player.";
    case 100:
      return "Video not found (removed or private).";
    case 101:
    case 150:
      return "This video's owner blocks embedding — try a different upload of the song.";
    default:
      return `YouTube player error (${code}).`;
  }
}

// The IFrame API script is loaded once, on first use.
let apiPromise: Promise<YtNamespace> | null = null;
function loadApi(): Promise<YtNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiPromise;
}

const POLL_MS = 500;

/**
 * Mount a YouTube player in the element with id `containerId` and report its
 * transport (playing/position/duration) via `onTransport`: immediately on
 * every state change, and every 500ms while playing. The caller decides how
 * often to forward that upstream.
 *
 * BUFFERING reports as not-playing so displays freeze in place instead of
 * drifting ahead of stalled audio.
 */
export function useYouTubePlayer(opts: {
  videoId: string | null;
  containerId: string;
  onTransport: (t: YtTransport) => void;
  onEnded: () => void;
  onError: (message: string) => void;
  /** When the video id changes, start playing immediately (auto-advance)? */
  getAutoplay?: () => boolean;
}) {
  const { videoId, containerId } = opts;
  const playerRef = useRef<YtPlayer | null>(null);
  const ytRef = useRef<YtNamespace | null>(null);
  const loadedIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [ready, setReady] = useState(false);

  // Callback refs so player event handlers never go stale.
  const onTransportRef = useRef(opts.onTransport);
  const onEndedRef = useRef(opts.onEnded);
  const onErrorRef = useRef(opts.onError);
  const getAutoplayRef = useRef(opts.getAutoplay);
  onTransportRef.current = opts.onTransport;
  onEndedRef.current = opts.onEnded;
  onErrorRef.current = opts.onError;
  getAutoplayRef.current = opts.getAutoplay;

  const report = useCallback((isPlaying: boolean) => {
    const p = playerRef.current;
    if (!p) return;
    let pos = 0;
    let dur = 0;
    try {
      pos = p.getCurrentTime() || 0;
      dur = p.getDuration() || 0;
    } catch {
      /* player mid-teardown */
    }
    onTransportRef.current({ isPlaying, positionSec: pos, durationSec: dur });
  }, []);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Create the player once we have a video, then swap videos in place.
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    (async () => {
      const YT = await loadApi();
      if (cancelled) return;
      ytRef.current = YT;
      if (!playerRef.current) {
        loadedIdRef.current = videoId;
        playerRef.current = new YT.Player(containerId, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => {
              if (!cancelled) setReady(true);
            },
            onStateChange: (e) => {
              const S = YT.PlayerState;
              if (e.data === S.PLAYING) {
                report(true);
                stopPoll();
                pollRef.current = setInterval(() => report(true), POLL_MS);
              } else {
                stopPoll();
                report(false);
                if (e.data === S.ENDED) onEndedRef.current();
              }
            },
            onError: (e) => onErrorRef.current(ytErrorMessage(e.data)),
          },
        });
      } else if (loadedIdRef.current !== videoId) {
        loadedIdRef.current = videoId;
        stopPoll();
        // loadVideoById autoplays (allowed: the tab already has playback
        // consent from the host's first click); cueVideoById waits.
        if (getAutoplayRef.current?.()) playerRef.current.loadVideoById(videoId);
        else playerRef.current.cueVideoById(videoId);
        report(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId, containerId, report, stopPoll]);

  // Teardown on unmount only.
  useEffect(() => {
    return () => {
      stopPoll();
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
    };
  }, [stopPoll]);

  const play = useCallback(() => playerRef.current?.playVideo(), []);
  const pause = useCallback(() => playerRef.current?.pauseVideo(), []);
  const seekTo = useCallback(
    (sec: number) => {
      playerRef.current?.seekTo(sec, true);
      // Report right away so displays re-anchor without waiting for the poll.
      report(true);
    },
    [report],
  );

  return { play, pause, seekTo, ready };
}
