import type { Contact, Purchase } from "@prisma/client";
import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { techChatIds, sendTelegramMessage, createOneTimeInviteLink, revokeInviteLink } from "../telegram.js";
import { shouldSendAlert } from "../alertGate.js";
import { chatIdFor, COURSE_TITLE, type Course } from "../courses.js";
import { canTransferNow, issueMagicLink, recentTransfers, releaseAllDevices, shortCode } from "./access.js";
import { coursePlatformReady } from "./delivery.js";
import { revokeInvitesForContact } from "../links/telegramInvites.js";
import { alertOwnerProblem, isInGroup, removeContactFromGroups } from "../groupExit.js";

/**
 * ОДНА ДЕЙСТВУЮЩАЯ ССЫЛКА НА ЧЕЛОВЕКА (владелец 08.11.2026).
 *
 * У человека в любой момент ровно ОДИН способ войти на курс: приглашение в
 * Telegram-группу ЛИБО личная ссылка на сайт. «Не могу зайти в группу, Telegram
 * нет, хочу на сайте» -> приглашение в группу отзывается, выдаётся сайт. И
 * наоборот: «хочу в Telegram» -> сайтовая ссылка и все её сессии аннулируются,
 * выдаётся новое приглашение. Так выданную ссылку нельзя переслать подруге
 * «про запас», а у человека не остаётся двух дверей.
 *
 * ПРАВИЛА, КОТОРЫЕ ЗДЕСЬ ДЕРЖАТСЯ:
 *  - Отозванную покупку переключение не оживляет: работаем только с действующими
 *    (revokedAt = null), без них ответ "revoked" и ничего не меняется.
 *  - Новая ссылка записывается с проверкой «прежняя ещё та же» (как в
 *    phoneChange.ts), уходит человеку, и ТОЛЬКО после доставки закрывается
 *    прежний способ. Не доставилась — прежняя ссылка возвращается, приглашения
 *    отзываются, человек не остаётся ни с чем.
 *  - Первые сутки после покупки и до первого открытия переключение бесплатное;
 *    дальше это тот же месячный счётчик, что и у смены телефона
 *    (Contact.deviceSwaps/deviceSwapAt); повтор — владельцу карточкой.
 *  - Человек просит сайт (в группе он или нет): приглашение отзывается в чате
 *    курса ЭТОЙ покупки, его убирают из группы (groupExit.ts, единственная дверь
 *    удаления), сайт выдаётся сразу. Карточка владельцу — только при сбое.
 *  - Закрывать Telegram-дверь, когда сайт выдан, везде один путь:
 *    closeTelegramAccess (бот, кнопка владельца, /ссылка, «Новая ссылка» в панели).
 */

export type SwitchTarget = "web" | "telegram";
export type SwitchOutcome = "switched" | "already" | "limit" | "revoked" | "failed" | "unavailable";
type Lang = "ru" | "tg" | "en";

const DAY_MS = 86_400_000;
/** Сколько после покупки переключение каналов не считается в месячный счётчик. */
const FREE_WINDOW_MS = DAY_MS;

// -- Распознавание просьбы ----------------------------------------------------

const TG = "(?:telegram|телеграм\\p{L}*|тг)";
const WEB_REQUEST = new RegExp(
  [
    `(?:нет|нету|без)\\s+${TG}`,
    `${TG}\\s+(?:нет|нету|надорам|нест)`,
    `${TG}\\s+не\\s+(?:установлен\\p{L}*|ставится)`,
    `не\\s+(?:могу|получается|выходит)\\s+(?:зайти|войти|вступить)\\s+(?:в|во)\\s+(?:группу|чат|${TG})`,
    `(?:пришлите|дайте|нужна|нужно)\\s+ссылк\\p{L}*\\s+(?:на|через)\\s+сайт\\p{L}*`,
    `(?:хочу|переведите|перенесите)\\s+(?:на|через)\\s+сайт\\p{L}*`,
    `(?:дар|ба)\\s+сайт\\s+(?:мехоҳам|диҳед|гузаронед)`,
    `линк\\p{L}*\\s+(?:ба|дар)\\s+сайт`,
    `ба\\s+гурӯҳ\\s+даромада\\s+наметавонам`,
  ].join("|"),
  "iu",
);
const TELEGRAM_REQUEST = new RegExp(
  [
    `(?:хочу|переведите|перенесите)\\s+(?:в|через|на)\\s+${TG}`,
    `(?:пришлите|дайте|нужно)\\s+(?:ссылк\\p{L}*|приглашени\\p{L}*)\\s+в\\s+(?:группу|${TG})`,
    `(?:хочу|переведите|перенесите)\\s+(?:в|на)\\s+группу`,
    `(?:дар|ба)\\s+${TG}\\s+(?:мехоҳам|диҳед|гузаронед)`,
    `линк\\p{L}*\\s+(?:ба|дар)\\s+(?:гурӯҳ|${TG})`,
  ].join("|"),
  "iu",
);

