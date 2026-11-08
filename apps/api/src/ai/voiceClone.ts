import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { getSetting, setSetting, logInfo } from "../db.js";
import { notifyOwnerDirect } from "../systemAlerts.js";
import { toOpusOgg } from "./audioConvert.js";

/**
 * ОЗВУЧКА ГОЛОСОМ ШИРИН (ElevenLabs). Ширин лично дала согласие 08.11.2026
 * на клонирование голоса, манеры и смеха, чтобы оживить бота.
 *
 * ГРАНИЦЫ (решение по безопасности, не обходить):
 *  - выключено по умолчанию: нужен ключ в .env И настройка voiceCloneEnabled=true;
 *  - бот сам озвучку клиентам НЕ шлёт: текст озвучивает человек в панели, слушает
 *    и только потом одобряет файл (см. mediaLibrary.ts) — в живые ответы попадает
 *    лишь одобренное, как и с настоящими голосовыми;
 *  - длина текста ограничена: короткая живая реплика, а не лекция;
 *  - каждый вызов пишется в журнал (длина, не текст ключа).
 */
export const MAX_VOICE_TEXT = 700;

export class VoiceCloneError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function voiceConfigured(): boolean {
  return Boolean(env.elevenLabsKey && env.elevenLabsVoiceId);
}

export async function voiceEnabled(): Promise<boolean> {
  return voiceConfigured() && (await getSetting("voiceCloneEnabled")) === "true";
}

const VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true };
const MEDIA_DIR = "/data/uploads";
export const DEFAULT_MONTHLY_CAP_USD = 20;
/** Цена, присланная владельцем (ElevenLabs Business, v4: $0.08 за 1000 знаков; не проверена на официальной странице). Меняется настройкой voicePricePer1kUsd. */
export const DEFAULT_PRICE_PER_1K_USD = 0.08;

export function normalizeVoiceText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Ключ кеша: тот же текст + голос + модель + настройки = тот же файл, повторно не платим. */
export function voiceCacheKey(text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([normalizeVoiceText(text), env.elevenLabsVoiceId, env.elevenLabsModel, VOICE_SETTINGS]))
    .digest("hex")
    .slice(0, 32);
}

const monthKey = (now: Date) => now.toISOString().slice(0, 7);

async function numberSetting(key: string, fallback: number): Promise<number> {
  const n = Number((await getSetting(key))?.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Потрачено знаков в этом месяце (настройка voiceSpend вида «2026-11|1234»). */
export async function voiceSpentChars(now = new Date()): Promise<number> {
  const [m, c] = ((await getSetting("voiceSpend")) ?? "").split("|");
  return m === monthKey(now) ? Number(c) || 0 : 0;
}

/**
 * Потолок трат проверяется до обращения в ElevenLabs. При превышении — отказ;
 * при 80% — одно предупреждение в месяц, ТОЛЬКО владельцу (notifyOwnerDirect).
 */
async function chargeOrRefuse(chars: number, now = new Date()): Promise<void> {
  const cap = await numberSetting("voiceMonthlyCapUsd", DEFAULT_MONTHLY_CAP_USD);
  const price = await numberSetting("voicePricePer1kUsd", DEFAULT_PRICE_PER_1K_USD);
  const spent = await voiceSpentChars(now);
  const after = spent + chars;
  const costAfter = (after / 1000) * price;
  if (costAfter > cap) {
    await notifyOwnerDirect(
      `Озвучка остановлена: потолок $${cap} в месяц достигнут (потрачено ~$${((spent / 1000) * price).toFixed(2)}). Поднять можно в настройках (voiceMonthlyCapUsd).`,
      { dedupeKey: `voice-cap-${monthKey(now)}`, cooldownMs: 24 * 3600_000 },
    );
    throw new VoiceCloneError("Месячный потолок трат на озвучку достигнут", 429);
  }
  await setSetting("voiceSpend", `${monthKey(now)}|${after}`);
  if (costAfter >= cap * 0.8 && (await getSetting("voiceAlertMonth")) !== monthKey(now)) {
    await setSetting("voiceAlertMonth", monthKey(now));
    await notifyOwnerDirect(`Озвучка: потрачено ~$${costAfter.toFixed(2)} из $${cap} в этом месяце (80%).`);
  }
}

export type SynthResult = { url: string; cached: boolean };

/**
 * Озвучка с кешем на диске: если такой текст этим голосом уже озвучивали, отдаём
 * готовый файл бесплатно. Новая генерация проходит проверку потолка трат.
 */
export async function synthesizeToFile(rawText: string): Promise<SynthResult> {
  const text = rawText.trim();
  if (!text) throw new VoiceCloneError("Пустой текст");
  if (text.length > MAX_VOICE_TEXT) throw new VoiceCloneError(`Слишком длинно: максимум ${MAX_VOICE_TEXT} знаков`);
  if (!voiceConfigured())
    throw new VoiceCloneError("Голос Ширин не настроен: нет ключа ElevenLabs или номера голоса", 503);
  if ((await getSetting("voiceCloneEnabled")) !== "true")
    throw new VoiceCloneError("Озвучка выключена в настройках", 403);
  if (!env.publicBaseUrl) throw new VoiceCloneError("Не задан PUBLIC_BASE_URL", 500);

  const key = voiceCacheKey(text);
  for (const ext of ["ogg", "mp3"]) {
    if (fs.existsSync(path.join(MEDIA_DIR, `tts-${key}.${ext}`)))
      return { url: `${env.publicBaseUrl}/media/tts-${key}.${ext}`, cached: true };
  }

  await chargeOrRefuse(text.length);
  const mp3 = await synthesizeSpeech(text);
  // ogg/opus - формат, который WhatsApp стабильно играет как голосовое; нет ffmpeg - остаётся mp3.
  const opus = await toOpusOgg(mp3);
  const name = `tts-${key}.${opus ? "ogg" : "mp3"}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), opus ?? mp3);
  return { url: `${env.publicBaseUrl}/media/${name}`, cached: false };
}

export async function synthesizeSpeech(rawText: string): Promise<Buffer> {
  const text = rawText.trim();
  if (!text) throw new VoiceCloneError("Пустой текст");
  if (text.length > MAX_VOICE_TEXT) throw new VoiceCloneError(`Слишком длинно: максимум ${MAX_VOICE_TEXT} знаков`);
  if (!voiceConfigured())
    throw new VoiceCloneError("Голос Ширин не настроен: нет ключа ElevenLabs или номера голоса", 503);
  if ((await getSetting("voiceCloneEnabled")) !== "true")
    throw new VoiceCloneError("Озвучка выключена в настройках", 403);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.elevenLabsVoiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: env.elevenLabsModel,
        voice_settings: VOICE_SETTINGS,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    // Тело ответа не пишем в ошибку целиком: там может быть эхо запроса.
    throw new VoiceCloneError(`ElevenLabs ответил ${res.status}`, 502);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000 || audio.length > 8 * 1024 * 1024)
    throw new VoiceCloneError("ElevenLabs вернул неожиданный файл", 502);
  logInfo("voiceClone", `озвучено ${text.length} знаков, файл ${audio.length} байт`);
  return audio;
}
