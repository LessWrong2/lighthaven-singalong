"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, SessionState, StateEnvelope } from "./types";

export interface SyncStatus {
  connected: boolean;
  /** Estimated (clientClock - serverClock) in ms; subtract to get server time. */
  clockSkewMs: number;
}

const OFFSET_KEY = "lighthaven:deviceOffsetMs";

function loadOffset(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(OFFSET_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Subscribe to a session over SSE.
 *
 * Returns the latest state, a connection/clock-skew status, the device offset
 * (persisted per-device, for trimming network/audio lag), and `sendCommand`
 * for controllers.
 *
 * Use `livePositionNow()` (returns seconds) inside an animation frame / interval
 * to read the current synced playback position, already corrected for clock skew
 * and the device offset.
 */
export function useSession(sessionId: string | null) {
  const [state, setState] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ connected: false, clockSkewMs: 0 });
  const [deviceOffsetMs, setDeviceOffsetMsState] = useState<number>(0);

  const stateRef = useRef<SessionState | null>(null);
  const skewRef = useRef(0);
  const offsetRef = useRef(0);

  // Hydrate the persisted device offset on mount (client-only).
  useEffect(() => {
    const o = loadOffset();
    offsetRef.current = o;
    setDeviceOffsetMsState(o);
  }, []);

  const setDeviceOffsetMs = useCallback((ms: number) => {
    offsetRef.current = ms;
    setDeviceOffsetMsState(ms);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(OFFSET_KEY, String(ms));
    }
  }, []);

  // SSE subscription.
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/session/${sessionId}/events`);

    es.onopen = () => setStatus((s) => ({ ...s, connected: true }));
    es.onerror = () => setStatus((s) => ({ ...s, connected: false }));
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as StateEnvelope;
        // Estimate clock skew at message-receipt time. This ignores one-way
        // latency (a few ms on a LAN); the user's device-offset slider absorbs
        // any residual, plus genuine audio/network lag.
        const skew = Date.now() - env.serverNow;
        skewRef.current = skew;
        stateRef.current = env.state;
        setState(env.state);
        setStatus({ connected: true, clockSkewMs: skew });
      } catch {
        /* ignore malformed frame */
      }
    };

    return () => es.close();
  }, [sessionId]);

  /** Current synced position in seconds (clock-skew + device-offset corrected). */
  const livePositionNow = useCallback((): number => {
    const s = stateRef.current;
    if (!s) return 0;
    const offsetSec = offsetRef.current / 1000;
    if (!s.isPlaying) return Math.max(0, s.positionSec + offsetSec);
    // Convert local wall clock into server time before measuring elapsed.
    const serverNow = Date.now() - skewRef.current;
    const elapsed = (serverNow - s.updatedAt) / 1000;
    return Math.max(0, s.positionSec + elapsed + offsetSec);
  }, []);

  const sendCommand = useCallback(
    async (cmd: Command) => {
      if (!sessionId) return;
      await fetch(`/api/session/${sessionId}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
      // No optimistic update needed: the SSE broadcast echoes the new state.
    },
    [sessionId],
  );

  return {
    state,
    status,
    deviceOffsetMs,
    setDeviceOffsetMs,
    livePositionNow,
    sendCommand,
  };
}
