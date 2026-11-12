/** Native Safari does not expose HLS levels; read only our master playlist. */
export function nativeLevels(manifest: string, source: string): { height: number; url: string }[] {
  const lines = manifest.split(/\r?\n/).map((line) => line.trim());
  const levels: { height: number; url: string }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const match = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    const next = lines[i + 1];
    if (!match || !next || next.startsWith("#")) continue;
    try {
      const url = new URL(next, source);
      if (url.origin !== new URL(source).origin) continue;
      // Portrait lessons use their short side as the quality label.
      levels.push({ height: Math.min(Number(match[1]), Number(match[2])), url: url.href });
    } catch { /* Ignore a malformed variant, leave automatic playback available. */ }
  }
  return levels;
}
