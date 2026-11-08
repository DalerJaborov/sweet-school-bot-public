import { spawn } from "node:child_process";

/**
 * Голосовое WhatsApp (ptt) надёжно играется только в ogg/opus. mp3/m4a/aac из
 * ElevenLabs и из загрузок мост отправил бы «как голосовое», но у части клиентов
 * (iPhone) оно не проиграется, а статус остался бы «отправлено» (ревью 08.11.2026).
 * Перекодируем через ffmpeg (он уже стоит на сервере для видео уроков); если ffmpeg
 * недоступен или упал — возвращаем null, и вызывающий оставляет исходный файл.
 */
export function toOpusOgg(input: Buffer, timeoutMs = 30_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const ff = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-f", "ogg", "pipe:1"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        ff.kill("SIGKILL");
        finish(null);
      }, timeoutMs);
      ff.stdout.on("data", (c: Buffer) => chunks.push(c));
      ff.on("error", () => finish(null));
      ff.stdin.on("error", () => {});
      ff.on("close", (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks);
        finish(code === 0 && out.length > 500 ? out : null);
      });
      ff.stdin.end(input);
    } catch {
      finish(null);
    }
  });
}
