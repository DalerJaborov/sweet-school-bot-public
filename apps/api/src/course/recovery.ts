import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "../db.js";
import { deviceLimitFor, deviceCountFor } from "./access.js";
import { sendToContact } from "../messaging/send.js";
import { ownerAlertChatIds, sendTelegramMessage } from "../telegram.js";
import { detectClientLanguage, type ClientLanguage } from "../ai/clientLanguage.js";
import { issueCourseLink, deliveryModeFor } from "./delivery.js";
import type { Contact } from "@prisma/client";
import { isBotFrozen } from "../messaging/automation.js";

/**
 * САМОВОССТАНОВЛЕНИЕ ДОСТУПА — «не открывается курс, дайте ссылку заново».
 *
 * ЗАЧЕМ. Ссылка теряется постоянно и по обычным причинам: сменила телефон,
 * почистила переписку, открыла сначала во встроенном браузере Instagram, потом
 * в Chrome и упёрлась в лимит устройств. Раньше каждый такой случай означал
 * письмо владельцу и ожидание. Человек уже заплатил — заставлять его ждать
 * из-за технической мелочи нельзя.
 *
 * ПОЧЕМУ ЭТО БЕЗОПАСНО И ЭТО НЕ ДЫРА.
 * Просьба приходит из ТОГО ЖЕ аккаунта Instagram, который прислал чек и получил
 * курс. Доступ у нас и так привязан к аккаунту (Contact), а не к устройству:
 * устройства — защита от раздачи ссылки подругам, а не от кражи аккаунта.
 * Чтобы обмануть эту проверку, нужно владеть самим аккаунтом покупательницы —
 * а тогда человек и переписку читает, и ссылку в ней видит, и восстановление
 * ему не нужно. То есть автоматическая выдача не открывает НИ ОДНОГО пути,
 * которого не было бы и без неё.
 *
 * ЧТО ПРОВЕРЯЕТСЯ ПЕРЕД ВЫДАЧЕЙ (всё по данным, а не по словам человека):
 *  1. у этого контакта есть покупка;
 *  2. она не отозвана (отозванную бот НЕ восстанавливает сам — её отозвали за
 *     фальшивый чек, и это решение владельца, а не техническая заминка);
 *  3. по контакту есть подтверждённый чек либо покупка заведена владельцем
 *     вручную — то есть деньги реально видели;
 *  4. лимит перевыдач не исчерпан.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Мы не «читаем переписку» и не сверяем текстом, кто
 * что писал: текст подделывается тривиально («я вам платил в прошлом месяце»),
 * а запись о покупке и чеке — нет. Поэтому решение принимается по базе.
 */

/** Сколько раз подряд бот выдаёт ссылку сам. Дальше — к владельцу: три раза за
 *  месяц это уже не «потеряла», а похоже на раздачу знакомым. */
const MAX_AUTO_REISSUES = 3;
const WINDOW_DAYS = 30;

/**
 * Просьба о доступе, по-русски и по-таджикски. Специально широкая: пропустить
 * настоящую просьбу дороже, чем лишний раз выдать ссылку тому, кто уже её имеет
 * (ему просто придёт та же ссылка ещё раз).
 */
const ASKS_ACCESS =
  /(не\s*открыва|не\s*работа|потеря|пропал|не\s*могу\s*(зайти|войти|открыть|посмотр)|нет\s*доступ|新|ссылк[уа].*(нов|ещё|еще|снов|повтор)|(нов|снов|ещё|еще|повтор).*ссылк|смен(ил|ила)\s*телефон|нов(ый|ая)\s*телефон|дарс.*(намекуша|кушода намешавад)|линк.*(нав|дигар|кор намекунад)|кор намекунад|дастрас|надорам.*дарс)/iu;

/** Явная жалоба на лимит устройств — её текст мы сами и пишем в приложении. */
const DEVICE_LIMIT_HINT = /(двух|2)\s*устройств|устройств.*занят|дигар.*дастгоҳ/iu;

