import { storageConfig, getObject, presignGet } from "../storage/s3.js";
import type { Lesson } from "@prisma/client";

/**
 * ВЫДАЧА МАНИФЕСТОВ HLS.
 *
 * Сегменты лежат в бакете и раздаются CDN напрямую — гнать восемь гигабайт
 * видео через VPS школы было бы и дорого, и медленно. Но отдавать плееру
 * готовый манифест из бакета нельзя: в нём относительные пути, по которым
 * сегменты качал бы кто угодно.
 *
 * Поэтому манифест проходит через нас и переписывается:
 *  • пути сегментов → подписанные ссылки на бакет со сроком жизни 5 минут;
 *  • адрес ключа шифрования → наш эндпоинт, который проверит устройство.
 *
 * Сам манифест крошечный (килобайты), так что нагрузки на сервер это не даёт.
 */

/** Сколько живёт подписанная ссылка на сегмент. Пять минут: больше, чем нужно
 *  плееру на загрузку, и меньше, чем нужно человеку, чтобы куда-то её передать. */
const SEGMENT_TTL_SEC = 300;

/** Строки манифеста, которые нас не касаются, проходят как есть. */
function isComment(line: string): boolean {
  return line.startsWith("#");
}

/**
 * Мастер-плейлист: список качеств. Ссылки на дорожки ведём на себя, чтобы при
 * запросе конкретного качества снова проверить доступ.
 */
export async function masterManifest(lesson: Lesson, apiBase: string): Promise<string | null> {
  const cfg = await storageConfig();
  if (!cfg || !lesson.hlsPath) return null;
  const raw = await getObject(cfg, lesson.hlsPath);
  if (!raw) return null;

  return raw
    .toString("utf8")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || isComment(trimmed)) return line;
      // ffmpeg пишет пути вида "720p/index.m3u8" — берём имя дорожки.
      const name = trimmed.split("/")[0];
      return `${apiBase}/lessons/${lesson.id}/variant/${encodeURIComponent(name)}`;
    })
    .join("\n");
}

/**
 * Плейлист одного качества: сегменты и ключ.
 *
 * `#EXT-X-KEY` в исходнике уже указывает на наш адрес (его подставил ffmpeg при
 * транскодинге), но переписываем повторно — так манифест остаётся правильным,
 * даже если у школы сменится домен.
 */
export async function variantManifest(
  lesson: Lesson,
  variant: string,
  apiBase: string,
  now = new Date()
): Promise<string | null> {
  const cfg = await storageConfig();
  if (!cfg || !lesson.hlsPath) return null;

  // Имя дорожки приходит из адреса — пускаем только то, что реально есть в
  // мастер-плейлисте, иначе это путь к произвольному объекту в бакете.
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(variant)) return null;

  const prefix = lesson.hlsPath.replace(/\/master\.m3u8$/, "");
  const raw = await getObject(cfg, `${prefix}/${variant}/index.m3u8`);
  if (!raw) return null;

  const keyUri = `${apiBase}/lessons/${lesson.id}/key`;
  return raw
    .toString("utf8")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#EXT-X-KEY")) {
        return trimmed.replace(/URI="[^"]*"/, `URI="${keyUri}"`);
      }
      if (isComment(trimmed)) return line;
      // Остальное — имя файла сегмента.
      return presignGet(cfg, `${prefix}/${variant}/${trimmed}`, SEGMENT_TTL_SEC, now);
    })
    .join("\n");
}

/**
 * Список сегментов дорожки для офлайн-загрузки: телефон качает их в своё
 * хранилище одним заходом. Отдаём подписанные ссылки той же длительности —
 * загрузка идёт сразу, а не откладывается.
 */
export async function offlineSegmentList(
  lesson: Lesson,
  variant: string,
  now = new Date()
): Promise<{ urls: string[]; keyPath: string } | null> {
  const cfg = await storageConfig();
  if (!cfg || !lesson.hlsPath) return null;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(variant)) return null;

  const prefix = lesson.hlsPath.replace(/\/master\.m3u8$/, "");
  const raw = await getObject(cfg, `${prefix}/${variant}/index.m3u8`);
  if (!raw) return null;

  const urls = raw
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isComment(l))
    .map((name) => presignGet(cfg, `${prefix}/${variant}/${name}`, SEGMENT_TTL_SEC, now));

  return { urls, keyPath: `${prefix}/${variant}/index.m3u8` };
}
