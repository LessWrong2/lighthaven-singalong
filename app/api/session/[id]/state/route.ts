import { NextRequest, NextResponse } from "next/server";
import { applyCommand, ensureSession, getSession } from "@/lib/sessionStore";
import { CANONICAL_ID } from "@/lib/config";
import type { Command } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isCanonical = (id: string) => id.toUpperCase() === CANONICAL_ID;

// GET /api/session/[id]/state — snapshot of current state (+ server clock).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const state = isCanonical(id) ? await ensureSession(CANONICAL_ID) : await getSession(id);
  if (!state) {
    return NextResponse.json({ ok: false, error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, state, serverNow: Date.now() });
}

// POST /api/session/[id]/state — apply a controller command.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let cmd: Command;
  try {
    cmd = (await req.json()) as Command;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (isCanonical(id)) await ensureSession(CANONICAL_ID);
  const state = await applyCommand(id, cmd);
  if (!state) {
    return NextResponse.json({ ok: false, error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, state, serverNow: Date.now() });
}
