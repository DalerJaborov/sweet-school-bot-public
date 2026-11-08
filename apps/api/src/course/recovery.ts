import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "../db.js";
import { handlePhoneChange, isAwaitingProof } from "./phoneChange.js";
import { sendToContact } from "../messaging/send.js";
import { techChatIds, sendTelegramMessage } from "../telegram.js";
import { shouldSendAlert } from "../alertGate.js";
import { detectClientLanguage, type ClientLanguage } from "../ai/clientLanguage.js";
import { issueCourseLink, deliveryModeFor } from "./delivery.js";
import type { Contact } from "@prisma/client";
import { isBotFrozen } from "../messaging/automation.js";
import { parseRecoveryCode, findContactByRecoveryCode } from "./linkCode.js";

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
 * Require an explicit access subject and problem. Playback and recipe questions
 * belong to support, not to token or device management.
 */
const ACCESS_SUBJECT = /(ссылк|доступ|кабинет|курс|урок[иов]*|линк|дастрас|дарс)/iu;
const ACCESS_PROBLEM = /(не\s*открыва|не\s*работа|потеря|пропал|не\s*могу\s*(зайти|войти|открыть)|нет\s*доступ|нов[уюая]+|заново|снова|повтор|намекуша|кушода намешавад|нав|дигар|кор намекунад|надорам)/iu;
const NEW_DEVICE = /(смен(ил|ила)\s*телефон|поменя(л|ла)\s*телефон|нов(ый|ом)\s*телефон|телефони\s*нав|телефон\S*\s*(иваз|нав)|иваз\s*кард)/iu;
const VIDEO_PROBLEM = /(видео|ролик|звук|плеер|буфер|боргир|садо)/iu;

/** Явная жалоба на лимит устройств — её текст мы сами и пишем в приложении. */
const DEVICE_LIMIT_HINT = /(двух|2)\s*устройств|устройств.*занят|дигар.*дастгоҳ/iu;

const TEXTS: Record<ClientLanguage, { sent: string; pending: string; revoked: string; foreign: string }> = {
  ru: {
    foreign:
      "Поняла вас. Это другой чат, поэтому ссылку здесь сама выдать не могу. Передала Ширин: " +
      "она проверит покупку и откроет доступ.",
    sent: "Вот новая ссылка на ваши уроки 🌸 Откройте её на том телефоне, где будете смотреть:\n",
    pending:
      "Вижу вашу покупку 🌸 Ссылку уже отправляли несколько раз, поэтому передала вопрос Ширин — " +
      "она откроет доступ вручную, это недолго.",
    revoked:
      "По вашей оплате есть вопрос, доступ пока закрыт 🙏 Ширин посмотрит и напишет вам сама.",
  },
  tg: {
    foreign:
      "Фаҳмидам. Ин чати дигар аст, барои ҳамин линкро худам дода наметавонам. Ба Ширин расондам: " +
      "ӯ харидро месанҷад ва дастрасиро мекушояд.",
    sent: "Мана линки нави дарсҳоятон 🌸 Дар ҳамон телефоне кушоед, ки тамошо мекунед:\n",
    pending:
      "Хариди шуморо дидам 🌸 Линк чанд бор фиристода шуд, барои ҳамин ба Ширин расондам — " +
      "ӯ дастрасиро худаш мекушояд, дер намешавад.",
    revoked: "Оид ба пардохти шумо савол ҳаст, дастрасӣ ҳоло пӯшида 🙏 Ширин месанҷад ва худаш менависад.",
  },
  en: {
    foreign: "This is a different chat, so I cannot issue the link here. I passed this to Shirin, she will check the purchase and open access.",
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
  // Код покупательницы из готового сообщения страницы курса — сам по себе просьба.
  return parseRecoveryCode(trimmed) !== null || DEVICE_LIMIT_HINT.test(trimmed) || NEW_DEVICE.test(trimmed) ||
    (!VIDEO_PROBLEM.test(trimmed) && ACCESS_SUBJECT.test(trimmed) && ACCESS_PROBLEM.test(trimmed));
}

/**
 * Основной вход. Возвращает handled=true, если случай разобран здесь и
 * ИИ-консультанту отвечать уже не нужно — иначе он поверх выдачи ссылки скажет
 * что-то своё, и человек получит два разных ответа на один вопрос.
 */
export async function maybeRestoreAccess(
  contact: Contact,
  text: string,
  imageHashes: string[] = []
): Promise<RecoveryResult> {
  if (await isBotFrozen()) return { handled: false };
  // Бот уже просил доказательство смены телефона: код, картинка или имя с номером — продолжение.
  const waiting = isAwaitingProof(contact.id) && (parseRecoveryCode(text) !== null || imageHashes.length > 0 || /\d{9}/.test(text.replace(/\D+/g, "")));
  if (!waiting && !looksLikeAccessRequest(text)) return { handled: false };

  // Код из ссылки: покупка могла быть сделана в другом чате. Бот выдаёт ссылку
  // САМ только когда код указывает на ЭТОТ ЖЕ контакт; на чужой — только владельцу.
  const code = parseRecoveryCode(text);
  if (code) {
    const owner = await findContactByRecoveryCode(code).catch((err) => {
      logError("recovery:codeLookup", err);
      return null;
    });
    if (owner && owner.id !== contact.id) return handleForeignCode(contact, owner, text);
  }

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

  // Смена телефона — отдельный путь с доказательством (phoneChange.ts): простая
  // ссылка устройства не снимает, перенос делает только бот и только при
  // совпавших данных, не чаще раза в 30 дней.
  if (waiting || DEVICE_LIMIT_HINT.test(text) || NEW_DEVICE.test(text)) {
    if (!paidProof || (await deliveryModeFor(contact)) === "telegram") {
      await reply(contact, TEXTS[language].pending);
      await tellOwner(contact, paidProof ? "просит сменить телефон, но выдача идёт через Telegram-группу" : "просит сменить телефон, но чека в базе нет", active.length, 0);
      return { handled: true, outcome: "escalated" };
    }
    if (await isBotFrozen()) return { handled: false };
    const outcome = await handlePhoneChange(contact, text, language, imageHashes);
    return { handled: true, outcome: outcome === "changed" ? "reissued" : "escalated" };
  }
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

  if (await isBotFrozen()) return { handled: false };
  const url = await issueCourseLink(contact.id, { automatic: true });
  if (!url || !(await reply(contact, TEXTS[language].sent + url))) {
    await tellOwner(contact, "ссылка НЕ доставлена — нужна ручная помощь; прежняя действующая ссылка сохранена", active.length, reissuesUsed);
    return { handled: true, outcome: "escalated" };
  }
  for (const purchase of active) {
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { linkReissueCount: { increment: 1 }, linkReissuedAt: new Date() },
    }).catch((err) => logError("recovery:countReissue", err));
  }
  await tellOwner(contact, `бот сам выдал ссылку (${reissuesUsed + 1}-я за ${WINDOW_DAYS} дней)`, active.length, reissuesUsed + 1);
  logInfo("course:recovery", `контакт ${contact.id}: ссылка доставлена`);
  return { handled: true, outcome: "reissued" };
}

