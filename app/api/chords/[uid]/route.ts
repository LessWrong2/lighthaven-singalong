import { NextRequest, NextResponse } from "next/server";
import { getChords, setChords } from "@/lib/sessionStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SHEET_CHARS = 40_000;
const UID_OK = /^[A-Za-z0-9-]{1,100}$/;

// GET /api/chords/[uid] — the chord sheet for a song. The param is a song
// key (see chordKeyFor in lib/format.ts), so sheets survive re-queueing.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid } = await params;
  if (!UID_OK.test(uid)) {
    return NextResponse.json({ ok: false, error: "bad uid" }, { status: 400 });
  }
  const text = await getChords(uid);
  if (text === null) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, text });
}

// POST /api/chords/[uid] — save (or clear, with empty text) the chord sheet.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid } = await params;
  if (!UID_OK.test(uid)) {
    return NextResponse.json({ ok: false, error: "bad uid" }, { status: 400 });
  }
  let body: { text?: unknown };
  try {
    body = (await req.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.text !== "string" || body.text.length > MAX_SHEET_CHARS) {
    return NextResponse.json({ ok: false, error: "bad text" }, { status: 400 });
  }
  await setChords(uid, body.text.trim() ? body.text : "");
  return NextResponse.json({ ok: true, hasChords: Boolean(body.text.trim()) });
}
