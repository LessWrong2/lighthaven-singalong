"use client";

import { useEffect, useRef, useState } from "react";
import { toLyricDoc } from "./format";
import type { LyricDoc, LyricsRecord, QueueItem } from "./types";

export type LyricsStatus = "idle" | "loading" | "ready" | "unavailable";

interface Entry {
  status: LyricsStatus;
  doc: LyricDoc | null;
}

/**
 * Fetch + cache + parse lyrics for a queue item, keyed on its LRCLIB id.
 *
 * Used by both the controller (band-mode line list) and every display
 * (rendering); both sides parse the same immutable record with the same
 * parser, so their line indices always agree.
 *
 * Deduped via a ref so writing the "loading" state can't re-trigger the
 * effect and cancel its own fetch; a failed network fetch clears the key to
 * allow a retry, while a definitive miss (404 / no usable lyrics) is cached
 * as unavailable.
 */
export function useLyrics(item: QueueItem | undefined): Entry {
  const [cache, setCache] = useState<Record<number, Entry>>({});
  const requestedRef = useRef<Set<number>>(new Set());

  const id = item ? item.lrclibId : null;

  useEffect(() => {
    if (id === null || requestedRef.current.has(id)) return;
    requestedRef.current.add(id);
    setCache((m) => ({ ...m, [id]: { status: "loading", doc: null } }));
    fetch(`/api/lyrics/${id}`)
      .then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as { ok: boolean; record: LyricsRecord };
        return body.record;
      })
      .then((record) => {
        const doc = record ? toLyricDoc(record) : null;
        setCache((m) => ({
          ...m,
          [id]: doc ? { status: "ready", doc } : { status: "unavailable", doc: null },
        }));
      })
      .catch(() => {
        // Network/server failure: allow a later retry for this id.
        requestedRef.current.delete(id);
        setCache((m) => ({ ...m, [id]: { status: "unavailable", doc: null } }));
      });
  }, [id]);

  if (!item) return { status: "idle", doc: null };
  if (item.lrclibId === null) return { status: "unavailable", doc: null };
  return cache[item.lrclibId] ?? { status: "loading", doc: null };
}
