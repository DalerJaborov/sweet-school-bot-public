import { prisma, recordOutgoingMessage } from "../db.js";
import { voiceRepliesAllowed } from "./voiceSwitch.js";
import { sendToContact, sendAttachmentToContact } from "../messaging/send.js";
import { words, score } from "./styleLearning.js";
import type { Contact, StyleExample } from "@prisma/client";

/**
 * ФАЗА 2 «МАКСИМАЛЬНОГО ИСПОЛЬЗОВАНИЯ АРХИВА» — переотправка живого
 * голоса/фото/видео Ширин клиенту на похожий вопрос, вместо хода модели.
 *
 * Источник — ТОЛЬКО StyleExample с approvedForReuse: true (одобрено вручную
 * в панели, см. MediaExamplesPage.tsx/Фаза 1). QaExample (учебная группа)
 * сюда сознательно не подключён — решение владельца 24.08.2026, см. план
 * `delightful-launching-reef.md`.
 *
 * Матчинг — тот же score()/words() из styleLearning.ts, что подбирает образцы
 * стиля в промт: не изобретаем второй механизм поиска похожего вопроса.
 *
 * ПОРОГ НАРОЧНО КОНСЕРВАТИВНЫЙ. Разослать её реальный голос не по теме хуже,
 * чем смолчать и отдать вопрос модели — это была прямая причина решения
 * «только одобренное» (см. план). Поэтому шлём, только если хотя бы 2 слова
 * вопроса клиента совпали со словами примера — просто «примерно похоже» не
 * считается. Порог гейта — overlap, а не итоговый score(): ledToSale/TAKEOVER
 * бонусы в score() уместны для РАНЖИРОВАНИЯ кандидатов, что уже прошли гейт,
 * но одни, без совпадения слов, не должны включать отправку файла.
 */
const MIN_OVERLAP = 2;
const CANDIDATE_POOL = 200;

/** Считает УНИКАЛЬНЫЕ слова вопроса, совпавшие с примером — раньше `ask`
 *  проходили как есть, и один и тот же дважды повторённый в вопросе клиента
 *  word (частая живая речь: "курс курс сколько", опечатка-дубль при быстром
 *  наборе) сам по себе набирал MIN_OVERLAP=2 — гейт "минимум 2 РАЗНЫХ слова"
 *  был дырявым до одного слова. */
function overlapCount(example: { clientText: string }, ask: Set<string>): number {
  const theirs = new Set(words(example.clientText));
  let overlap = 0;
  for (const w of ask) if (theirs.has(w)) overlap += 1;
  return overlap;
}

// ГОЛОС ИЗ БИБЛИОТЕКИ — ТОЖЕ ГОЛОСОВОЙ ОТВЕТ. Раньше этот путь рубильник
// НЕ проверял: панель обещала «бот не отвечает голосом», а одобренное живое
// аудио Ширин всё равно уходило клиенту. Правило — в ai/voiceSwitch.ts.

/** Ищет лучший одобренный пример на текущий вопрос клиента — null, если
 *  ничего не прошло порог (обычный, самый частый случай). */
export async function findReusableMedia(clientText: string): Promise<StyleExample | null> {
  const ask = new Set(words(clientText));
  if (ask.size === 0) return null;

  const voiceAllowed = await voiceRepliesAllowed();
  const pool = await prisma.styleExample.findMany({
    // enabled:true — раньше не проверялось вовсе: пример, который владелец
    // выключил в «Стиле» как неудачный (enabled:false), продолжал уходить
    // клиентам, если approvedForReuse у него остался true (это два разных
    // тумблера в двух разных экранах панели — снять один не снимает другой).
    // mediaType:"audio" — исключаем живое аудио, когда голосовые ответы
    // выключены. OR с null: в SQL `mediaType <> 'audio'` отбрасывает NULL,
    // а такие строки sendReusedMedia считает картинками — их терять нельзя.
    where: {
      approvedForReuse: true,
      enabled: true,
      mediaUrl: { not: null },
      ...(voiceAllowed ? {} : { OR: [{ mediaType: null }, { mediaType: { not: "audio" } }] }),
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_POOL,
  });
  if (pool.length === 0) return null;

  const askList = [...ask];
  const best = pool
    .map((e) => ({ e, overlap: overlapCount(e, ask), s: score(e, askList) }))
    .filter((x) => x.overlap >= MIN_OVERLAP)
    .sort((a, b) => b.s - a.s)[0];
  return best?.e ?? null;
}


/**
 * Отправляет найденный пример: сначала её собственный текст (если есть),
 * затем сам файл — тот же приём, что у sendMenuImages/maybeSendTestimonial.
 *
 * Возвращает false, если отправлять нечего: пример оказался голосовым, а
 * голосовые ответы выключены (см. voiceRepliesAllowed). Тогда вызывающий
 * (ai.ts) не молчит, а отдаёт вопрос модели — клиент получает текст.
 */
export async function sendReusedMedia(contact: Contact, example: StyleExample): Promise<boolean> {
  const caption = example.ownerText.trim();
  const type = example.mediaType === "video" ? "video" : example.mediaType === "audio" ? "audio" : example.mediaType === "file" ? "file" : "image";
  // Живое аудио при выключенном голосе не отправляем: рубильник в панели
  // означает «голоса нет вообще», а не «нет синтеза». Подпись отдельно тоже
  // не шлём: у записей из переписки это сырая расшифровка чужого голосового
  // («послушайте», чужое имя) — владелец одобрял запись на слух, не этот
  // текст. Отвечает модель.
  if (type === "audio" && !(await voiceRepliesAllowed())) return false;
  if (caption) {
    const mid = await sendToContact(contact, caption);
    await recordOutgoingMessage(contact.id, caption, mid);
  }
  await sendAttachmentToContact(contact, example.mediaUrl as string, type);
  return true;
}
