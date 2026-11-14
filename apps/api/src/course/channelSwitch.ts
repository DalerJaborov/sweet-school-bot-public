import type { Contact, Purchase } from "@prisma/client";
import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { createOneTimeInviteLink, revokeInviteLink } from "../telegram.js";
import { sendKind } from "../notify.js";
import { chatIdFor, COURSE_TITLE, type Course } from "../courses.js";
import { canTransferNow, issueMagicLink, recentTransfers, releaseAllDevices, shortCode } from "./access.js";
import { coursePlatformReady } from "./delivery.js";
import { revokeInvitesForContact } from "../links/telegramInvites.js";
import { alertOwnerProblem, removeContactFromGroups } from "../groupExit.js";
import { checkInviteTargets, withPersonLock } from "./groupInvite.js";
import { settleChoiceIfHandedOut } from "./handedOut.js";

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
 *    closeTelegramAccess. Удаляет из группы только перевод «человек просит сайт»
 *    (бот или кнопка владельца) и только ПОСЛЕ доставки сайтовой ссылки; ручная
 *    выдача ссылки владельцем (ownerLink.ts: кнопка, /ссылка, «Новая ссылка»)
 *    лишь отзывает приглашение и ПОМЕЧАЕТ выдачу (markWebIssuedByOwner).
 *    Общий выпуск ссылки (delivery.ts issueCourseLink) ничего не закрывает: иначе
 *    возврат доступа и прочие пути закрывали бы дверь незаметно (ревью PR 64).
 *  - Приглашение в группу тому, кто уже в ней, не выдаётся (его можно переслать
 *    подруге): общая проверка course/groupInvite.ts, как у «Выдать ссылку».
 *  - Карточка владельцу («Перевести») одноразовая и живёт сутки, как карточка
 *    «Разрешить перенос» (phoneChange.ts): старое нажатие не переведёт человека,
 *    чьё положение давно другое.
 */

export type SwitchTarget = "web" | "telegram";
export type SwitchOutcome =
  | "switched"
  | "already"
  | "limit"
  | "revoked"
  | "failed"
  | "unavailable"
  /** Не смогли проверить, в группе ли она: новое приглашение наугад не выдаём. */
  | "unverifiable"
  /** В группе курса она забанена: войти по приглашению не сможет, нужен владелец. */
  | "banned";
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