/** Просьба поменять способ входа. Сначала сайт: «нет телеграма» и «хочу на сайте» — одно и то же. */
export function parseSwitchRequest(text: string): SwitchTarget | null {
  const value = text?.trim();
  if (!value || value.length > 400) return null;
  if (WEB_REQUEST.test(value)) return "web";
  if (TELEGRAM_REQUEST.test(value)) return "telegram";
  return null;
}

// -- Тексты ------------------------------------------------------------------

const CONFIRM: Record<Lang, { web: string; telegram: string; viaOwner: string }> = {
  ru: {
    web:
      "Перевести вас на сайт? Приглашение в группу Telegram перестанет действовать, а место в группе закроется. " +
      "Ссылку на сайт я пришлю сразу. Если согласны, ответьте «да».",
    telegram:
      "Перевести вас в Telegram? Ссылка на сайт перестанет открывать уроки, а приглашение в группу я пришлю сразу. " +
      "Если согласны, ответьте «да».",
    viaOwner:
      "Сменить способ входа сейчас можно только с разрешения Ширин. Передать ей вашу просьбу? " +
      "Если согласны, ответьте «да».",
  },
  tg: {
    web:
      "Шуморо ба сайт гузаронам? Даъвати гурӯҳи Telegram дигар амал намекунад ва ҷои шумо дар гурӯҳ баста мешавад. " +
      "Линки сайтро фавран мефиристам. Агар розӣ бошед, «ҳа» нависед.",
    telegram:
      "Шуморо ба Telegram гузаронам? Линки сайт дигар дарсҳоро намекушояд, даъват ба гурӯҳро фавран мефиристам. " +
      "Агар розӣ бошед, «ҳа» нависед.",
    viaOwner:
      "Тарзи воридшавиро ҳозир танҳо бо иҷозати Ширин иваз кардан мумкин аст. Хоҳиши шуморо ба ӯ расонам? " +
      "Агар розӣ бошед, «ҳа» нависед.",
  },
  en: {
    web: "Move you to the website? The Telegram invitation will stop working and your place in the group will be closed. Reply yes to confirm.",
    telegram: "Move you to Telegram? The website link will stop working. Reply yes to confirm.",
    viaOwner: "Changing the way you log in needs Shirin's permission. Pass your request to her? Reply yes to confirm.",
  },
};

/** Просьба поменять способ входа не выполняется сразу: сначала переспрашиваем (30 минут на ответ «да»). */
const PENDING_MS = 30 * 60_000;
const pending = new Map<string, { target: SwitchTarget; until: number }>();
export function pendingSwitchTarget(contactId: string): SwitchTarget | null {
  const p = pending.get(contactId);
  if (!p) return null;
  if (p.until < Date.now()) {
    pending.delete(contactId);
    return null;
  }
  return p.target;
}
export function clearPendingSwitch(contactId: string): void {
  pending.delete(contactId);
}
export function isYes(text: string): boolean {
  return /^(?:да|ага|хорошо|ок|согласна|согласен|ҳа|ха|бале|розӣ|розиям|yes)[\s.!]*$/iu.test(text.trim());
}