/**
 * Код указывает на другого покупателя: человек пишет с другого номера/канала.
 * Ссылку не выдаём НИКОГДА (кто угодно мог увидеть код в чужой переписке) —
 * только передаём владельцу, кто покупатель, и он подтверждает одним действием.
 */
async function handleForeignCode(contact: Contact, owner: Contact, text: string): Promise<RecoveryResult> {
  const language = detectClientLanguage(text);
  const purchases = await prisma.purchase.findMany({ where: { contactId: owner.id }, orderBy: { createdAt: "desc" } });
  const active = purchases.filter((p) => !p.revokedAt);
  await reply(contact, TEXTS[language].foreign);

  const courses = purchases
    .map((p) => `${p.course}, куплено ${p.createdAt.toISOString().slice(0, 10)}${p.revokedAt ? " (ДОСТУП ОТОЗВАН)" : ""}`)
    .join("; ");
  const buyer = [owner.name, owner.username ? `@${owner.username}` : null, `${owner.channel} ${owner.igUserId}`]
    .filter(Boolean)
    .join(", ");
  const writer = `${contact.channel} ${contact.username ? `@${contact.username}` : contact.igUserId}`;
  const verdict = purchases.length === 0
    ? "покупок по коду нет"
    : active.length === 0
      ? "покупка ОТОЗВАНА — не открывайте без причины"
      : "покупка действует; если это она, выдайте доступ командой /ссылка на ник покупателя";
  await sendOwnerAlert(
    `recovery-code:${owner.id}:${contact.id}`,
    `🔑 Просят ссылку по коду из ссылки, но пишут с ДРУГОГО чата.
Покупатель: ${buyer}
Курсы: ${courses || "нет"}
` +
      `Пишет: ${writer}
${verdict}
Бот ссылку сам НЕ выдавал.`
  );
  logInfo("course:recovery", `код другого контакта: пишет ${contact.id}, покупатель ${owner.id}`);
  return { handled: true, outcome: "escalated" };
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

async function reply(contact: Contact, text: string): Promise<boolean> {
  try {
    const mid = await sendToContact(contact, text);
    if (!mid) return false;
    await recordOutgoingMessage(contact.id, text, mid);
    return true;
  } catch (err) {
    logError("recovery:reply", err);
    return false;
  }
}

/** Владелец видит КАЖДЫЙ случай, даже разобранный ботом: это его деньги, и он
 *  должен замечать закономерности вроде «одна и та же ученица каждую неделю». */
async function tellOwner(contact: Contact, what: string, purchases: number, reissues: number): Promise<void> {
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  await sendOwnerAlert(
    `recovery:${contact.id}`,
    `🔑 ${who}: ${what}
Курсов куплено: ${purchases}, перевыдач за ${WINDOW_DAYS} дней: ${reissues}`
  );
}

async function sendOwnerAlert(gateKey: string, text: string): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0]; // личный чат владельца, иначе чат сводок (telegram.ts)
  if (!botToken || !chatId) return;
  // Одно и то же — не чаще раза в сутки (08.11.2026).
  if (!(await shouldSendAlert(gateKey, { cooldownMs: 24 * 3_600_000 }))) return;
  await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("recovery:tellOwner", err));
}
