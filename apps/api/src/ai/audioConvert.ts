import { spawn } from "node:child_process";

/**
 * Голосовое WhatsApp (ptt) надёжно играется только в ogg/opus. mp3/m4a/aac из
 * ElevenLabs и из загрузок мост отправил бы «как голосовое», но у части клиентов
 * (iPhone) оно не проиграется, а статус остался бы «отправлено» (ревью 08.11.2026).
 * Перекодируем через ffmpeg (он уже стоит на сервере для видео уроков); если ffmpeg
 * недоступен или упал — возвращаем null, и вызывающий оставляет исходный файл.
 */
/**
 * Звук «записано на телефон в комнате»: срезаем студийные края частот, слегка сжимаем
 * громкость и подмешиваем очень тихий фон. Чем студийнее голос, тем быстрее он выдаёт бота.
 */
export const HUMANIZE_FILTER =
  "[0:a]adelay=350|350,highpass=f=140,lowpass=f=6200,equalizer=f=2800:t=q:w=1:g=2," +
  "acompressor=threshold=-20dB:ratio=4:attack=10:release=200,aecho=0.8:0.7:30|55:0.18|0.1[v];" +
  "anoisesrc=color=pink:amplitude=0.012:sample_rate=48000[n1];anoisesrc=color=brown:amplitude=0.02:sample_rate=48000[n2];" +
  "[v][n1][n2]amix=inputs=3:duration=first:normalize=0[o]";

export function toOpusOgg(input: Buffer, timeoutMs = 30_000, humanize = false): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const ff = spawn("ffmpeg", [...["-v", "error", "-i", "pipe:0", "-vn"], ...(humanize ? ["-filter_complex", HUMANIZE_FILTER, "-map", "[o]"] : []), "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-f", "ogg", "pipe:1"], {
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