/** Спросить подтверждение. Ничего не меняется, пока человек не ответит «да». */
export async function askSwitchConfirmation(contact: Contact, target: SwitchTarget, language: Lang): Promise<void> {
  pending.set(contact.id, { target, until: Date.now() + PENDING_MS });
  // Обещать «пришлю сразу» можно, только если бот переведёт сам; иначе просьба уйдёт Ширин.
  const purchases = await prisma.purchase.findMany({ where: { contactId: contact.id, revokedAt: null } });
  const direct = purchases.length > 0 && (isFreeSwitch(purchases) || canTransferNow(contact));
  await deliver(contact, direct ? CONFIRM[language][target] : CONFIRM[language].viaOwner, false);
}

const TEXT: Record<
  Lang,
  { web: string; telegram: string; passed: string; approvedWeb: string; approvedTelegram: string }
> = {
  ru: {
    web:
      "Перевела вас на сайт. Вот ваша ссылка на уроки, откройте её на телефоне. " +
      "Приглашение в группу Telegram больше не действует:\n",
    telegram:
      "Перевела вас в Telegram. Вот приглашение в группу с уроками, оно одноразовое. " +
      "Ссылка на сайт больше не открывает уроки:\n",
    passed: "Передала Ширин: она посмотрит и ответит вам.",
    approvedWeb:
      "Теперь ваши уроки на сайте. Вот ваша ссылка, откройте её на телефоне. " +
      "Приглашение в группу Telegram больше не действует:\n",
    approvedTelegram:
      "Ширин разрешила перевод в Telegram. Вот приглашение в группу с уроками, оно одноразовое. " +
      "Ссылка на сайт больше не открывает уроки:\n",
  },
  tg: {
    web:
      "Шуморо ба сайт гузарондам. Мана линки дарсҳоятон, онро дар телефон кушоед. " +
      "Даъвати гурӯҳи Telegram дигар амал намекунад:\n",
    telegram:
      "Шуморо ба Telegram гузарондам. Мана даъват ба гурӯҳи дарсҳо, он яквақта аст. " +
      "Линки сайт дигар дарсҳоро намекушояд:\n",
    passed: "Ба Ширин расондам: ӯ месанҷад ва ба шумо ҷавоб медиҳад.",
    approvedWeb:
      "Акнун дарсҳои шумо дар сайт аст. Мана линки шумо, онро дар телефон кушоед. " +
      "Даъвати гурӯҳи Telegram дигар амал намекунад:\n",
    approvedTelegram:
      "Ширин гузаронидан ба Telegram-ро иҷозат дод. Мана даъват ба гурӯҳи дарсҳо, он яквақта аст. " +
      "Линки сайт дигар дарсҳоро намекушояд:\n",
  },
  en: {
    web: "I moved you to the website. Here is your link, open it on your phone. The Telegram group invitation no longer works:\n",
    telegram:
      "I moved you to Telegram. Here is the one-time group invitation. The website link no longer opens the lessons:\n",
    passed: "I passed this to Shirin, she will look and reply.",
    approvedWeb: "Your lessons are now on the website. Here is your link:\n",
    approvedTelegram: "Shirin approved the move to Telegram. Here is the group invitation:\n",
  },
};

function lang(contact: Contact, given?: Lang): Lang {
  if (given) return given;
  return contact.preferredLanguage === "tg" ? "tg" : "ru";
}

// -- Состояние ---------------------------------------------------------------

