import express, { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { env } from "./env.js";

/**
 * Загрузка файлов для шагов воронки (фото/видео меню, рекламные ролики) — чтобы
 * не искать сторонний файлообменник под каждую картинку. Файл ложится в общий том
 * контейнера (/data/uploads, тот же volume, что и SQLite) и отдаётся публично по
 * прямой ссылке — её же потом Meta скачивает при отправке вложения клиенту.
 *
 * ЛИМИТЫ INSTAGRAM. Messenger Platform (тот же движок, что у Instagram-сообщений)
 * не принимает вложения крупнее: фото — 8 МБ, видео/аудио — 25 МБ. Больше —
 * Meta вернёт ошибку уже ПРИ ОТПРАВКЕ клиенту, через минуты после того, как
 * владелец решил, что всё готово. Проверяем на входе, а не постфактум.
 */
const LIMITS_BYTES: Record<string, number> = {
  image: 8 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
};

const MIME_TO_KIND: Record<string, "image" | "video" | "audio" | "file"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/ogg": "audio",
};

/** Тот же каталог использует очередь перепроверки чеков — ей нужно поднять
 *  сохранённую копию картинки с диска. */
export const MEDIA_DIR = "/data/uploads";
const UPLOAD_DIR = MEDIA_DIR;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Расширение на диске — только из этого списка, никогда из originalname
 *  (клиентское поле, как и mimetype). Раньше расширение брали из originalname,
 *  а тип проверяли по mimetype — оба подделываемы НЕЗАВИСИМО друг от друга:
 *  можно было прислать mimetype "image/jpeg" (проходит проверку MIME_TO_KIND
 *  в handleUpload) с originalname "x.html", и файл лёг бы на диск как .html,
 *  отдаваемый публично через /media (express.static) — исполняемый в браузере. */
const SAFE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
};

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = SAFE_EXT_BY_MIME[file.mimetype] ?? ".bin";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// Общий потолок на уровне multer — самый широкий из лимитов (видео); точная
// проверка по типу файла идёт в handleUpload, после того как известен mimetype.
export const upload = multer({ storage, limits: { fileSize: LIMITS_BYTES.video } });

/**
 * Два роутера нарочно. Отдача файла (/media/*) обязана быть публичной — сервер
 * Meta заходит по прямой ссылке без пароля. Сама загрузка — наоборот, требует
 * входа в панель, поэтому `handleUpload` не регистрирует свой маршрут сам, а
 * монтируется в admin.ts, где уже стоит проверка токена.
 */
export const mediaRouter = Router();
mediaRouter.use("/media", (_req, res, next) => {
  // Файлы иммутабельны (случайное имя на каждую загрузку) — можно кешировать вечно.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  next();
});
mediaRouter.use("/media", express.static(UPLOAD_DIR));

/**
 * Копия присланного чека у нас на диске — чтобы показать её владельцу в Telegram
 * и оставить в журнале «Чеки». Ссылка Instagram живёт недолго и требует маркера,
 * а Telegram скачивает картинку сам, по публичному адресу.
 */
export function saveReceiptImage(buffer: Buffer, mimeType: string): string | null {
  if (!env.publicBaseUrl) return null;
  const ext = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
  const name = `${crypto.randomUUID()}${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
    return `${env.publicBaseUrl}/media/${name}`;
  } catch {
    return null;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac",
};

/**
 * Своя копия голосового/фото/видео ХОЗЯЙКИ (не клиента — см. ai/ownerMedia.ts) —
 * ссылка Instagram на её вложение живёт недолго, а этот файл нужен НАВСЕГДА:
 * если пример когда-нибудь одобрят к переотправке, слать клиенту будем именно
 * эту копию. Тот же каталог и тот же принцип, что у saveReceiptImage, но не
 * привязан к типу «картинка» — сюда же ложится аудио и видео.
 */
export function saveOwnerMedia(buffer: Buffer, mimeType: string): string | null {
  if (!env.publicBaseUrl) return null;
  const ext = EXT_BY_MIME[mimeType] ?? "";
  const name = `${crypto.randomUUID()}${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
    return `${env.publicBaseUrl}/media/${name}`;
  } catch {
    return null;
  }
}

export function handleUpload(req: express.Request, res: express.Response): void {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Файл не пришёл" });
    return;
  }
  const kind = MIME_TO_KIND[file.mimetype];
  if (!kind) {
    fs.unlink(file.path, () => {});
    res.status(400).json({ error: `Такой тип файла не поддерживает Instagram (${file.mimetype})` });
    return;
  }
  const limit = LIMITS_BYTES[kind];
  if (file.size > limit) {
    fs.unlink(file.path, () => {});
    res.status(400).json({
      error: `Файл слишком большой для Instagram: ${Math.round(file.size / 1_000_000)} МБ, а лимит для ${kind === "image" ? "фото" : "видео"} — ${Math.round(limit / 1_000_000)} МБ`,
    });
    return;
  }
  if (!env.publicBaseUrl) {
    fs.unlink(file.path, () => {});
    res.status(500).json({ error: "PUBLIC_BASE_URL не задан на сервере — загрузку файлов настроить некому" });
    return;
  }
  res.json({ url: `${env.publicBaseUrl}/media/${path.basename(file.path)}`, kind });
}
