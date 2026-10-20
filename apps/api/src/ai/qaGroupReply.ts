import { prisma } from "../db.js";
import { words, score } from "./styleLearning.js";
import type { QaExample } from "@prisma/client";

/**
 * АВТООТВЕТ В УЧЕБНОЙ ГРУППЕ (владелец 26.08.2026) — «безопасный» вариант из
 * трёх предложенных: бот НЕ сочиняет технический совет сам, а повторяет ТОЛЬКО
 * её же прошлый ответ на близко совпавший повторный вопрос. Новый вопрос, для
 * которого в архиве нет близкого совпадения, — бот молчит, отвечает Ширин как
 * обычно. Тот же матчинг (words()/score() из styleLearning.ts), что уже
 * работает для переотправки в Instagram-директе (ai/mediaReuse.ts) — не
 * заводим второй механизм поиска похожего вопроса.
 *
 * ПОРОГ СТРОЖЕ, чем у mediaReuse.ts (MIN_OVERLAP=2): там неверно подобранный
 * пример — неловкость в продающей переписке, здесь — реальный технический
 * совет живым ученицам, ошибка портит десерт и доверие к курсу. 3 разных
 * слова вопроса должны совпасть, а не 2.
 */
const MIN_OVERLAP = 3;
const CANDIDATE_POOL = 400;

function overlapCount(example: { studentText: string }, ask: Set<string>): number {
  const theirs = new Set(words(example.studentText));
  let overlap = 0;
  for (const w of ask) if (theirs.has(w)) overlap += 1;
  return overlap;
}

/** Ищет лучший прошлый ответ Ширин на близко совпавший вопрос — null, если
 *  ничего не прошло порог (обычный, самый частый случай: новый вопрос). */
export async function findQaAnswer(studentText: string): Promise<QaExample | null> {
  const ask = new Set(words(studentText));
  if (ask.size === 0) return null;

  const pool = await prisma.qaExample.findMany({
    where: { ownerText: { not: "" } },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_POOL,
  });
  if (pool.length === 0) return null;

  const askList = [...ask];
  const best = pool
    .map((e) => ({
      e,
      overlap: overlapCount(e, ask),
      s: score({ clientText: e.studentText, ledToSale: false, source: "HISTORY" }, askList),
    }))
    .filter((x) => x.overlap >= MIN_OVERLAP)
    .sort((a, b) => b.overlap - a.overlap || b.s - a.s)[0];
  return best?.e ?? null;
}
