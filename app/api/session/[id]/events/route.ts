import { NextRequest } from "next/server";
import { ensureSession, getSession, subscribe } from "@/lib/sessionStore";
import { CANONICAL_ID } from "@/lib/config";
import type { SessionState, StateEnvelope } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep the SSE stream open as long as the platform allows; EventSource
// auto-reconnects (and re-fetches a fresh snapshot) when the function recycles.
export const maxDuration = 300;

// GET /api/session/[id]/events — Server-Sent Events stream of state changes.
// Displays and joined devices subscribe here; the controller's POSTs trigger
// broadcasts. Each event carries serverNow so clients can correct clock skew.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // The canonical concert session is created on demand so it always exists.
  const initial =
    id.toUpperCase() === CANONICAL_ID
      ? await ensureSession(CANONICAL_ID)
      : await getSession(id);
  if (!initial) {
    return new Response("session not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (state: SessionState) => {
        const env: StateEnvelope = { state, serverNow: Date.now() };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(env)}\n\n`));
        } catch {
          /* closed */
        }
      };

      // Initial snapshot immediately on connect.
      send(initial);

      const unsubscribe = await subscribe(id, send);

      // Heartbeat keeps proxies from closing an idle connection and lets the
      // client notice a dead stream.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, 15000);

      // Clean up when the client disconnects.
      _req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        Promise.resolve(unsubscribe()).catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