const CONFIRM: Record<Lang, { web: string; webMany: string; telegram: string; viaOwner: string }> = {
  ru: {
    web:
      "Перевести вас на сайт? Приглашение в группу Telegram перестанет действовать, а место в группе закроется. " +
      "Ссылку на сайт я пришлю сразу. Если согласны, ответьте «да».",
    webMany:
      "Перевести вас на сайт? Приглашения в группы Telegram перестанут действовать, а ваши места в обеих группах закроются. " +
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
    webMany:
      "Шуморо ба сайт гузаронам? Даъватҳои гурӯҳҳои Telegram дигар амал намекунанд ва ҷойҳои шумо дар ҳарду гурӯҳ баста мешаванд. " +
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
    webMany:
      "Move you to the website? The Telegram invitations will stop working and your places in the groups will be closed. Reply yes to confirm.",
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
  const direct = purchases.length > 0 && (isFreeSwitch(contact, purchases) || canTransferNow(contact));
  const many = target === "web" && purchases.length > 1;
  await deliver(
    contact,
    !direct ? CONFIRM[language].viaOwner : many ? CONFIRM[language].webMany : CONFIRM[language][target],
    false,
  );
}

const TEXT: Record<
  Lang,
  {
    web: string;
    telegram: string;
    passed: string;
    approvedWeb: string;
    approvedTelegram: string;
    /** Переход в Telegram, а она уже в группе: нового приглашения нет (его можно было бы переслать). */
    inGroup: string;
    /** Часть курсов: приглашения выше, а в этих группах она уже есть. */
    alsoInGroup: string;
  }
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
    inGroup:
      "Перевела вас в Telegram. Вы уже в группе с уроками: откройте её в Telegram. " +
      "Ссылка на сайт больше не открывает уроки.",
    alsoInGroup: "В этой группе вы уже есть, она открывается в Telegram: ",
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
    inGroup:
      "Шуморо ба Telegram гузарондам. Шумо аллакай дар гурӯҳи дарсҳо ҳастед: онро дар Telegram кушоед. " +
      "Линки сайт дигар дарсҳоро намекушояд.",
    alsoInGroup: "Дар ин гурӯҳ шумо аллакай ҳастед, онро дар Telegram кушоед: ",
  },
  en: {
    web: "I moved you to the website. Here is your link, open it on your phone. The Telegram group invitation no longer works:\n",
    telegram:
      "I moved you to Telegram. Here is the one-time group invitation. The website link no longer opens the lessons:\n",
    passed: "I passed this to Shirin, she will look and reply.",
    approvedWeb: "Your lessons are now on the website. Here is your link:\n",
    approvedTelegram: "Shirin approved the move to Telegram. Here is the group invitation:\n",
    inGroup:
      "I moved you to Telegram. You are already in the lessons group, open it in Telegram. The website link no longer opens the lessons.",
    alsoInGroup: "You are already in this group, open it in Telegram: ",
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

/**
 * Переключение бесплатное: первые сутки после покупки либо ничего ещё не
 * открывала. «Открывала» — это и сайт (firstOpenedAt), и вход в группу: отметка
 * на покупке (joinedAt) ИЛИ на контакте (joinedGroupAt). Старые оплаты и входы
 * по ссылкам из панели отмечены только на контакте — без него вошедшая в группу
 * считалась бы «ничего не открывавшей» и переключалась бы бесплатно без конца
 * (ревью PR 64).
 */
export function isFreeSwitch(
  contact: Pick<Contact, "joinedGroupAt">,
  purchases: Pick<Purchase, "createdAt" | "firstOpenedAt" | "joinedAt">[],
): boolean {
  if (purchases.length === 0) return false;
  const first = Math.min(...purchases.map((p) => p.createdAt.getTime()));
  if (Date.now() - first < FREE_WINDOW_MS) return true;
  if (contact.joinedGroupAt) return false;
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
  opts: { removeFromGroup: boolean },
): Promise<string[]> {
  const problems: string[] = [];
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const invites = await invitesOf(contact, purchases);
  if (botToken) {
    for (const { link, chatIds } of invites) {
      if (!(await revokeInvite(botToken, link, chatIds)))
        problems.push("приглашение в группу отозвать не удалось, отзовите его вручную");
    }
  } else if (invites.length > 0) {
    problems.push("приглашение в группу отозвать не удалось (не задан маркер бота), отзовите его вручную");
  }
  // Ссылки из раздела «Ссылки» панели, выданные этой ученице, — тоже вторая дверь.
  const panelFailed = await revokeInvitesForContact(contact.id).catch((err) => {
    logError("channelSwitch:panelInvites", err);
    return -1;
  });
  if (panelFailed !== 0 && panelFailed !== undefined)
    problems.push("ссылку из раздела «Ссылки» отозвать не удалось, отзовите её там");
  // Из группы убираем ТОЛЬКО в переводе «человек просит сайт» (после доставки сайтовой
  // ссылки). Ручная выдача ссылки владельцем приглашение отзывает, но не выгоняет.
  if (opts.removeFromGroup) {
    const exit = await removeContactFromGroups(contact, purchases, actor);
    problems.push(...exit.problems);
  }
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
  // Одна выдача за раз на человека (общий замок с «Выдать ссылку»): иначе две ссылки сразу.
  return withPersonLock<SwitchOutcome>(contact.id, "failed", () => switchLocked(contact, target, kind, language));
}

async function switchLocked(
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

  const free = isFreeSwitch(fresh, purchases);
  if (kind === "bot") {
    if (!free && !canTransferNow(fresh)) return "limit";
  }
  const text = TEXT[lang(fresh, language)];
  const charge = kind === "bot" && !free;
  const chargeData = charge ? { deviceSwaps: recentTransfers(fresh) + 1, deviceSwapAt: new Date() } : {};

  return target === "web"
    ? toWeb(fresh, purchases, kind, kind === "owner" ? text.approvedWeb : text.web, chargeData)
    : toTelegram(fresh, purchases, kind, text, chargeData);
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
  const problems = await closeTelegramAccess(fresh, purchases, kind, { removeFromGroup: true });

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
  text: (typeof TEXT)[Lang],
  chargeData: Record<string, unknown>,
): Promise<SwitchOutcome> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return "unavailable";

  // Уже в группе — новое приглашение не выдаём: его можно переслать подруге.
  // Проверка общая с «Выдать ссылку» (groupInvite.ts); не смогли проверить — отказ.
  const check = await checkInviteTargets(fresh, purchases, botToken);
  if ("fail" in check) return "unverifiable";
  if (check.banned.length > 0) return "banned";
  // «Уже в группе» без её Telegram-идентификатора — только по старым отметкам входа:
  // проверить, не вышла ли она, нельзя, а сайт сейчас закроется. Наугад не переводим.
  if (!fresh.telegramUserId?.trim() && check.inGroup.length > 0) return "unverifiable";
  // Курс без группы потерялся бы целиком, когда сайт закроется.
  if (check.withoutGroup.length > 0) return "unavailable";

  // Сначала приглашения: их можно сделать, ничего не ломая.
  const created: { purchase: Purchase; link: string }[] = [];
  const dropCreated = async () => {
    for (const c of created) await revokeInvite(botToken, c.link, await purchaseChats([c.purchase])).catch(() => false);
  };
  for (const { purchase, chatId } of check.targets) {
    const link = await createOneTimeInviteLink(botToken, chatId);
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
  const title = (p: Purchase) => COURSE_TITLE[p.course as Course] ?? p.course;
  const many = created.length + check.inGroup.length > 1;
  const inviteLines = created.map((c) => (many ? `${title(c.purchase)}\n${c.link}` : c.link)).join("\n\n");
  const body =
    created.length === 0
      ? text.inGroup
      : (kind === "owner" ? text.approvedTelegram : text.telegram) +
        inviteLines +
        (check.inGroup.length > 0 ? `\n\n${text.alsoInGroup}${check.inGroup.map(title).join(", ")}` : "");
  if (!(await deliver(fresh, body, kind === "owner"))) {
    await restoreLink(fresh, dead);
    await dropCreated();
    return "failed";
  }

  // Приглашение доставлено — сайтовые сессии гасим: удаляются все устройства
  // (а с ними и офлайн-ключи). Заблокированные владельцем не трогаем.
  // Прежние приглашения — только тех покупок, по которым выдано новое: у вошедших
  // в группу старое приглашение уже использовано, а отметка о входе по нему нужна.
  const previous = await invitesOf(
    { ...fresh, inviteLink: created.length > 0 ? fresh.inviteLink : null },
    created.map((c) => c.purchase),
  );
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
      data: {
        courseDeliveryChoice: "telegram",
        ...(created.length > 0 ? { inviteLink: created[created.length - 1].link } : {}),
        ...chargeData,
      },
    });
  });
  // Прежние приглашения (режим «обе ссылки») отзываем: у человека остаётся только новое.
  for (const { link, chatIds } of previous) {
    if (created.some((c) => c.link === link)) continue;
    await revokeInvite(botToken, link, chatIds).catch(() => false);
  }
  logInfo(
    "course:channelSwitch",
    `контакт ${fresh.id}: сайт -> Telegram (${kind}), приглашений ${created.length}, уже в группе ${check.inGroup.length}`,
  );
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
    unverifiable:
      "просит перейти в Telegram, но проверить, есть ли она уже в группе, не получилось — новое приглашение не выдано",
    banned: "просит перейти в Telegram, но в группе курса она заблокирована: разблокируйте её в группе вручную",
  };
  await askOwner(contact, target, why[outcome], outcome !== "revoked" && outcome !== "banned");
  return outcome;
}

