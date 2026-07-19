import { NextResponse } from "next/server";
import { createSession } from "@/lib/sessionStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/session — create a new session, returns its id + initial state.
export async function POST() {
  const state = await createSession();
  return NextResponse.json({ ok: true, id: state.id, state });
}
