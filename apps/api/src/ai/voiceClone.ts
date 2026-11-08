import { env } from "../env.js";
import { getSetting, logInfo } from "../db.js";

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
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function voiceConfigured(): boolean {
  return Boolean(env.elevenLabsKey && env.elevenLabsVoiceId);
}

export async function voiceEnabled(): Promise<boolean> {
  return voiceConfigured() && (await getSetting("voiceCloneEnabled")) === "true";
}

export async function synthesizeSpeech(rawText: string): Promise<Buffer> {
  const text = rawText.trim();
  if (!text) throw new VoiceCloneError("Пустой текст");
  if (text.length > MAX_VOICE_TEXT) throw new VoiceCloneError(`Слишком длинно: максимум ${MAX_VOICE_TEXT} знаков`);
  if (!voiceConfigured()) throw new VoiceCloneError("Голос Ширин не настроен: нет ключа ElevenLabs или номера голоса", 503);
  if ((await getSetting("voiceCloneEnabled")) !== "true") throw new VoiceCloneError("Озвучка выключена в настройках", 403);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.elevenLabsVoiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: env.elevenLabsModel,
        voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!res.ok) {
    // Тело ответа не пишем в ошибку целиком: там может быть эхо запроса.
    throw new VoiceCloneError(`ElevenLabs ответил ${res.status}`, 502);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000 || audio.length > 8 * 1024 * 1024) throw new VoiceCloneError("ElevenLabs вернул неожиданный файл", 502);
  logInfo("voiceClone", `озвучено ${text.length} знаков, файл ${audio.length} байт`);
  return audio;
}
