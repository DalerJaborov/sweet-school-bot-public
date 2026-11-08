import { spawn } from "node:child_process";

/**
 * Голосовое WhatsApp (ptt) надёжно играется только в ogg/opus. mp3/m4a/aac из
 * ElevenLabs и из загрузок мост отправил бы «как голосовое», но у части клиентов
 * (iPhone) оно не проиграется, а статус остался бы «отправлено» (ревью 08.11.2026).
 * Перекодируем через ffmpeg (он уже стоит на сервере для видео уроков); если ffmpeg
 * недоступен или упал — возвращаем null, и вызывающий оставляет исходный файл.
 */
/** Только выравнивание громкости. Без шумов и фильтров (решение владельца). */
export const VOICE_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=9";
/**
 * Фильтр с темпом: озвучка бота может идти чуть быстрее (ELEVENLABS_TEMPO, владелец выбирает на слух;
 * прежние 1.3x «тараторили»). Настоящие записи Ширин из панели темп не трогает (tempo = 1).
 */
export type VoiceFx = "none" | "light" | "strong";
/**
 * «Как будто записано на телефон» (владелец 08.11.2026 вечером: «слишком чётко и дикторски, добавь шум и эффект»).
 * light — мягкая обрезка частот, лёгкая компрессия, едва слышный розовый шум; strong — узкая полоса 250–4800 Гц,
 * 16 кГц, коричневый шум громче. Шум подмешивается через filter_complex, поэтому фильтр возвращается отдельно.
 */
const FX_GRAPH: Record<Exclude<VoiceFx, "none">, string> = {
  light: "[v]highpass=f=150,lowpass=f=6500,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=120[w];anoisesrc=color=pink:amplitude=0.0018:d=600[n];[w][n]amix=inputs=2:duration=first:normalize=0[m]",
  strong: "[v]highpass=f=250,lowpass=f=4800,acompressor=threshold=-22dB:ratio=4:attack=5:release=100,aresample=16000[w];anoisesrc=color=brown:amplitude=0.004:d=600,aresample=16000[n];[w][n]amix=inputs=2:duration=first:normalize=0[m]",
};

export function voiceFilter(tempo = 1): string {
  const t = Number.isFinite(tempo) && tempo > 0.5 && tempo < 2 && Math.abs(tempo - 1) > 0.001 ? tempo : 0;
  return t ? `atempo=${t.toFixed(3)},${VOICE_FILTER}` : VOICE_FILTER;
}

/** Аргументы ffmpeg для фильтра: простой -af, либо -filter_complex с подмешанным шумом. */
export function filterArgs(tempo = 1, fx: VoiceFx = "none"): string[] {
  const base = voiceFilter(tempo);
  if (fx === "none" || !FX_GRAPH[fx]) return ["-af", base];
  const tempoPart = base.startsWith("atempo") ? base.split(",")[0] : "anull";
  return ["-filter_complex", `[0:a]${tempoPart}[v];${FX_GRAPH[fx]};[m]${VOICE_FILTER}[out]`, "-map", "[out]"];
}

export type VoiceFormat = "ogg" | "aac";
/** WhatsApp - ogg/opus (настоящее голосовое); Instagram и Messenger принимают aac/m4a/wav/mp4, но не ogg. */
const CODEC_ARGS: Record<VoiceFormat, string[]> = {
  ogg: ["-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-f", "ogg"],
  aac: ["-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "1", "-f", "adts"],
};

export function toOpusOgg(input: Buffer, timeoutMs = 30_000, format: VoiceFormat = "ogg", tempo = 1, fx: VoiceFx = "none"): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const ff = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vn", ...filterArgs(tempo, fx), ...CODEC_ARGS[format], "pipe:1"], {
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
