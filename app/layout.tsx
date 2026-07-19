import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lighthaven Singalong",
  description:
    "Live karaoke at Lighthaven: synced lyric screens for any song, driven by the host desk.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lyrics display is meant to be looked at, not pinch-zoomed mid-song.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
