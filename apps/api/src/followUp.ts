import { prisma, logError, getSetting, recordOutgoingMessage } from "./db.js";
import { sendToContact, sendAttachmentToContact } from "./messaging/send.js";

/**
 * Догоняющие сообщения: человек прошёл воронку, посмотрел меню — и пропал. Через
 * несколько часов бот сам напоминает о себе. Это самый дешёвый источник продаж:
 * человек уже интересовался, платить за новый охват не нужно.
 *
 * ОКНО META — 24 ЧАСА. Написать первым можно только в течение суток после
 * последнего сообщения человека. Догоняющее позже 24 часов Meta просто отклонит,
 * поэтому дальние напоминания («через 3 дня») здесь бессмысленны — верхняя
 * граница ниже это стережёт, чтобы не жечь запросы впустую.
 */
const META_WINDOW_HOURS = 24;

/** Кому пора отправить догоняющее — и отправка. Дёргается тем же тиком, что и
 *  разносчик шагов воронки. */
export async function runDueFollowUps(): Promise<void> {
  if ((await getSetting("botFrozen")) === "true") return;
  // ОБЩИЙ РУБИЛЬНИК, по умолчанию ВЫКЛЮЧЕН. Решение владельца 21.08: никаких
  // напоминаний не слать вовсе — даже в пределах суток. Отдельный флаг у каждого
  // догоняющего оставлен, но без этой настройки не сработает ни один: иначе
  // достаточно случайно создать запись в панели, и людям пойдут письма.
  if ((await getSetting("followUpsEnabled")) !== "true") return;

  const followUps = await prisma.followUp.findMany({ where: { enabled: true }, orderBy: { afterHours: "asc" } });
  if (followUps.length === 0) return;

  for (const followUp of followUps) {
    if (followUp.afterHours >= META_WINDOW_HOURS) continue; // Meta не пропустит

    const since = new Date(Date.now() - followUp.afterHours * 3_600_000);
    // Воронка закончилась (DONE/WAITING — человек либо дошёл до конца, либо завис
    // на кнопке), прошло нужное время, человек НЕ оплатил и это не личный контакт.
    const candidates = await prisma.delivery.findMany({
      where: {
        state: { in: ["DONE", "WAITING"] },
        updatedAt: { lte: since },
        contact: { paid: false, personal: false },
      },
      include: { contact: true },
      take: 50,
    });

    for (const delivery of candidates) {
      if ((await getSetting("botFrozen")) === "true") return;
      // Уже слали это догоняющее — второй раз нельзя (уникальность в базе).
      try {
        await prisma.followUpSend.create({
          data: { followUpId: followUp.id, contactId: delivery.contactId },
        });
      } catch {
        continue;
      }

      // Молчит ли бот с этим человеком прямо сейчас (хозяйка ведёт разговор сама).
      if (delivery.contact.humanSilencedUntil && delivery.contact.humanSilencedUntil.getTime() > Date.now()) continue;

      // Окно Meta считается от ПОСЛЕДНЕГО сообщения человека, а не от конца
      // воронки: если он ответил позже, окно шире, если молчал — уже закрыто.
      const lastIncoming = await prisma.message.findFirst({
        where: { contactId: delivery.contactId, direction: "IN" },
        orderBy: { createdAt: "desc" },
      });
      if (!lastIncoming) continue;
      const hoursSinceIncoming = (Date.now() - lastIncoming.createdAt.getTime()) / 3_600_000;
      if (hoursSinceIncoming >= META_WINDOW_HOURS) continue;

      try {
        const mid = await sendToContact(delivery.contact, followUp.text);
        await recordOutgoingMessage(delivery.contactId, followUp.text, mid);
        if (followUp.mediaUrl && followUp.mediaType) {
          await sendAttachmentToContact(
            delivery.contact,
            followUp.mediaUrl,
            followUp.mediaType as "video" | "image" | "file"
          ).catch((err) => logError("followUp:attachment", err));
        }
      } catch (err) {
        logError("followUp:send", err);
      }
    }
  }
}
