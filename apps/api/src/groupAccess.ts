import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { ownerAlertChatIds, sendTelegramMessage, createOneTimeInviteLink } from "./telegram.js";
import { sendToContact } from "./messaging/send.js";
import { chatIdFor, COURSE_50, COURSE_70, COURSE_TITLE, type Course } from "./courses.js";
import { deliveryModeFor, issueCourseLink } from "./course/delivery.js";

/**
 * ДОСТУП В ЗАКРЫТЫЕ ГРУППЫ: кто вошёл и как отобрать.
 *
 * Раньше связи между клиентом из Instagram и его аккаунтом в Telegram не было
 * вовсе: бот выдавал одноразовую ссылку — и всё, дальше человек пропадал из виду.
 * Из-за этого нельзя было ни увидеть, дошёл ли он до уроков, ни выгнать того,
 * кто заплатил фальшивым чеком.
 *
 * Связь даёт сам Telegram: когда человек входит по нашей ссылке, приходит
 * событие `chat_member`, и в нём — И его user_id, И та самая ссылка. По ссылке
 * находим клиента, запоминаем user_id. После этого выгнать его можно одной
 * кнопкой.
 */

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

async function call(botToken: string, method: string, body: unknown): Promise<{ ok: boolean; description?: string }> {
  try {
    const res = await fetch(`${API}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    return { ok: Boolean(data.ok), description: data.description };
  } catch (err) {
    logError(`groupAccess:${method}`, err);
    return { ok: false, description: String(err) };
  }
}

/** Обе группы курсов — доступ отбирается сразу из всех: какой именно курс купил
 *  мошенник, в момент отзыва не важно, а искать по одной дольше. */
async function courseChats(): Promise<string[]> {
  const ids = [(await getSetting("telegramChatId50"))?.trim(), (await getSetting("telegramChatId70"))?.trim()];
  return ids.filter((id): id is string => Boolean(id));
}

/** Ссылки, которые владелец рассылает САМ (не через бота) — по одной на строку
 *  в настройке `manualInviteLinks`. Вход по ним не должен пугать «непонятным
 *  входом»: это не слитая ссылка, а обычный ручной канал владельца. */
async function isManualInviteLink(link: string): Promise<boolean> {
  const raw = (await getSetting("manualInviteLinks")) ?? "";
  const known = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return known.includes(link.trim());
}

/** Запоминаем выданную ссылку — по ней потом узнаем вошедшего. */
export async function rememberInviteLink(contactId: string, link: string): Promise<void> {
  await prisma.contact.update({ where: { id: contactId }, data: { inviteLink: link } }).catch((err) =>
    logError("groupAccess:remember", err)
  );
}

/** По chat_id группы говорим, какой это курс — для алерта о непонятном входе.
 *  Похоже на courseChats() выше, но там нужен список обоих для отзыва доступа
 *  сразу из всех, а здесь — назвать ОДНУ конкретную группу, в которую вошли. */
async function courseNameForChat(chatId: number | undefined): Promise<string | null> {
  if (chatId == null) return null;
  const chatIdStr = String(chatId);
  const id50 = (await getSetting("telegramChatId50"))?.trim();
  if (id50 && chatIdStr === id50) return COURSE_TITLE[COURSE_50];
  const id70 = (await getSetting("telegramChatId70"))?.trim();
  if (id70 && chatIdStr === id70) return COURSE_TITLE[COURSE_70];
  const qa = (await getSetting("telegramQaGroupId"))?.trim();
  if (qa && chatIdStr === qa) return "Саволу ҷавоб (группа вопросов)";
  return null;
}

/** id бота — первая часть токена до двоеточия (формат Telegram `123456:ABC…`). */
function botIdFromToken(token: string): string | null {
  const id = token.split(":")[0]?.trim();
  return id && /^\d+$/.test(id) ? id : null;
}

/**
 * Ссылку создал не бот, а живой админ (Ширин из своего Telegram — так она
 * выдаёт доступ тем, кто пишет ей в WhatsApp, куда у бота доступа нет).
 * Такой вход не «слитая ссылка», а её ручной канал: тревогу не поднимаем.
 * Экспортирована для теста.
 */
export function isHumanCreatedLink(update: ChatMemberUpdate, botToken: string): boolean {
  const creator = update.invite_link?.creator?.id;
  if (creator == null) return false;
  const botId = botIdFromToken(botToken);
  return botId != null && String(creator) !== botId;
}

/**
 * НЕОБЪЯСНИМЫЙ ВХОД в закрытую группу: человек оказался внутри, а связать его
 * с клиентом нечем — либо вошёл вовсе без нашей ссылки (обычно значит, что
 * сестра добавила вручную), либо по ссылке, которой нет ни у одного контакта
 * (возможно, слитая — но не обязательно: у Contact.inviteLink живёт только
 * ПОСЛЕДНЯЯ выданная ссылка, старая при повторной покупке перезаписывается).
 * Дальше это решает владелец — бот только сигналит.
 */
async function alertUnexplainedJoin(update: ChatMemberUpdate, link: string | undefined): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;

  // Те же двое получателей, что и в остальных алертах бота (askOwner в ai.ts,
  // maybeSendDailyReport в dailyReport.ts) — сестра и владелец, дубли отсечены.
  const recipients = [
    ...new Set(
      [
        (await getSetting("telegramOwnerChatId"))?.trim(),
        (await getSetting("telegramReportChatId"))?.trim(),
      ].filter((id): id is string => Boolean(id))
    ),
  ];
  if (recipients.length === 0) return;

  const user = update.new_chat_member?.user;
  const who = user?.username ? `@${user.username}` : user?.first_name ?? "без имени";
  const group = (await courseNameForChat(update.chat?.id)) ?? `неизвестная группа (chat_id ${update.chat?.id ?? "?"})`;
  const how = link ? "по ссылке, которую не узнаём — возможно слитая" : "без ссылки вообще";

  const text =
    `⚠️ Непонятный вход в закрытую группу\n` +
    `Кто: ${who} (id ${user?.id ?? "?"})\n` +
    `Группа: ${group}\n` +
    `Как вошёл: ${how}`;

  for (const chatId of recipients) {
    await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("groupAccess:alertUnexplainedJoin", err));
  }
}

type ChatMemberUpdate = {
  invite_link?: { invite_link?: string; creator?: { id?: number; is_bot?: boolean }; is_primary?: boolean; name?: string };
  new_chat_member?: { status?: string; user?: { id?: number; username?: string; first_name?: string } };
  chat?: { id?: number };
};

/**
 * Событие «человек вошёл/вышел в группе». Ловим вход по НАШЕЙ ссылке и
 * связываем Telegram-аккаунт с клиентом.
 */
export async function handleChatMember(update: ChatMemberUpdate): Promise<void> {
  const link = update.invite_link?.invite_link;
  const status = update.new_chat_member?.status;
  const userId = update.new_chat_member?.user?.id;
  const joined = status === "member" || status === "administrator" || status === "creator";

  if (!link || !userId) {
    // Без userId сообщать не о ком — эта ветка сработала из-за отсутствия
    // ссылки (раз userId есть, а сюда попали, значит именно !link). На выход
    // (joined === false) тоже не сигналим — там ничего подозрительного нет.
    if (joined && userId) await alertUnexplainedJoin(update, undefined);
    return;
  }

  const contact = await prisma.contact.findFirst({ where: { inviteLink: link } });
  if (!contact) {
    if (!joined) return;
    const botToken = (await getSetting("telegramBotToken"))?.trim() ?? "";
    // Ссылка Ширин (создана не ботом) или из списка ручных — обычный вход,
    // молча запоминаем; тревога только по ссылке, которую выдавал сам бот, а
    // контакта под неё нет (старая перевыданная или правда утекла).
    if (isHumanCreatedLink(update, botToken) || (await isManualInviteLink(link))) {
      await prisma.qaMessage
        .create({
          data: {
            chatId: String(update.chat?.id ?? ""),
            telegramUserId: String(userId),
            fromOwner: false,
            text: `[вход по ссылке админа] ${update.new_chat_member?.user?.username ? "@" + update.new_chat_member.user.username : update.new_chat_member?.user?.first_name ?? ""}`.trim(),
          },
        })
        .catch((err) => logError("groupAccess:manualJoinLog", err));
      return;
    }
    await alertUnexplainedJoin(update, link);
    return;
  }

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      telegramUserId: String(userId),
      joinedGroupAt: joined ? contact.joinedGroupAt ?? new Date() : contact.joinedGroupAt,
    },
  });

  // Тот же вход отмечаем и на самой покупке (Purchase.joinedAt), а не только на
  // контакте: у Contact.inviteLink живёт только ПОСЛЕДНЯЯ выданная ссылка (при
  // покупке двух курсов сразу вторая перезаписывает первую), а у каждой Purchase —
  // своя ссылка навсегда. learningCheckIn.ts проверяет, начала ли ученица учиться,
  // по КОНКРЕТНОЙ купленной группе — без этого поле Purchase.joinedAt так и
  // оставалось бы всегда пустым, и проверочное сообщение никогда бы не ушло.
  if (joined) {
    await prisma.purchase
      .updateMany({ where: { contactId: contact.id, inviteLink: link, joinedAt: null }, data: { joinedAt: new Date() } })
      .catch((err) => logError("groupAccess:purchaseJoined", err));
  }
}

/**
 * Отобрать доступ: выгнать из обеих групп и снять отметку об оплате.
 *
 * `banChatMember` с немедленной разблокировкой — выгоняет, но не оставляет
 * человека в чёрном списке навсегда: если окажется, что чек был настоящий,
 * достаточно выдать ссылку заново.
 */
export async function revokeAccess(contactId: string, reason = "фальшивый чек"): Promise<{ ok: boolean; details: string }> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { ok: false, details: "Клиент не найден" };
  if (!botToken) return { ok: false, details: "Не задан маркер Telegram-бота" };

  // Ссылку отзываем всегда: даже если человек ещё не вошёл, воспользоваться ею
  // он уже не сможет. ЧЕРЕЗ ОБЕ ГРУППЫ, а не только через первую настроенную:
  // Telegram отзывает ссылку только в chat_id ТОГО чата, которому она реально
  // принадлежит (createOneTimeInviteLink/grantCourses выдают её на chatIdFor
  // конкретного купленного курса) — какой именно это курс, здесь не хранится.
  // Раньше брался (await courseChats())[0] (почти всегда telegramChatId50):
  // для клиента, купившего COURSE_70, отзыв тихо проваливался (Telegram отвечал
  // ok:false на чужой chat_id, результат никто не проверял) — панель показывала
  // «доступ отобран», а ссылка в саму закрытую группу оставалась рабочей.
  if (contact.inviteLink) {
    for (const chatId of await courseChats()) {
      await call(botToken, "revokeChatInviteLink", { chat_id: chatId, invite_link: contact.inviteLink });
    }
  }

  const results: string[] = [];
  if (contact.telegramUserId) {
    for (const chatId of await courseChats()) {
      const kicked = await call(botToken, "banChatMember", { chat_id: chatId, user_id: Number(contact.telegramUserId) });
      if (kicked.ok) {
        await call(botToken, "unbanChatMember", { chat_id: chatId, user_id: Number(contact.telegramUserId), only_if_banned: true });
        results.push("удалён из группы");
      }
    }
  } else {
    results.push("в группу он не входил — отозвана только ссылка");
  }

  await prisma.contact.update({
    where: { id: contactId },
    data: { paid: false, accessRevokedAt: new Date(), inviteLink: null },
  });
  // Все купленные группы помечаем отозванными — иначе `allocate` будет считать
  // курсы у человека и не выдаст их заново, когда он заплатит по-настоящему.
  await prisma.purchase.updateMany({ where: { contactId, revokedAt: null }, data: { revokedAt: new Date() } });

  // Платформа курсов: снимаем и устройства. Без этого отзыв закрывал только
  // онлайн-путь, а уроки, уже скачанные в телефон, продолжали открываться —
  // то есть отобранный за фальшивый чек доступ фактически оставался у человека.
  // Обнулённый offlineKeyExpiresAt гасит и их, как только телефон выйдет в сеть.
  // Устройства теперь принадлежат человеку; старые записи — покупке. Снимаем обе.
  const purchases = await prisma.purchase.findMany({ where: { contactId }, select: { id: true } });
  await prisma.device
    .updateMany({
      where: { OR: [{ contactId }, { purchaseId: { in: purchases.map((p) => p.id) } }] },
      data: { blockedAt: new Date(), blockedReason: reason, offlineKeyExpiresAt: null },
    })
    .catch((err) => logError("groupAccess:revoke:devices", err));

  // Чеки, по которым выдавался доступ, — в чёрный список: тот же скриншот часто
  // ходит по рукам, и второй раз он должен отбиваться сразу.
  const receipts = await prisma.receiptCheck.findMany({
    where: { contactId, linkSent: true },
    select: { imageHash: true },
  });
  for (const r of receipts) {
    await prisma.blockedReceipt
      .create({ data: { imageHash: r.imageHash, reason } })
      .catch((err) => {
        // P2002 = дубликат imageHash (уже заблокирован) — это нормально.
        if ((err as { code?: string })?.code !== "P2002") {
          logError("groupAccess:revoke:blockedReceipt", err);
        }
      });
  }

  const details = results.length > 0 ? results.join("; ") : "ссылка отозвана";
  await notifyOwner(botToken, contact.username ?? contact.igUserId, reason, details);
  return { ok: true, details };
}

/**
 * ВЕРНУТЬ ОШИБОЧНО ОТОБРАННЫЙ ДОСТУП.
 *
 * Старая ссылка уже отозвана в Telegram (revokeChatInviteLink необратим) —
 * поэтому «вернуть» не значит «включить обратно», а значит выдать НОВУЮ ссылку
 * на каждый курс, что был у человека, разослать её ему и снять пометку отзыва.
 * Отпечаток его чека убираем из чёрного списка — раз доступ возвращают, чек
 * признан настоящим, и второй такой же скриншот (например, от друга, которому
 * действительно переслали) не должен биться заодно.
 */
export async function restoreAccess(contactId: string): Promise<{ ok: boolean; details: string }> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { ok: false, details: "Клиент не найден" };
  if (!botToken) return { ok: false, details: "Не задан маркер Telegram-бота" };
  // Снятие пометки accessRevokedAt — атомарная заявка на самом роуте (admin.ts),
  // это защита от двойного тапа. Здесь дальше решают КУПЛЕННЫЕ КУРСЫ
  // (Purchase.revokedAt), а не сама пометка — она к этому моменту уже null.

  const revokedPurchases = await prisma.purchase.findMany({ where: { contactId, revokedAt: { not: null } } });
  if (revokedPurchases.length === 0) {
    // Отозвали до того, как человек вообще что-то купил (например, по ошибке
    // на пустом контакте) — восстанавливать нечего, только снимаем пометку.
    await prisma.contact.update({ where: { id: contactId }, data: { accessRevokedAt: null } });
    return { ok: true, details: "пометка снята, покупок не было" };
  }

  // Возврат доступа должен разблокировать и устройства платформы: их снял
  // revokeAccess выше, и без этого человек получил бы ссылку, которая тут же
  // отвечает «устройство заблокировано».
  await prisma.device
    .updateMany({
      where: { OR: [{ contactId }, { purchaseId: { in: revokedPurchases.map((p) => p.id) } }] },
      data: { blockedAt: null, blockedReason: null },
    })
    .catch((err) => logError("groupAccess:restore:devices", err));

  const mode = await deliveryModeFor(contact);
  // В веб-режиме группы нет вовсе, и раньше возврат просто не срабатывал:
  // link оставался null, revokedAt не снимался, и доступ не возвращался
  // НИКОГДА. Ссылка на платформу — ОДНА на человека и обязательно новая,
  // иначе ожила бы старая, которую могли раздать за время «продажи».
  const webLink = mode === "telegram" ? null : await issueCourseLink(contactId);

  const issued: string[] = [];
  for (const purchase of revokedPurchases) {
    const course = purchase.course as Course;
    const chatId = mode === "web" ? null : await chatIdFor(course);
    const telegramLink = chatId ? await createOneTimeInviteLink(botToken, chatId) : null;
    const link = telegramLink ?? webLink;
    if (!link) {
      issued.push(`${COURSE_TITLE[course]}: не удалось выдать ссылку`);
      continue;
    }
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { revokedAt: null, ...(telegramLink ? { inviteLink: telegramLink } : {}) },
    });
    try {
      const text = revokedPurchases.length > 1 ? `${COURSE_TITLE[course]}\n${link}` : link;
      const mid = await sendToContact(contact, text);
      await recordOutgoingMessage(contactId, text, mid);
      issued.push(COURSE_TITLE[course]);
    } catch (err) {
      logError("groupAccess:restoreSend", err);
      issued.push(`${COURSE_TITLE[course]}: ссылка есть, отправить клиенту не вышло`);
    }
  }

  await prisma.contact.update({ where: { id: contactId }, data: { paid: true, paidAt: new Date(), accessRevokedAt: null } });

  // Снимаем блокировку с его чеков — доступ вернули, значит чек признан настоящим.
  const receipts = await prisma.receiptCheck.findMany({ where: { contactId, linkSent: true }, select: { imageHash: true } });
  if (receipts.length > 0) {
    await prisma.blockedReceipt.deleteMany({ where: { imageHash: { in: receipts.map((r) => r.imageHash) } } });
  }

  const details = issued.join("; ");
  await notifyOwner(botToken, contact.username ?? contact.igUserId, "доступ возвращён", details, "🔓");
  return { ok: true, details };
}

async function notifyOwner(botToken: string, who: string, reason: string, details: string, mark = "🚫"): Promise<void> {
  const chatId = (await ownerAlertChatIds())[0]; // личный чат владельца, иначе чат сводок (telegram.ts)
  if (!chatId) return;
  const title = mark === "🔓" ? `${mark} Доступ возвращён` : `${mark} Доступ отобран`;
  await sendTelegramMessage(botToken, chatId, `${title} у ${who}\nПричина: ${reason}\n${details}`).catch((err) =>
    logError("groupAccess:notify", err)
  );
}