const isTelegramLink = (link: string | null | undefined): link is string =>
  Boolean(link && /^https?:\/\/t\.me\//i.test(link));

/** Сайтовая ссылка жива: код выдан и не «мёртвый» (после перехода в Telegram мы ставим дату 1970). */
function webLinkIsLive(contact: Pick<Contact, "accessTokenId" | "accessIssuedAt">): boolean {
  return Boolean(contact.accessTokenId && contact.accessIssuedAt && contact.accessIssuedAt.getTime() > DAY_MS);
}

/** Переключение бесплатное: первые сутки после покупки либо ничего ещё не открывала. */
export function isFreeSwitch(purchases: Pick<Purchase, "createdAt" | "firstOpenedAt" | "joinedAt">[]): boolean {
  if (purchases.length === 0) return false;
  const first = Math.min(...purchases.map((p) => p.createdAt.getTime()));
  if (Date.now() - first < FREE_WINDOW_MS) return true;
  return purchases.every((p) => !p.firstOpenedAt && !p.joinedAt);
}

function alreadyThere(contact: Contact, purchases: Purchase[], target: SwitchTarget): boolean {
  if (contact.courseDeliveryChoice === target) return true;
  if (contact.courseDeliveryChoice) return false;
  const hasInvite = purchases.some((p) => isTelegramLink(p.inviteLink)) || isTelegramLink(contact.inviteLink);
  return target === "web" ? !hasInvite && webLinkIsLive(contact) : hasInvite && !webLinkIsLive(contact);
}

// -- Telegram ----------------------------------------------------------------

/** Чаты групп курсов, купленных этим человеком. */
async function purchaseChats(purchases: Purchase[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const p of purchases) {
    const id = await chatIdFor(p.course as Course);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Отозвать приглашение. Telegram отзывает только в том чате, которому оно
 * принадлежит; чужие группы не трогаем (ревью PR 64): ссылка покупки — в чате
 * её курса, «последняя выданная» (Contact.inviteLink) — в чатах купленных курсов.
 */
async function revokeInvite(botToken: string, link: string, chatIds: string[]): Promise<boolean> {
  let ok = false;
  for (const chatId of chatIds) {
    if (await revokeInviteLink(botToken, chatId, link)) ok = true;
  }
  return ok;
}

/** Приглашения человека (по покупкам и последнее выданное) вместе с чатами, где их отзывать. */
async function invitesOf(contact: Contact, purchases: Purchase[]): Promise<{ link: string; chatIds: string[] }[]> {
  const all = await purchaseChats(purchases);
  const found = new Map<string, string[]>();
  for (const p of purchases) {
    if (!isTelegramLink(p.inviteLink)) continue;
    const own = await chatIdFor(p.course as Course);
    found.set(p.inviteLink, own ? [own] : all);
  }
  if (isTelegramLink(contact.inviteLink) && !found.has(contact.inviteLink)) found.set(contact.inviteLink, all);
  return [...found].map(([link, chatIds]) => ({ link, chatIds }));
}

/**
 * ЗАКРЫТЬ TELEGRAM-ДВЕРЬ — единственное место, где сайт выдан и Telegram
 * закрывается (бот, кнопка владельца, /ссылка, «Новая ссылка» в панели):
 * приглашения отзываются, ссылки из «Ссылок» панели гасятся, человек удаляется
 * из групп своих курсов (groupExit.ts). Возвращает, что не вышло (простыми словами).
 */
export async function closeTelegramAccess(
  contact: Contact,
  purchases: Purchase[],
  actor: "owner" | "bot",
): Promise<string[]> {
  const problems: string[] = [];
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const invites = await invitesOf(contact, purchases);
  if (botToken) {
    for (const { link, chatIds } of invites) {
      if (!(await revokeInvite(botToken, link, chatIds))) problems.push("приглашение в группу отозвать не удалось, отзовите его вручную");
    }
  } else if (invites.length > 0) {
    problems.push("приглашение в группу отозвать не удалось (не задан маркер бота), отзовите его вручную");
  }
  // Ссылки из раздела «Ссылки» панели, выданные этой ученице, — тоже вторая дверь.
  const panelFailed = await revokeInvitesForContact(contact.id).catch((err) => {
    logError("channelSwitch:panelInvites", err);
    return -1;
  });
  if (panelFailed !== 0 && panelFailed !== undefined) problems.push("ссылку из раздела «Ссылки» отозвать не удалось, отзовите её там");
  const exit = await removeContactFromGroups(contact, purchases, actor);
  problems.push(...exit.problems);
  return problems;
}

// -- Отправка человеку --------------------------------------------------------

async function deliver(contact: Contact, text: string, byHuman: boolean): Promise<boolean> {
  try {
    // Нажатие владельца — его решение: пауза бота не мешает.
    const mid = await sendToContact(contact, text, [], byHuman ? { byHuman: true } : {});
    if (!mid) return false;
    await recordOutgoingMessage(contact.id, text, mid);
    return true;
  } catch (err) {
    logError("channelSwitch:send", err);
    return false;
  }
}

// -- Само переключение --------------------------------------------------------

/**
 * Переключить способ входа. kind "bot" соблюдает лимит и правило «уже в группе»
 * (возвращает "limit" / "in_group"), kind "owner" (кнопка) — нет.
 */
export async function switchCourseChannel(
  contact: Contact,
  target: SwitchTarget,
  kind: "bot" | "owner",
  language?: Lang,
): Promise<SwitchOutcome> {
  const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
  if (!fresh || fresh.accessRevokedAt || fresh.spamBlockedAt) return "revoked";
  // Только действующие покупки: отозванную переключение не оживляет.
  const purchases = await prisma.purchase.findMany({ where: { contactId: fresh.id, revokedAt: null } });
  if (purchases.length === 0) return "revoked";
  if (alreadyThere(fresh, purchases, target)) return "already";

  const free = isFreeSwitch(purchases);
  if (kind === "bot") {
    if (!free && !canTransferNow(fresh)) return "limit";
  }
  const text = TEXT[lang(fresh, language)];
  const charge = kind === "bot" && !free;
  const chargeData = charge ? { deviceSwaps: recentTransfers(fresh) + 1, deviceSwapAt: new Date() } : {};

  return target === "web"
    ? toWeb(fresh, purchases, kind, kind === "owner" ? text.approvedWeb : text.web, chargeData)
    : toTelegram(fresh, purchases, kind, kind === "owner" ? text.approvedTelegram : text.telegram, chargeData);
}

/** Записать ссылку с проверкой «прежняя ещё та же». */
async function claimLink(fresh: Contact, accessTokenId: string, accessIssuedAt: Date): Promise<boolean> {
  const claimed = await prisma.contact.updateMany({
    where: {
      id: fresh.id,
      accessTokenId: fresh.accessTokenId ?? null,
      accessIssuedAt: fresh.accessIssuedAt ?? null,
      accessRevokedAt: null,
      spamBlockedAt: null,
    },
    data: { accessTokenId, accessIssuedAt },
  });
  return claimed.count === 1;
}

async function restoreLink(fresh: Contact, current: string): Promise<void> {
  await prisma.contact
    .updateMany({
      where: { id: fresh.id, accessTokenId: current },
      data: { accessTokenId: fresh.accessTokenId ?? null, accessIssuedAt: fresh.accessIssuedAt ?? null },
    })
    .catch((err) => logError("channelSwitch:restoreLink", err));
}

async function toWeb(
  fresh: Contact,
  purchases: Purchase[],
  kind: "bot" | "owner",
  intro: string,
  chargeData: Record<string, unknown>,
): Promise<SwitchOutcome> {
  const ready = await Promise.all(purchases.map((p) => coursePlatformReady(p.course as Course)));
  // Курс без уроков на сайте потерялся бы целиком: переводим, только если готовы ВСЕ купленные.
  if (!ready.every(Boolean)) return "unavailable";
  const { url, jti } = issueMagicLink(fresh.id);
  if (!url.startsWith("http")) return "unavailable";

  if (!(await claimLink(fresh, jti, new Date()))) return "failed";
  if (!(await deliver(fresh, intro + url, kind === "owner"))) {
    await restoreLink(fresh, jti);
    return "failed";
  }

  // Сайт у человека есть — сразу закрываем вторую дверь: приглашения (в чате курса
  // каждой покупки), ссылки панели и место в группе. Одна функция на все пути.
  const problems = await closeTelegramAccess(fresh, purchases, kind);

  // Запись одним куском: либо выбор и ссылки записаны целиком, либо ничего.
  await prisma.$transaction(async (tx) => {
    await tx.contact.update({
      where: { id: fresh.id },
      data: { courseDeliveryChoice: "web", inviteLink: null, ...chargeData },
    });
    // Как в grantCourses: у веб-доставки в Purchase.inviteLink лежит сама ссылка.
    await tx.purchase.updateMany({
      where: { contactId: fresh.id, revokedAt: null },
      data: { inviteLink: url, deliveryAwaitingChoice: false },
    });
  });
  logInfo("course:channelSwitch", `контакт ${fresh.id}: Telegram -> сайт (${kind})`);
  await reportProblems(fresh, "переведена на сайт", problems);
  return "switched";
}

async function toTelegram(
  fresh: Contact,
  purchases: Purchase[],
  kind: "bot" | "owner",
  intro: string,
  chargeData: Record<string, unknown>,
): Promise<SwitchOutcome> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return "unavailable";

  // Сначала приглашения: их можно сделать, ничего не ломая.
  const created: { purchase: Purchase; link: string }[] = [];
  const dropCreated = async () => {
    for (const c of created) await revokeInvite(botToken, c.link, await purchaseChats([c.purchase])).catch(() => false);
  };
  for (const purchase of purchases) {
    const chatId = await chatIdFor(purchase.course as Course);
    const link = chatId ? await createOneTimeInviteLink(botToken, chatId) : null;
    if (!link) {
      await dropCreated();
      return "unavailable";
    }
    created.push({ purchase, link });
  }

  // «Мёртвый» код: старая ссылка и любые угаданные не откроют ничего (дата 1970),
  // а устаревшие JWT-ссылки без кода тоже перестают сходиться с jti.
  const dead = shortCode();
  if (!(await claimLink(fresh, dead, new Date(0)))) {
    await dropCreated();
    return "failed";
  }
  const lines =
    created.length > 1
      ? created.map((c) => `${COURSE_TITLE[c.purchase.course as Course] ?? c.purchase.course}\n${c.link}`).join("\n\n")
      : created[0].link;
  if (!(await deliver(fresh, intro + lines, kind === "owner"))) {
    await restoreLink(fresh, dead);
    await dropCreated();
    return "failed";
  }

  // Приглашение доставлено — сайтовые сессии гасим: удаляются все устройства
  // (а с ними и офлайн-ключи). Заблокированные владельцем не трогаем.
  // Одним куском: устройства удаляются и выбор записывается вместе, иначе остались бы обе двери.
  const previous = await invitesOf(fresh, purchases);
  // Сначала гасим сайтовые сессии: если запись ниже оборвётся, открытым останется только Telegram.
  await releaseAllDevices(fresh.id, kind === "owner" ? "owner" : "bot");
  await prisma.$transaction(async (tx) => {
    for (const c of created) {
      await tx.purchase.update({
        where: { id: c.purchase.id },
        data: { inviteLink: c.link, deliveryAwaitingChoice: false },
      });
    }
    await tx.contact.update({
      where: { id: fresh.id },
      data: { courseDeliveryChoice: "telegram", inviteLink: created[created.length - 1].link, ...chargeData },
    });
  });
  // Прежние приглашения (режим «обе ссылки») отзываем: у человека остаётся только новое.
  for (const { link, chatIds } of previous) await revokeInvite(botToken, link, chatIds).catch(() => false);
  logInfo("course:channelSwitch", `контакт ${fresh.id}: сайт -> Telegram (${kind})`);
  return "switched";
}

// -- Чат: просьба клиентки и карточка владельцу --------------------------------

/**
 * Просьба из чата. "already" означает «менять нечего» — вызывающий (recovery.ts)
 * продолжает обычный путь, здесь ничего не отвечаем. Остальные исходы разобраны
 * полностью.
 */
export async function handleSwitchRequest(
  contact: Contact,
  target: SwitchTarget,
  language: Lang,
): Promise<SwitchOutcome> {
  const outcome = await switchCourseChannel(contact, target, "bot", language);
  if (outcome === "already" || outcome === "switched") return outcome;
  await deliver(contact, TEXT[language].passed, false);
  const why: Record<Exclude<SwitchOutcome, "switched" | "already">, string> = {
    limit: "просит сменить способ входа ещё раз в этом месяце",
    revoked: "просит сменить способ входа, но доступ отозван или покупки нет — решайте вы",
    failed: "просит сменить способ входа, но ссылку отправить не удалось",
    unavailable: "просит сменить способ входа, но нужная ссылка недоступна (группа или курс не настроены)",
  };
  await askOwner(contact, target, why[outcome], outcome !== "revoked");
  return outcome;
}

async function ownerChat(): Promise<{ botToken: string; chatId: string } | null> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0];
  return botToken && chatId ? { botToken, chatId } : null;
}

