import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma, getSetting } from "./db.js";
import { env } from "./env.js";
import { autoCatch } from "./asyncRoute.js";
import { upload, MEDIA_DIR } from "./upload.js";
import { toOpusOgg } from "./ai/audioConvert.js";
import { MAX_VOICE_TEXT, VoiceCloneError, synthesizeToFile, voiceConfigured, voiceEnabled } from "./ai/voiceClone.js";

/**
 * БИБЛИОТЕКА МЕДИА ХОЗЯЙКИ (08.11.2026): фото, видео, PDF и голосовые, которые
 * владелец загружает сам, подписывает и отмечает ключевыми словами. Бот берёт
 * из неё файл на похожий вопрос клиента (ai/mediaReuse.ts) и шлёт его от имени
 * хозяйки — голосовые в WhatsApp уходят настоящим голосовым сообщением.
 *
 * Хранится в той же таблице, что и реальные ответы Ширин (StyleExample,
 * source = LIBRARY): ключевые слова лежат в clientText, подпись — в ownerText,
 * поэтому подбор, одобрение и удаление работают одним и тем же кодом.
 *
 * Лимит 8 МБ — потолок WhatsApp-моста (services/whatsapp-bridge). Больше мост
 * всё равно не отправит, так что отказываем сразу при загрузке, а не при клиенте.
 */
export const LIBRARY_SOURCE = "LIBRARY";
export const LIBRARY_MAX_BYTES = 8 * 1024 * 1024;

export type LibraryKind = "image" | "video" | "audio" | "file";

/** Только то, что мост принимает (bridge: jpeg/png/webp, audio/*, mp4, pdf). */
export function libraryKind(mime: string): LibraryKind | null {
  if (/^image\/(jpeg|png|webp)$/.test(mime)) return "image";
  if (mime === "video/mp4") return "video";
  if (/^audio\/(mpeg|mp4|ogg|aac)$/.test(mime)) return "audio";
  if (mime === "application/pdf") return "file";
  return null;
}

const metaSchema = z.object({
  caption: z.string().trim().max(1000).default(""),
  keywords: z.string().trim().max(500).default(""),
  approved: z.enum(["true", "false"]).default("true"),
});

const synthSchema = z.object({
  text: z.string().trim().min(1).max(MAX_VOICE_TEXT),
  keywords: z.string().trim().max(500).default(""),
});

export const mediaLibraryRouter = autoCatch(Router());

mediaLibraryRouter.get("/admin/media-library/status", async (_req, res) => {
  res.json({
    voiceConfigured: voiceConfigured(),
    voiceEnabled: await voiceEnabled(),
    voiceSwitch: (await getSetting("voiceCloneEnabled")) === "true",
    voiceReplySwitch: (await getSetting("voiceReplyEnabled")) === "true",
    maxVoiceText: MAX_VOICE_TEXT,
  });
});

mediaLibraryRouter.post("/admin/media-library", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Файл не пришёл" });
    return;
  }
  const reject = (error: string) => {
    fs.unlink(file.path, () => {});
    res.status(400).json({ error });
  };
  const kind = libraryKind(file.mimetype);
  if (!kind) return reject("Подходят фото (jpg, png, webp), видео mp4, голосовое (mp3, m4a, ogg) и PDF");
  if (file.size > LIBRARY_MAX_BYTES) return reject("Файл больше 8 МБ — WhatsApp-мост такой не отправит");
  const meta = metaSchema.safeParse(req.body);
  if (!meta.success) return reject("Подпись до 1000 знаков, слова до 500");
  if (!env.publicBaseUrl) return reject("Не задан PUBLIC_BASE_URL — ссылку на файл собрать нельзя");

  // Голос - в ogg/opus, иначе ptt может не проиграться у клиента (ai/audioConvert.ts).
  let storedName = file.filename;
  if (kind === "audio" && !file.filename.endsWith(".ogg")) {
    const opus = await toOpusOgg(fs.readFileSync(file.path));
    if (opus) {
      storedName = file.filename.replace(/\.[^.]+$/, "") + ".ogg";
      fs.writeFileSync(path.join(MEDIA_DIR, storedName), opus);
      fs.unlink(file.path, () => {});
    }
  }
  const row = await prisma.styleExample.create({
    data: {
      clientText: meta.data.keywords,
      ownerText: meta.data.caption,
      source: LIBRARY_SOURCE,
      mediaUrl: `${env.publicBaseUrl}/media/${storedName}`,
      mediaType: kind,
      approvedForReuse: meta.data.approved === "true",
    },
  });
  res.json({ ok: true, id: row.id, mediaType: kind });
});

/**
 * Озвучка текста голосом Ширин. Результат ложится в библиотеку НЕОДОБРЕННЫМ:
 * человек слушает и сам нажимает «Одобрить» — бот сам такой файл не пошлёт.
 */
mediaLibraryRouter.post("/admin/media-library/synthesize", async (req, res) => {
  const parsed = synthSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `Нужен текст до ${MAX_VOICE_TEXT} знаков` });
    return;
  }
  try {
    const { url, cached } = await synthesizeToFile(parsed.data.text);
    const row = await prisma.styleExample.create({
      data: {
        clientText: parsed.data.keywords,
        ownerText: "",
        source: LIBRARY_SOURCE,
        mediaUrl: url,
        mediaType: "audio",
        approvedForReuse: false,
      },
    });
    res.json({ ok: true, id: row.id, mediaUrl: url, cached });
  } catch (err) {
    if (err instanceof VoiceCloneError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
