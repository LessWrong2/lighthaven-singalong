import { NextRequest, NextResponse } from "next/server";
import { searchLyrics } from "@/lib/lrclib";

export const runtime = "nodejs";

// GET /api/lyrics/search?q=<keywords> — normalized LRCLIB search results.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ ok: false, error: "missing q" }, { status: 400 });
  }
  try {
    const results = (await searchLyrics(q)).slice(0, 20);
    return NextResponse.json({ ok: true, results });
  } catch {
    return NextResponse.json(
      { ok: false, error: "lyrics search unavailable" },
      { status: 502 },
    );
  }
}
