import { prisma, logError, logWarn, releaseTakeoverCausedBy } from "../db.js";
import { isOwnMid } from "./ownSendLedger.js";
import { queuePendingAiReply } from "../aiReplyRetry.js";

/**
 * САМОЛЕЧЕНИЕ ЛОЖНОГО «ПЕРЕДАНО ЧЕЛОВЕКУ».
 *
 * handleEcho ставит contact.humanTakenOverAt, когда видит исходящее сообщение, чьего
 * mid нет в базе. Журнал своих отправок (ownSendLedger.ts) закрывает известные
 * гонки заранее; эта проверка ловит остальное: если сообщение, ставшее причиной
 * паузы, на деле НАШЕ, пауза снимается сама, без владельца.
 *
 * «Наше» значит одно из двух:
 *  1) mid подтверждён журналом отправок (Graph вернул его нам же);
 *  2) в базе есть наша собственная (byHuman=false) исходящая реплика с тем же
 *     текстом в пределах трёх минут — mid мы не записали, но текст совпал.
 * Настоящая хозяйка не пишет клиентке слово в слово то, что за минуту до этого
 * уже написал бот, поэтому ложных снятий тут нет; реальную паузу не трогаем.
 *
 * WhatsApp не трогаем: решение о «человеке» там принимает мост (services/whatsapp-bridge),
 * и сбросить пауза должна через его /takeover/reset, а не только в нашей базе.
 */

/** Эхо нашего сообщения приходит сразу после него: двойник — до причины (минута) и чуть после (10 с). */
const TWIN_BEFORE_MS = 60_000;
const TWIN_AFTER_MS = 10_000;
/** Короткие реплики («Хорошо», «Да») у хозяйки и бота совпадают случайно — их по тексту не сверяем. */
const MIN_TWIN_TEXT = 12;
/** Журнал отправок помнит 10 минут: старше паузы лечить нечем, а выборка не должна расти вечно. */
const HEAL_LOOKBACK_MS = 15 * 60_000;
const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export async function healFalseTakeovers(): Promise<number> {
  const rows = await prisma.contact.findMany({
    where: {
      humanTakenOverAt: { gte: new Date(Date.now() - HEAL_LOOKBACK_MS) },
      humanTakeoverMid: { not: null },
      channel: { in: ["INSTAGRAM", "MESSENGER"] },
    },
    select: { id: true, humanTakeoverMid: true },
    orderBy: { humanTakenOverAt: "desc" },
    take: 100,
  });
  let healed = 0;
  for (const c of rows) {
    const mid = c.humanTakeoverMid as string;
    try {
      const cause = await prisma.message.findUnique({ where: { mid } });
      if (!cause || !cause.byHuman || cause.direction !== "OUT") continue;
      let ours = isOwnMid(mid);
      let how = "mid подтверждён журналом отправок";
      const text = norm(cause.text);
      if (!ours && text.length >= MIN_TWIN_TEXT) {
        const twins = await prisma.message.findMany({
          where: {
            contactId: c.id,
            direction: "OUT",
            byHuman: false,
            mid: { not: mid },
            createdAt: {
              gte: new Date(cause.createdAt.getTime() - TWIN_BEFORE_MS),
              lte: new Date(cause.createdAt.getTime() + TWIN_AFTER_MS),
            },
          },
          select: { text: true },
          take: 20,
        });
        if (twins.some((m) => norm(m.text) === text)) {
          ours = true;
          how = "тот же текст уже отправил бот";
        }
      }
      if (!ours) continue;
      await prisma.message.update({ where: { mid }, data: { byHuman: false } });
      if (await releaseTakeoverCausedBy(c.id, mid)) {
        healed += 1;
        // Сообщение клиента, пришедшее во время ложной паузы, осталось без ответа: отдаём этот ход боту
        // через очередь повторов (aiReplyRetry.ts) — она сама проверит, что хозяйка не ответила.
        const lastIn = await prisma.message.findFirst({
          where: { contactId: c.id, direction: "IN" },
          orderBy: { createdAt: "desc" },
          select: { text: true, createdAt: true },
        });
        if (lastIn?.text && lastIn.createdAt >= cause.createdAt) {
          const answered = await prisma.message.count({ where: { contactId: c.id, direction: "OUT", createdAt: { gt: lastIn.createdAt } } });
          if (!answered) await queuePendingAiReply(c.id, lastIn.text).catch((err) => logError("takeoverHeal:requeue", err));
        }
        logWarn("takeoverHeal", `${c.id}: «передано человеку» снято — это было наше сообщение (${how})`);
      }
    } catch (err) {
      logError("takeoverHeal", err);
    }
  }
  return healed;
}