function who(contact: Contact): string {
  return [contact.name, contact.username ? `@${contact.username}` : null, `${contact.channel} ${contact.igUserId}`]
    .filter(Boolean)
    .join(", ");
}

export async function askOwner(contact: Contact, target: SwitchTarget, what: string, withButton: boolean): Promise<void> {
  const chat = await ownerChat();
  if (!chat) return;
  if (!(await shouldSendAlert(`channel-switch:${target}:${contact.id}`, { cooldownMs: 12 * 3_600_000 }))) return;
  const to = target === "web" ? "сайт" : "Telegram";
  const button =
    target === "web" && contact.joinedGroupAt ? "Перевести на сайт и убрать из группы" : `Перевести на ${to}`;
  await sendTelegramMessage(
    chat.botToken,
    chat.chatId,
    `${who(contact)}: ${what}. Хочет: ${to}.` +
      (withButton
        ? " Если это она, нажмите кнопку: прежний способ входа перестанет работать, новая ссылка уйдёт ей в чат."
        : ""),
    undefined,
    withButton
      ? { inline_keyboard: [[{ text: button, callback_data: `mn:sw:${contact.id}:${target === "web" ? "w" : "t"}` }]] }
      : undefined,
  ).catch((err) => logError("channelSwitch:askOwner", err));
}

