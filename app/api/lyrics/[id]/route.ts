import { NextRequest, NextResponse } from "next/server";
import { getLyricsById } from "@/lib/lrclib";

export const runtime = "nodejs";

// GET /api/lyrics/[id] — one LRCLIB record (synced + plain lyrics), normalized.
// Controller and displays both fetch this and parse it with the same shared
// parser, which is what keeps band-mode line indices in agreement everywhere.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  try {
    const record = await getLyricsById(n);
    if (!record) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { ok: true, record },
      { headers: { "Cache-Control": "public, max-age=86400, immutable" } },
    );
  } catch {
    return NextResponse.json({ ok: false, error: "lyrics unavailable" }, { status: 502 });
  }
}
