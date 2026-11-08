import dotenv from "dotenv";
import { logWarn } from "./db.js";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Переменная окружения ${name} не задана (см. .env.example)`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4100),
  jwtSecret: required("JWT_SECRET"),
  adminPassword: required("ADMIN_PASSWORD"),
  /// Прокси до graph.instagram.com — с некоторых серверов напрямую не достучаться.
  /// Пусто — ходим напрямую.
  igProxyBase: process.env.IG_PROXY_BASE ?? "",
  igProxyKey: process.env.IG_PROXY_KEY ?? "",
  /// ElevenLabs: озвучка голосом Ширин (ai/voiceClone.ts). Пусто — функция выключена.
  elevenLabsKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "",
  elevenLabsModel: process.env.ELEVENLABS_MODEL ?? "eleven_v4_turbo",
  /// Публичный адрес самого бота — нужен, чтобы собрать ссылку на загруженный файл
  /// (фото/видео шага воронки), которую сможет скачать сервер Meta.
  /// Без этого медиа-вложения в воронках не работают — Meta не может скачать файл.
  publicBaseUrl: (() => {
    const raw = process.env.PUBLIC_BASE_URL;
    if (!raw) {
      logWarn("startup", "PUBLIC_BASE_URL не задан — загрузка медиа в воронках не будет работать. Задайте в .env (см. .env.example).");
    }
    return (raw ?? "").replace(/\/+$/, "");
  })(),
};
