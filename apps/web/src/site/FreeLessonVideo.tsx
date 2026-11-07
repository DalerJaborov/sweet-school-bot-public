import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { freeVideoCopy, type Lang } from "./i18n";

/** Loaded only after registration; hls.js is absent from the landing-page entry. */
export default function FreeLessonVideo({ src, title, lang }: { src: string; title: string; lang: Lang }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setFailed(false);
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }
    if (!Hls.isSupported()) {
      setFailed(true);
      return;
    }
    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) setFailed(true);
    });
    return () => hls.destroy();
  }, [src, attempt]);
  return (
    <div>
      <video ref={ref} controls playsInline preload="metadata" aria-label={title} onError={() => setFailed(true)} />
      {failed && (
        <div role="alert">
          <p>{freeVideoCopy[lang].error}</p>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
            {freeVideoCopy[lang].retry}
          </button>
        </div>
      )}
    </div>
  );
}
