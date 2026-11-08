import { prisma, logError, logWarn, releaseTakeoverCausedBy } from "../db.js";
import { isOwnMid } from "./ownSendLedger.js";

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

const MATCH_WINDOW_MS = 3 * 60_000;
const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export async function healFalseTakeovers(): Promise<number> {
  const rows = await prisma.contact.findMany({
    where: { humanTakenOverAt: { not: null }, humanTakeoverMid: { not: null }, channel: { in: ["INSTAGRAM", "MESSENGER"] } },
    select: { id: true, humanTakeoverMid: true },
    take: 300,
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
      if (!ours && text) {
        const twins = await prisma.message.findMany({
          where: {
            contactId: c.id,
            direction: "OUT",
            byHuman: false,
            mid: { not: mid },
            createdAt: {
              gte: new Date(cause.createdAt.getTime() - MATCH_WINDOW_MS),
              lte: new Date(cause.createdAt.getTime() + MATCH_WINDOW_MS),
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
        logWarn("takeoverHeal", `${c.id}: «передано человеку» снято — это было наше сообщение (${how})`);
      }
    } catch (err) {
      logError("takeoverHeal", err);
    }
  }
  return healed;
}