const TEXTS: Record<ClientLanguage, { sent: string; pending: string; revoked: string }> = {
  ru: {
    sent: "Вот новая ссылка на ваши уроки 🌸 Откройте её на том телефоне, где будете смотреть:\n",
    pending:
      "Вижу вашу покупку 🌸 Ссылку уже отправляли несколько раз, поэтому передала вопрос Ширин — " +
      "она откроет доступ вручную, это недолго.",
    revoked:
      "По вашей оплате есть вопрос, доступ пока закрыт 🙏 Ширин посмотрит и напишет вам сама.",
  },
  tg: {
    sent: "Мана линки нави дарсҳоятон 🌸 Дар ҳамон телефоне кушоед, ки тамошо мекунед:\n",
    pending:
      "Хариди шуморо дидам 🌸 Линк чанд бор фиристода шуд, барои ҳамин ба Ширин расондам — " +
      "ӯ дастрасиро худаш мекушояд, дер намешавад.",
    revoked: "Оид ба пардохти шумо савол ҳаст, дастрасӣ ҳоло пӯшида 🙏 Ширин месанҷад ва худаш менависад.",
  },
  en: {
    sent: "Here is a fresh link to your lessons 🌸 Open it on the phone you will watch on:\n",
    pending: "I can see your purchase. The link was sent several times already, so I passed this to Shirin.",
    revoked: "There is a question about your payment, access is on hold. Shirin will check and write to you.",
  },
};

export type RecoveryResult =
  | { handled: false }
  | { handled: true; outcome: "reissued" | "escalated" | "revoked" };

/** Похоже ли сообщение на просьбу вернуть доступ. */
export function looksLikeAccessRequest(text: string): boolean {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.length > 400) return false;
  return ASKS_ACCESS.test(trimmed) || DEVICE_LIMIT_HINT.test(trimmed);
}

/**
 * Основной вход. Возвращает handled=true, если случай разобран здесь и
 * ИИ-консультанту отвечать уже не нужно — иначе он поверх выдачи ссылки скажет
 * что-то своё, и человек получит два разных ответа на один вопрос.
 */
export async function maybeRestoreAccess(contact: Contact, text: string): Promise<RecoveryResult> {
  if (await isBotFrozen()) return { handled: false };
  if (!looksLikeAccessRequest(text)) return { handled: false };

  const purchases = await prisma.purchase.findMany({
    where: { contactId: contact.id },
    orderBy: { createdAt: "desc" },
  });
  // Ничего не покупал — это не наш случай, пусть отвечает консультант: человек
  // мог написать «не работает ссылка» про что угодно.
  if (purchases.length === 0) return { handled: false };

  const language = detectClientLanguage(text);
  const active = purchases.filter((p) => !p.revokedAt);

  // Доступ отозван — восстанавливать сам бот НЕ будет. Это решение владельца,
  // принятое по фальшивому чеку, и отменять его автоматически по одной просьбе
  // означало бы обнулить всю защиту от подделок.
  if (active.length === 0) {
    await reply(contact, TEXTS[language].revoked);
    await tellOwner(contact, "просит доступ, но он ОТОЗВАН — решайте вы", purchases.length, 0);
    return { handled: true, outcome: "revoked" };
  }

  // Деньги должны быть видны в данных: подтверждённый чек или ручная выдача
  // владельцем. Иначе покупка появилась непонятно как, и это повод посмотреть
  // глазами, а не выдавать ссылку.
  const paidProof = await hasPaymentProof(contact.id);
  const reissuesUsed = countRecentReissues(active);

  if (!paidProof || reissuesUsed >= MAX_AUTO_REISSUES) {
    await reply(contact, TEXTS[language].pending);
    await tellOwner(
      contact,
      paidProof ? `просит ссылку ${reissuesUsed + 1}-й раз за ${WINDOW_DAYS} дней` : "просит ссылку, но чека в базе нет",
      active.length,
      reissuesUsed
    );
    return { handled: true, outcome: "escalated" };
  }

  const mode = await deliveryModeFor(contact);
  if (mode === "telegram") {
    // Платформа выключена — ссылку на неё выдавать бессмысленно, этим занимается
    // joinReminder с приглашением в группу. Отдаём случай владельцу.
    await reply(contact, TEXTS[language].pending);
    await tellOwner(contact, "просит доступ, но выдача идёт через Telegram-группу", active.length, reissuesUsed);
    return { handled: true, outcome: "escalated" };
  }

  // Освобождаем место под новый телефон: человек пишет как раз потому, что
  // старое устройство ему больше недоступно. Самое давнее уходит первым.
  // Устройства и ссылка — на человека, поэтому по одному разу, не по курсам.
  if (await isBotFrozen()) return { handled: false };
  await releaseOldestDevice(contact.id);
  if (await isBotFrozen()) return { handled: false };
  const url = await issueCourseLink(contact.id, { automatic: true });
  const links: string[] = url ? [url] : [];
  for (const purchase of active) {
    await prisma.purchase
      .update({
        where: { id: purchase.id },
        data: { linkReissueCount: { increment: 1 }, linkReissuedAt: new Date() },
      })
      .catch((err) => logError("recovery:countReissue", err));
  }

  if (links.length === 0) {
    await reply(contact, TEXTS[language].pending);
    await tellOwner(contact, "просит доступ, но выдать ссылку не вышло", active.length, reissuesUsed);
    return { handled: true, outcome: "escalated" };
  }

  await reply(contact, TEXTS[language].sent + links.join("\n\n"));
  await tellOwner(contact, `бот сам выдал новую ссылку (${reissuesUsed + 1}-я за ${WINDOW_DAYS} дней)`, active.length, reissuesUsed + 1);
  logInfo("course:recovery", `контакт ${contact.id}: выдано ссылок ${links.length}`);
  return { handled: true, outcome: "reissued" };
}