function who(contact: Contact): string {
  return [contact.name, contact.username ? `@${contact.username}` : null, `${contact.channel} ${contact.igUserId}`]
    .filter(Boolean)
    .join(", ");
}

/** Карточка «Перевести» живёт сутки и нажимается один раз (как «Разрешить перенос»). */
const APPROVAL_TTL_MS = 24 * 3_600_000;
const approvals = new Map<string, { target: SwitchTarget; until: number }>();
/** Только для тестов. */
export function resetSwitchApprovals(): void {
  approvals.clear();
}

export async function askOwner(
  contact: Contact,
  target: SwitchTarget,
  what: string,
  withButton: boolean,
): Promise<void> {
  const to = target === "web" ? "сайт" : "Telegram";
  const button =
    target === "web" && contact.joinedGroupAt ? "Перевести на сайт и убрать из группы" : `Перевести на ${to}`;
  // Разрешение ставим до отправки (нажатие может прийти раньше ответа Telegram);
  // карточка не ушла (повтор за 12 часов) — возвращаем прежнее как было.
  const prior = approvals.get(contact.id);
  if (withButton) approvals.set(contact.id, { target, until: Date.now() + APPROVAL_TTL_MS });
  const sent = await sendKind(
    // «decision» — невыключаемый вид: карточка с кнопкой не пропадёт, даже если «безопасность» выключена.
    withButton ? "decision" : "security",
    `🔓 ${who(contact)}: ${what}. Хочет: ${to}.` +
      (withButton
        ? " Если это она, нажмите кнопку: прежний способ входа перестанет работать, новая ссылка уйдёт ей в чат."
        : ""),
    {
      dedupeKey: `channel-switch:${target}:${contact.id}`,
      cooldownMs: 12 * 3_600_000,
      ...(withButton
        ? { buttons: [[{ text: button, callback_data: `mn:sw:${contact.id}:${target === "web" ? "w" : "t"}` }]] }
        : {}),
    },
  ).catch((err) => {
    logError("channelSwitch:askOwner", err);
    return 0;
  });
  if (withButton && sent === 0) {
    if (prior) approvals.set(contact.id, prior);
    else approvals.delete(contact.id);
  }
}

