import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { getSetting, setSetting, logInfo } from "../db.js";
import { notifyOwnerDirect } from "../systemAlerts.js";
import { toOpusOgg, type VoiceFormat } from "./audioConvert.js";

/**
 * ОЗВУЧКА ГОЛОСОМ ШИРИН (ElevenLabs). Владелица голоса дала согласие 08.11.2026
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

/** Версия пост-обработки звука: меняем при смене фильтра, чтобы кеш не отдавал старое звучание. */
const VOICE_POST = "v4-natural-1";
/** Семейство модели: у eleven_v4 / eleven_v4_turbo нет ползунков style и speed (ФАКТ: справка ElevenLabs «What is Eleven v4»), только stability и similarity. */
export const isV4 = (model = env.elevenLabsModel) => model.startsWith("eleven_v4");
/**
 * Настройки голоса. Владелец 08.11.2026 вечером: переходим на v4 (turbo или полный), голос должен звучать как
 * живое голосовое в WhatsApp — без ускорения 1.2 (оно читалось «тараторит»). Цифры голосом не читаем (voiceReply.ts).
 * Ползунки можно переопределить через ELEVENLABS_STABILITY / ELEVENLABS_SIMILARITY, подобранные на сайте ElevenLabs.
 */
export function voiceSettingsFor(model = env.elevenLabsModel): Record<string, number | boolean> {
  const stability = env.elevenLabsStability || 0.5;
  const similarity = env.elevenLabsSimilarity || 0.9;
  if (isV4(model)) return { stability, similarity_boost: similarity, use_speaker_boost: true };
  // Прежние настройки v3 (владелец 08.11.2026 днём), но без ускорения: естественный темп.
  return { stability, similarity_boost: env.elevenLabsSimilarity || 0.95, style: 0.4, speed: 1.0, use_speaker_boost: true };
}
/** Закреплённая случайность: одинаковый текст звучит одинаково. */
const VOICE_SEED = 4242;

/**
 * Метка эмоции eleven_v3 (на других моделях её прочитали бы вслух, поэтому только для v3).
 * Ровно ОДНА метка и только в начале ПЕРВОГО куска: проба с тремя метками и меткой посреди фразы
 * звучала чужим голосом (владелец 08.11.2026). Только весёлые/любопытные: грустных, вдохов и усмешек нет.
 * Метка выбирается по тексту (одинаковый текст = одинаковая метка, кеш не ломается).
 */
const OPEN_TAGS = ["[happy]", "[curious]"];
function pick(list: string[], text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return list[h % list.length];
}
export function decorateForV3(chunk: string, index: number, _total: number, model = env.elevenLabsModel, tag = env.elevenLabsTag): string {
  if (index !== 0) return chunk;
  // v4: метка только та, что выбрал владелец на слух (ELEVENLABS_TAG); пусто — чистая речь.
  if (isV4(model)) return tag ? `${tag} ${chunk}` : chunk;
  if (model !== "eleven_v3") return chunk;
  return `${tag || pick(OPEN_TAGS, chunk)} ${chunk}`;
}

const MEDIA_DIR = "/data/uploads";
export const DEFAULT_MONTHLY_CAP_USD = 20;
/** Цена, присланная владельцем (ElevenLabs Business: $0.08 за 1000 знаков для v3/v4; не проверена на официальной странице). Меняется настройкой voicePricePer1kUsd. */
export const DEFAULT_PRICE_PER_1K_USD = 0.08;

/** Один кусок голосом - до ~18 секунд речи (~280 знаков), всего не больше 2 голосовых подряд (владелец 08.11.2026: «не по кускам»). */
export const VOICE_CHUNK_CHARS = 280;
export const VOICE_MAX_CHUNKS = 2;

/**
 * Режет ответ на короткие голосовые по границам предложений (как человек: фраза - пауза - фраза).
 * Слишком длинное предложение режется по запятым/пробелам. Больше VOICE_MAX_CHUNKS - null (отвечаем текстом).
 */
