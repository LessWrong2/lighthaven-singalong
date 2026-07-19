import Display from "@/components/Display";

// The band-facing screen: same as the main lyrics screen, but when the
// current song has a chord sheet pasted it shows that (auto-scrolled in time)
// instead of the lyrics. No chords -> plain lyrics, same as "/".
export default function ChordsScreenPage() {
  return <Display concert chords />;
}
