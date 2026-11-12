import { describe, it, expect } from "vitest";
import { nativeLevels } from "../src/course/player/nativeLevels";
it("native variants retain signed query and reject foreign hosts", () => {
  expect(nativeLevels('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=720x1280\nvariant?signature=abc\n#EXT-X-STREAM-INF:RESOLUTION=480x854\nhttps://evil.test/movie', 'https://school.test/lesson/master')).toEqual([{height:720,url:'https://school.test/lesson/variant?signature=abc'}]);
});
it("malformed and media playlists leave auto as the only option", () => {
  expect(nativeLevels('#EXTM3U\n#EXTINF:6,\nsegment.ts','https://school.test/master')).toEqual([]);
});
