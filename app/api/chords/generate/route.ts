import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getChords, setChords } from "@/lib/sessionStore";
import { getLyricsById } from "@/lib/lrclib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Chord generation is a single long model call.
export const maxDuration = 300;

const KEY_OK = /^[A-Za-z0-9-]{1,100}$/;

const SYSTEM = `You are an expert session musician preparing a chord sheet for a live band to sight-read at a karaoke night.

Produce a plain-text chord sheet for the requested song:
- Section headers in brackets: [Intro], [Verse 1], [Chorus], [Bridge], [Solo], [Outro], etc.
- For sung sections, put the chord line ABOVE each lyric line, with each chord name positioned (using spaces) over the syllable where the change lands. Assume a monospace font.
- Use the chords of the original studio recording, in its actual key. Include the intro/outro/instrumental chords.
- If lyrics are provided, align your sheet to those exact lyric lines (same wording and line breaks) — they are what the singers' screens display.
- Output ONLY the chord sheet. No commentary, no markdown fences.

If you are not confident you actually know this specific song's chords, reply with exactly UNKNOWN_SONG and nothing else. A wrong sheet on stage is worse than none.`;

// POST /api/chords/generate {key, title, artist, lrclibId?}
// Drafts a chord sheet with Claude. If no sheet is stored for the song yet,
// the draft is saved immediately (so it's never lost); if one exists, the
// draft is only returned for the host to review/save.
export async function POST(req: NextRequest) {
  let body: { key?: unknown; title?: unknown; artist?: unknown; lrclibId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { key, title, artist, lrclibId } = body;
  if (
    typeof key !== "string" ||
    !KEY_OK.test(key) ||
    typeof title !== "string" ||
    !title.trim() ||
    typeof artist !== "string"
  ) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  // Anchor the sheet to the lyrics the screens actually display.
  let lyrics: string | null = null;
  if (typeof lrclibId === "number" && Number.isInteger(lrclibId) && lrclibId > 0) {
    try {
      const rec = await getLyricsById(lrclibId);
      lyrics = rec?.plainLyrics ?? null;
    } catch {
      /* lyrics are a nice-to-have for generation */
    }
  }

  const prompt =
    `Chord sheet for: "${title.trim()}" by ${artist.trim() || "(unknown artist)"}.` +
    (lyrics
      ? `\n\nThe lyrics as displayed on the singers' screens:\n\n${lyrics.slice(0, 8000)}`
      : "");

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "Chord generation isn't configured — set ANTHROPIC_API_KEY on the server." },
      { status: 501 },
    );
  }

  const client = new Anthropic();
  let text: string;
  try {
    const response = await client.messages.create({
      model: process.env.CHORDS_MODEL || "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { ok: false, error: "The model declined this request." },
        { status: 502 },
      );
    }
    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json(
        { ok: false, error: "ANTHROPIC_API_KEY is not configured on the server." },
        { status: 501 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { ok: false, error: `Claude API error (${err.status ?? "?"}) — try again.` },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Chord generation failed — try again." },
      { status: 502 },
    );
  }

  if (!text || text === "UNKNOWN_SONG" || /^UNKNOWN_SONG\b/.test(text)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Claude doesn't know this song well enough to chart it — paste chords instead.",
      },
      { status: 422 },
    );
  }

  // First sheet for this song: save right away so it's never lost. If the
  // host already has a sheet, don't clobber it — return the draft for review.
  const existing = await getChords(key);
  const saved = !existing;
  if (saved) await setChords(key, text);

  return NextResponse.json({ ok: true, text, saved });
}