export function splitForVoice(text: string): string[] | null {
  const sentences = text.trim().split(/(?<=[.!?…])\s+/u).filter(Boolean);
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= VOICE_CHUNK_CHARS) { pieces.push(s); continue; }
    let rest = s;
    while (rest.length > VOICE_CHUNK_CHARS) {
      const cut = Math.max(rest.lastIndexOf(", ", VOICE_CHUNK_CHARS), rest.lastIndexOf(" ", VOICE_CHUNK_CHARS));
      const at = cut > 40 ? cut + 1 : VOICE_CHUNK_CHARS;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + 1 + piece.length <= VOICE_CHUNK_CHARS) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks.length > 0 && chunks.length <= VOICE_MAX_CHUNKS ? chunks : null;
}

export function normalizeVoiceText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Ключ кеша: тот же текст + голос + модель + настройки = тот же файл, повторно не платим. */
export function voiceCacheKey(text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([normalizeVoiceText(text), env.elevenLabsVoiceId, env.elevenLabsModel, voiceSettingsFor(), VOICE_POST]))
    .digest("hex")
    .slice(0, 32);
}

const monthKey = (now: Date) => now.toISOString().slice(0, 7);

async function numberSetting(key: string, fallback: number, allowZero = false): Promise<number> {
  const raw = (await getSetting(key))?.trim();
  if (!raw) return fallback;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && (n > 0 || (allowZero && n === 0)) ? n : fallback;
}

// Счётчик трат читается и пишется несколькими async-вызовами: выстраиваем их в очередь.
let chargeQueue: Promise<unknown> = Promise.resolve();

/** Потрачено знаков в этом месяце (настройка voiceSpend вида «2026-11|1234»). */
export async function voiceSpentChars(now = new Date()): Promise<number> {
  const [m, c] = ((await getSetting("voiceSpend")) ?? "").split("|");
  return m === monthKey(now) ? Number(c) || 0 : 0;
}

/**
 * Потолок трат проверяется до обращения в ElevenLabs. При превышении — отказ;
 * при 80% — одно предупреждение в месяц, ТОЛЬКО владельцу (notifyOwnerDirect).
 */
function chargeOrRefuse(chars: number, now = new Date()): Promise<void> {
  const run = chargeQueue.catch(() => {}).then(() => chargeOrRefuseNow(chars, now));
  chargeQueue = run;
  return run;
}

async function chargeOrRefuseNow(chars: number, now: Date): Promise<void> {
  // 0 в настройке потолка = озвучка остановлена полностью.
  const cap = await numberSetting("voiceMonthlyCapUsd", DEFAULT_MONTHLY_CAP_USD, true);
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
export async function synthesizeToFile(rawText: string, format: VoiceFormat = "ogg"): Promise<SynthResult> {
  const text = rawText.trim();
  if (!text) throw new VoiceCloneError("Пустой текст");
  if (text.length > MAX_VOICE_TEXT) throw new VoiceCloneError(`Слишком длинно: максимум ${MAX_VOICE_TEXT} знаков`);
  if (!voiceConfigured())
    throw new VoiceCloneError("Голос Ширин не настроен: нет ключа ElevenLabs или номера голоса", 503);
  if ((await getSetting("voiceCloneEnabled")) !== "true")
    throw new VoiceCloneError("Озвучка выключена в настройках", 403);
  if (!env.publicBaseUrl) throw new VoiceCloneError("Не задан PUBLIC_BASE_URL", 500);

  const key = voiceCacheKey(text);
  if (fs.existsSync(path.join(MEDIA_DIR, `tts-${key}.${format}`)))
    return { url: `${env.publicBaseUrl}/media/tts-${key}.${format}`, cached: true };

  await chargeOrRefuse(text.length);
  const mp3 = await synthesizeSpeech(text);
  // ogg/opus - формат, который WhatsApp стабильно играет как голосовое; нет ffmpeg - остаётся mp3.
  // Только перекодирование в ogg/opus, без шума и фильтров (решение владельца 08.11.2026: чистый голос).
  // mp3 как голосовое НЕ отдаём и не кешируем: на iPhone он не играет, лучше ошибка и ответ текстом.
  const opus = await toOpusOgg(mp3, 30_000, format);
  if (!opus) throw new VoiceCloneError("Не удалось подготовить голосовое (ffmpeg)", 503);
  const name = `tts-${key}.${format}`;
  // Пишем во временный файл и переименовываем: оборванная запись не станет «кешем».
  const target = path.join(MEDIA_DIR, name);
  fs.writeFileSync(`${target}.tmp`, opus);
  fs.renameSync(`${target}.tmp`, target);
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
        seed: VOICE_SEED,
        voice_settings: voiceSettingsFor(),
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