/** Хозяйке пишем только когда что-то не вышло; свой ключ, не общий часовой «готово». */
async function reportProblems(contact: Contact, what: string, problems: string[]): Promise<void> {
  if (problems.length === 0) return;
  await alertOwnerProblem(
    `switch:${contact.id}`,
    `${who(contact)}: ${what}, но не всё получилось: ${problems.join("; ")}.`,
  );
}

export type ApproveResult = "ok" | "expired" | "banned" | "failed";

/**
 * Владелец нажал кнопку «Перевести»: месячный лимит его решением снимается.
 * «Уже в группе» — НЕ снимается: приглашение сверх группы можно переслать.
 * Карточка одноразовая и со сроком: второе нажатие и нажатие через сутки — "expired".
 */
export async function approveSwitchByOwner(contactId: string, target: SwitchTarget): Promise<ApproveResult> {
  const approval = approvals.get(contactId);
  // Гасим до первого await: два одновременных нажатия не пройдут оба.
  approvals.delete(contactId);
  if (!approval || approval.until < Date.now() || approval.target !== target) return "expired";
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return "failed";
  const outcome = await switchCourseChannel(contact, target, "owner");
  logInfo("course:channelSwitch", `контакт ${contactId}: владелец разрешил переход на ${target}, итог ${outcome}`);
  if (outcome === "switched" || outcome === "already") return "ok";
  if (outcome === "banned") return "banned";
  // Сбой отправки или проверки — карточка снова действует до своего срока (как в phoneChange.ts).
  if (outcome === "failed" || outcome === "unverifiable" || outcome === "unavailable")
    approvals.set(contactId, approval);
  return "failed";
}

/**
 * ВЛАДЕЛЕЦ САМ ВЫДАЛ ССЫЛКУ НА САЙТ (ownerLink.ts: кнопка «Выдать ссылку → на сайт»,
 * /ссылка в боте, «Новая ссылка» в панели) — ПОМЕТИТЬ выдачу, чтобы правило
 * «одна ссылка» её видело (дыра из #78: ссылка уходила, а в базе — ни следа):
 *  - покупки без ссылки получают эту ссылку (как в grantCourses), ожидание
 *    вопроса «куда прислать» снимается — повторный чек не выдаст вторую дверь;
 *  - выбор человека — «сайт»: напоминание и следующая выдача не пришлют
 *    приглашение в группу поверх сайта;
 *  - неиспользованные приглашения в группу гаснут; из группы НЕ убираем — Ширин
 *    всего лишь выдала ссылку, выгонять ученицу не за что.
 * Курс, которого ещё нет на сайте, не трогаем: его доступ — группа.
 * Возвращает, закрыто ли приглашение (владелец видит это в ответе).
 */
export async function markWebIssuedByOwner(
  contactId: string,
  url: string,
): Promise<{ closedInvite: boolean; problems: string[] }> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { closedInvite: false, problems: [] };
  const purchases = await prisma.purchase.findMany({ where: { contactId, revokedAt: null } });
  const ready = await Promise.all(purchases.map((p) => coursePlatformReady(p.course as Course)));
  const onSite = purchases.filter((_, i) => ready[i]);
  const allOnSite = purchases.length > 0 && onSite.length === purchases.length;

  const hadInvite = isTelegramLink(contact.inviteLink) || purchases.some((p) => isTelegramLink(p.inviteLink));
  const problems =
    allOnSite && (hadInvite || contact.courseDeliveryChoice === "telegram")
      ? await closeTelegramAccess(contact, purchases, "owner", { removeFromGroup: false })
      : [];

  await prisma.$transaction(async (tx) => {
    if (onSite.length > 0) {
      await tx.purchase.updateMany({
        where: { id: { in: onSite.map((p) => p.id) }, revokedAt: null, inviteLink: null },
        data: { inviteLink: url },
      });
    }
    if (allOnSite) {
      await tx.contact.update({
        where: { id: contactId },
        data: { courseDeliveryChoice: "web", ...(hadInvite ? { inviteLink: null } : {}) },
      });
    }
  });
  // Вопрос «куда прислать» по этим покупкам снят, чек закрыт как обслуженный.
  await settleChoiceIfHandedOut(contactId).catch((err) => logError("channelSwitch:settleChoice", err));
  const closedInvite = allOnSite && hadInvite;
  logInfo(
    "course:channelSwitch",
    `контакт ${contactId}: владелец выдал сайт${closedInvite ? ", приглашение в группу закрыто" : ""}`,
  );
  await reportProblems(contact, "сайт выдан, приглашение закрыто", problems);
  return { closedInvite, problems };
}