/** Хозяйке пишем только когда что-то не вышло; свой ключ, не общий часовой «готово». */
async function reportProblems(contact: Contact, what: string, problems: string[]): Promise<void> {
  if (problems.length === 0) return;
  await alertOwnerProblem(
    `switch:${contact.id}`,
    `${who(contact)}: ${what}, но не всё получилось: ${problems.join("; ")}.`,
  );
}

/** Владелец нажал кнопку «Перевести»: лимит и «уже в группе» его решением снимаются. */
export async function approveSwitchByOwner(contactId: string, target: SwitchTarget): Promise<boolean> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return false;
  const outcome = await switchCourseChannel(contact, target, "owner");
  logInfo("course:channelSwitch", `контакт ${contactId}: владелец разрешил переход на ${target}, итог ${outcome}`);
  return outcome === "switched";
}

/**
 * Владелец сам выдал сайтовую ссылку (/ссылка, «Новая ссылка» в панели) человеку,
 * у которого был Telegram: вторую дверь закрываем тем же путём, что и при
 * переводе (closeTelegramAccess), иначе у человека два способа (инвариант).
 * Вызывается из delivery.issueCourseLink только для явной выдачи владельцем.
 * Возвращает true, если Telegram-дверь была и закрыта (панель предупреждает).
 */
export async function closeTelegramDoor(contactId: string): Promise<boolean> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return false;
  const purchases = await prisma.purchase.findMany({ where: { contactId, revokedAt: null } });
  const hasDoor =
    contact.courseDeliveryChoice === "telegram" ||
    isInGroup(contact, purchases) ||
    isTelegramLink(contact.inviteLink) ||
    purchases.some((p) => isTelegramLink(p.inviteLink));
  if (!hasDoor) return false;
  const problems = await closeTelegramAccess(contact, purchases, "owner");
  await prisma.contact.update({ where: { id: contactId }, data: { courseDeliveryChoice: "web", inviteLink: null } });
  logInfo("course:channelSwitch", `контакт ${contactId}: владелец выдал сайт, Telegram-доступ закрыт`);
  await reportProblems(contact, "сайт выдан", problems);
  return true;
}
