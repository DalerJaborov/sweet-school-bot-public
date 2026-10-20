import { prisma, logError } from "../db.js";
import { saveOwnerMedia } from "../upload.js";
import { renderQaCard } from "./testimonialCard.js";

/**
 * ИСТОЧНИК B ФАЗЫ 3 («максимальное использование архива») — разовый разбор
 * QaMessage (учебная Telegram-группа): благодарности учениц становятся
 * карточками-черновиками в Testimonial (active:false), Ширин/владелец
 * включает вручную в панели, как и остальные отзывы.
 *
 * БЕЗ ОТДЕЛЬНОГО ВЫЗОВА GEMINI — фильтр по ключевым словам благодарности и
 * минимальной длине, ради экономии (см. план delightful-launching-reef.md):
 * это разовый черновой отбор, окончательное решение всё равно за человеком.
 */

const GRATITUDE_RX = /спасиб|благодар|рахмат|ташаккур/iu;
/** Короче — не благодарность, а одно слово; длиннее — уже не то, что ложится
 *  в маленькую карточку-скриншот (та же граница, что MAX_EXAMPLE_LEN в
 *  styleLearning.ts, но своя: там образец стиля, здесь картинка). */
const MIN_LEN = 15;
const MAX_LEN = 300;

export interface ArchiveImportResult {
  scanned: number;
  matched: number;
  created: number;
}

export async function importArchiveTestimonials(): Promise<ArchiveImportResult> {
  const candidates = await prisma.qaMessage.findMany({
    where: { fromOwner: false, text: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  let matched = 0;
  let created = 0;
  for (const msg of candidates) {
    const text = (msg.text ?? "").trim();
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;
    if (!GRATITUDE_RX.test(text)) continue;
    matched += 1;

    // sourceRef — идемпотентность: повторный запуск на уже разобранном архиве
    // не должен плодить второй черновик того же сообщения.
    const sourceRef = `qa:${msg.id}`;
    const exists = await prisma.testimonial.findUnique({ where: { sourceRef } });
    if (exists) continue;

    try {
      const png = renderQaCard(text, msg.createdAt);
      const imageUrl = saveOwnerMedia(png, "image/png");
      if (!imageUrl) continue; // PUBLIC_BASE_URL не настроен — та же тихая защита, что у остальных saveOwnerMedia
      await prisma.testimonial.create({ data: { imageUrl, active: false, sourceRef } });
      created += 1;
    } catch (err) {
      logError("testimonialImport:archive", err);
    }
  }

  return { scanned: candidates.length, matched, created };
}