/** Есть ли в данных след реальной оплаты. */
async function hasPaymentProof(contactId: string): Promise<boolean> {
  const approved = await prisma.receiptCheck.count({
    where: { contactId, OR: [{ ownerDecision: "APPROVED" }, { linkSent: true }] },
  });
  if (approved > 0) return true;
  // Владелец мог выдать курс руками, без чека — это тоже законный путь.
  const manual = await prisma.purchase.count({ where: { contactId, source: "MANUAL" } });
  return manual > 0;
}

/** Сколько раз ссылку уже перевыдавали за окно. Считается по самой «активной»
 *  покупке: перевыдача идёт сразу по всем, счётчики у них совпадают. */
function countRecentReissues(purchases: { linkReissueCount: number; linkReissuedAt: Date | null }[]): number {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  return purchases.reduce((max, p) => {
    if (!p.linkReissuedAt || p.linkReissuedAt.getTime() < since) return max;
    return Math.max(max, p.linkReissueCount);
  }, 0);
}

/**
 * Освободить место под новое устройство. Удаляем самое давно не появлявшееся:
 * это либо потерянный телефон, либо браузер, которым больше не пользуются.
 * Заблокированные владельцем не трогаем — их сняли осознанно.
 */
async function releaseOldestDevice(contactId: string): Promise<void> {
  // Лимит и счёт занятых — ТЕ ЖЕ функции, что решают «пускать или нет» в
  // access.ts. Раньше здесь было своё представление (запас 3 и только
  // незаблокированные), и место не освобождалось ровно тогда, когда было
  // нужно.
  const limit = await deviceLimitFor(contactId);
  const used = await deviceCountFor(contactId);
  if (used < limit) return;

  // Освобождаем ровно одно место — самое давно не появлявшееся из
  // НЕзаблокированных: заблокированные считаются занятыми, но сняли их
  // осознанно, и оживлять место за их счёт нельзя.
  const oldest = await prisma.device.findFirst({
    where: { contactId, blockedAt: null },
    orderBy: { lastSeenAt: "asc" },
  });
  if (!oldest) {
    // Все места заняты заблокированными — это уже к владельцу, а не к автомату.
    logError("recovery:releaseDevice", new Error(`контакт ${contactId}: все устройства заблокированы, место не освободить`));
    return;
  }
  await prisma.device.delete({ where: { id: oldest.id } }).catch((err) => logError("recovery:releaseDevice", err));
}

async function reply(contact: Contact, text: string): Promise<void> {
  try {
    const mid = await sendToContact(contact, text);
    await recordOutgoingMessage(contact.id, text, mid);
  } catch (err) {
    logError("recovery:reply", err);
  }
}

/** Владелец видит КАЖДЫЙ случай, даже разобранный ботом: это его деньги, и он
 *  должен замечать закономерности вроде «одна и та же ученица каждую неделю». */
async function tellOwner(contact: Contact, what: string, purchases: number, reissues: number): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await ownerAlertChatIds())[0]; // личный чат владельца, иначе чат сводок (telegram.ts)
  if (!botToken || !chatId) return;
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  await sendTelegramMessage(
    botToken,
    chatId,
    `🔑 ${who}: ${what}\nКурсов куплено: ${purchases}, перевыдач за ${WINDOW_DAYS} дней: ${reissues}`
  ).catch((err) => logError("recovery:tellOwner", err));
}
