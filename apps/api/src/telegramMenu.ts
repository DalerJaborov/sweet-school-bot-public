import { approveTransferByOwner } from "./course/phoneChange.js";
import { prisma, getSetting, setSetting, logError } from "./db.js";
import { answerCallback, createOneTimeInviteLink, sendTelegramMessage, sendWithMarkup, trustedChatIds } from "./telegram.js";
import { buildReport, offsetMs, truncate } from "./dailyReport.js";
import { env } from "./env.js";
import {
  SITE_TARGETS, SITE_SOURCES, SOURCES_WITH_LABEL, TARGET_LABEL, SOURCE_LABEL, createSiteLink, shortUrl,
  type SiteTarget, type SiteLang, type SiteSource,
} from "./links/siteLinks.js";
import { chatKeyFor, COURSE_50, COURSE_70, COURSE_TITLE } from "./courses.js";

/**
 * МЕНЮ БЫСТРЫХ ДЕЙСТВИЙ В TELEGRAM (08.11.2026) — для владельца и сестры.
 *
 * Постоянные кнопки внизу чата с ботом вместо команд, которые надо помнить:
 *   📊 Сводка сейчас · ⏳ Кто ждёт ответа · 👥 Приглашение в группу · 🖥 Открыть панель
 * Кнопки подтверждения чека живут в самой карточке чека (telegram.ts
 * sendReceiptForReview) — здесь их не дублируем.
 *
 * ДВЕРЬ: только личный чат с ботом и только свои (trustedChatIds). Чужим молча
 * не отвечаем — как и ручная выдача ссылки (course/manualLink.ts).
 */

export const BTN_REPORT = "📊 Сводка сейчас";
export const BTN_WAITING = "⏳ Кто ждёт ответа";
export const BTN_INVITE = "👥 Приглашение в группу";
export const BTN_PAYMENTS = "💳 Последние оплаты";
export const BTN_FIND = "🔎 Найти ученицу";
export const BTN_GRANT = "🔑 Выдать доступ";
export const BTN_LINK = "🔗 Ссылка на сайт";
const PROMPT_LABEL = "Как назвать (имя блогера или рекламы)? Ответьте на это сообщение. #";
// Вопрос бота с «ответом» (force_reply): по началу текста узнаём, чей это ответ.
const PROMPT_FIND = "Кого найти? Ответьте на это сообщение ником";
const PROMPT_GRANT = "Кому выдать доступ? Ответьте на это сообщение ником";
const MENU_COMMANDS = ["/start", "/menu", "/меню"];

type TgMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string };
  reply_to_message?: { text?: string };
  from?: { id?: number | string };
};

export type MenuQuery = {
  id?: string;
  data?: string;
  from?: { id?: number };
  message?: { chat?: { id?: number } };
};

/** Постоянная клавиатура. «Открыть панель» — кнопка мини-приложения, только
 *  если известен https-адрес сайта (иначе Telegram отвергнет всю клавиатуру). */
export function menuKeyboard(): Record<string, unknown> {
  const rows: Record<string, unknown>[][] = [
    [{ text: BTN_REPORT }, { text: BTN_WAITING }],
    [{ text: BTN_INVITE }, { text: BTN_PAYMENTS }],
    [{ text: BTN_FIND }, { text: BTN_GRANT }],
    [{ text: BTN_LINK }],
    [],
  ];
  if (env.publicBaseUrl.startsWith("https://")) {
    rows[4].push({ text: "🖥 Открыть панель", web_app: { url: `${env.publicBaseUrl}/panel/` } });
  }
  return { keyboard: rows.filter((r) => r.length > 0), resize_keyboard: true, is_persistent: true };
}

/** Какие группы можно пригласить: только те, у которых в настройках есть ID. */
async function inviteGroups(): Promise<{ key: string; label: string; chatId: string }[]> {
  const defs = [
    { key: "50", label: `Курс «${COURSE_TITLE[COURSE_50]}»`, setting: chatKeyFor(COURSE_50) },
    { key: "70", label: `Курс «${COURSE_TITLE[COURSE_70]}»`, setting: chatKeyFor(COURSE_70) },
    { key: "qa", label: "Группа вопросов учениц", setting: "telegramQaGroupId" },
  ];
  const out: { key: string; label: string; chatId: string }[] = [];
  for (const d of defs) {
    const chatId = (await getSetting(d.setting))?.trim();
    if (chatId) out.push({ key: d.key, label: d.label, chatId });
  }
  return out;
}

/** Кто и что ждёт ответа: непринятые чеки и вопросы учениц с платформы. */
export async function buildWaitingText(): Promise<string> {
  const [receipts, receiptTotal, questions, questionTotal] = await Promise.all([
    prisma.receiptCheck.findMany({
      where: { ownerDecision: "PENDING" },
      include: { contact: { select: { username: true, igUserId: true } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
    prisma.receiptCheck.count({ where: { ownerDecision: "PENDING" } }),
    prisma.courseChatMessage.findMany({
      where: { fromStudent: true, readByOwnerAt: null },
      include: { purchase: { include: { contact: { select: { username: true, igUserId: true, studentFirstName: true } } } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
    prisma.courseChatMessage.count({ where: { fromStudent: true, readByOwnerAt: null } }),
  ]);
  if (receiptTotal === 0 && questionTotal === 0) return "✅ Никто не ждёт — всё разобрано.";

  const lines: string[] = [];
  if (receiptTotal > 0) {
    lines.push(`⏳ Чеки без решения — ${receiptTotal}`);
    for (const r of receipts) {
      const who = r.contact.username ? `@${r.contact.username}` : `ID ···${r.contact.igUserId.slice(-6)}`;
      lines.push(`   ${who}${r.amount ? ` · ${r.amount} с.` : ""}`);
    }
    if (receiptTotal > receipts.length) lines.push(`   …и ещё ${receiptTotal - receipts.length}`);
    lines.push(`   Кнопки «Подтвердить / Отклонить» — под карточкой чека в этом чате.`);
  }
  if (questionTotal > 0) {
    if (lines.length) lines.push("");
    lines.push(`❓ Вопросы учениц без ответа — ${questionTotal}`);
    for (const q of questions) {
      const c = q.purchase.contact;
      const who = c.studentFirstName || (c.username ? `@${c.username}` : `ID ···${c.igUserId.slice(-6)}`);
      lines.push(`   ${who}: «${truncate(q.text ?? "(вложение)", 60)}»`);
    }
    if (questionTotal > questions.length) lines.push(`   …и ещё ${questionTotal - questions.length}`);
    lines.push(`   Ответить: реплаем на сообщение вопроса или в панели.`);
  }
  return lines.join("\n");
}

const COURSE_SHORT: Record<string, string> = { COURSE50: "Арт-десерты", COURSE70: "21 рецепт" };
const handleOf = (c: { username: string | null; igUserId: string }) =>
  c.username ? `@${c.username}` : `ID ···${c.igUserId.slice(-6)}`;

/** Оплаты за 3 дня: кто, какой курс, сколько. */
export async function buildPaymentsText(): Promise<string> {
  const since = new Date(Date.now() - 3 * 24 * 3_600_000);
  const rows = await prisma.purchase.findMany({
    where: { createdAt: { gte: since }, revokedAt: null },
    include: { contact: { select: { username: true, igUserId: true } } },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  if (rows.length === 0) return "💳 За 3 дня оплат нет.";
  const sum = rows.reduce((t, r) => t + r.amount, 0);
  return [
    `💳 За 3 дня: ${rows.length} шт. · ${sum} сомони`,
    ...rows.map((r) => `   ${handleOf(r.contact)} · ${COURSE_SHORT[r.course] ?? r.course} · ${r.amount} с.`),
  ].join("\n");
}

/** Карточка ученицы по нику: какие курсы куплены и в группе ли она. */
export async function buildStudentText(nick: string): Promise<string> {
  const username = nick.trim().replace(/^@/, "");
  if (!username) return "Напишите ник, например @malika.";
  const c = await prisma.contact.findFirst({ where: { username: { in: [username, username.toLowerCase()] } } });
  if (!c) return `Не нашла @${username}. Проверьте ник.`;
  const purchases = await prisma.purchase.findMany({
    where: { contactId: c.id, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (purchases.length === 0) return `@${c.username}: курсов нет${c.paid ? "" : " (не оплачивала)"}.`;
  return [
    `🔎 @${c.username}`,
    ...purchases.map(
      (p) => `   ${COURSE_SHORT[p.course] ?? p.course} · ${p.amount} с. · ${p.joinedAt ? "в группе" : "ещё не вошла"}`,
    ),
    "Новую ссылку на уроки — кнопка «🔑 Выдать доступ».",
  ].join("\n");
}

const isTarget = (v: string): v is SiteTarget => (SITE_TARGETS as readonly string[]).includes(v);
const isSource = (v: string): v is SiteSource => (SITE_SOURCES as readonly string[]).includes(v);
const isLang = (v: string): v is SiteLang => v === "tg" || v === "ru";

async function makeSiteLink(target: SiteTarget, lang: SiteLang, source: SiteSource, label?: string): Promise<string> {
  const link = await createSiteLink({ target, lang, source, label });
  return `🔗 ${TARGET_LABEL[target]} · ${SOURCE_LABEL[source]}${link.label ? ` · ${link.label}` : ""}\n${shortUrl(link.code)}`;
}

/** Шаги «Ссылка на сайт»: куда → язык → откуда (→ имя для блогера/рекламы). */
async function handleLinkStep(botToken: string, chatId: string, data: string): Promise<boolean> {
  const t = /^mn:lt:([a-z]+)$/.exec(data);
  if (t && isTarget(t[1])) {
    await sendWithMarkup(botToken, chatId, "На каком языке страница?", {
      inline_keyboard: [[{ text: "Тоҷикӣ", callback_data: `mn:ll:${t[1]}:tg` }, { text: "Русский", callback_data: `mn:ll:${t[1]}:ru` }]],
    });
    return true;
  }
  const l = /^mn:ll:([a-z]+):([a-z]+)$/.exec(data);
  if (l && isTarget(l[1]) && isLang(l[2])) {
    await sendWithMarkup(botToken, chatId, "Откуда придут люди?", {
      inline_keyboard: SITE_SOURCES.map((x) => [{ text: SOURCE_LABEL[x], callback_data: `mn:ls:${l[1]}:${l[2]}:${x}` }]),
    });
    return true;
  }
  const r = /^mn:ls:([a-z]+):([a-z]+):([a-z]+)$/.exec(data);
  if (r && isTarget(r[1]) && isLang(r[2]) && isSource(r[3])) {
    if (SOURCES_WITH_LABEL.has(r[3])) {
      await sendWithMarkup(botToken, chatId, `${PROMPT_LABEL}${r[1]}:${r[2]}:${r[3]}`, {
        force_reply: true,
        input_field_placeholder: "имя",
      });
    } else {
      await sendTelegramMessage(botToken, chatId, await makeSiteLink(r[1], r[2], r[3]));
    }
    return true;
  }
  return false;
}

/** true — сообщение было командой меню и обработано; дальше его вести не нужно. */
export async function handleMenuCommand(message: TgMessage): Promise<boolean> {
  const text = (message.text ?? "").trim();
  const lower = text.toLowerCase();
  const isMenu = MENU_COMMANDS.some((c) => lower === c || lower.startsWith(`${c}@`));
  const replyTo = message.reply_to_message?.text ?? "";
  const answeringFind = replyTo.startsWith(PROMPT_FIND);
  const answeringGrant = replyTo.startsWith(PROMPT_GRANT);
  const answeringLabel = replyTo.startsWith(PROMPT_LABEL);
  if (
    !isMenu &&
    !answeringLabel &&
    !answeringFind &&
    !answeringGrant &&
    ![BTN_REPORT, BTN_WAITING, BTN_INVITE, BTN_PAYMENTS, BTN_FIND, BTN_GRANT, BTN_LINK].includes(text)
  )
    return false;

  // Только личная переписка: в группе учениц эти слова — обычные сообщения.
  if (message.chat?.type && message.chat.type !== "private") return false;
  const chatId = message.chat?.id != null ? String(message.chat.id) : "";
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const allowed = await trustedChatIds();
  if (!botToken || !chatId || !allowed.includes(chatId)) return false;

  const send = (body: string) => sendTelegramMessage(botToken, chatId, body, message.message_id ?? undefined);

  if (answeringFind) {
    await send(await buildStudentText(text));
    return true;
  }
  if (answeringLabel) {
    const m = /#([a-z]+):([a-z]+):([a-z]+)$/.exec(replyTo);
    if (m && isTarget(m[1]) && isLang(m[2]) && isSource(m[3])) {
      await send(await makeSiteLink(m[1], m[2], m[3], text));
    }
    return true;
  }
  if (text === BTN_LINK) {
    await sendWithMarkup(botToken, chatId, "Куда ведёт ссылка?", {
      inline_keyboard: SITE_TARGETS.map((t) => [{ text: TARGET_LABEL[t], callback_data: `mn:lt:${t}` }]),
    });
    return true;
  }
  if (answeringGrant) {
    // Выдача — тем же путём, что команда «/ссылка @ник» (новая ссылка, старая гаснет).
    const { handleManualLinkCommand } = await import("./course/manualLink.js");
    await handleManualLinkCommand({ ...message, text: `/ссылка ${text}` });
    return true;
  }
  if (text === BTN_PAYMENTS) {
    await send(await buildPaymentsText());
    return true;
  }
  if (text === BTN_FIND || text === BTN_GRANT) {
    await sendWithMarkup(botToken, chatId, text === BTN_FIND ? PROMPT_FIND : PROMPT_GRANT, {
      force_reply: true,
      input_field_placeholder: "@ник",
    });
    return true;
  }
  if (isMenu) {
    await sendWithMarkup(botToken, chatId, "Кнопки внизу — быстрые действия. Чеки приходят сюда же, с кнопками.", menuKeyboard());
    return true;
  }
  if (text === BTN_REPORT) {
    await send(await buildReport(await offsetMs()));
    return true;
  }
  if (text === BTN_WAITING) {
    await send(await buildWaitingText());
    return true;
  }
  // BTN_INVITE
  const groups = await inviteGroups();
  if (groups.length === 0) {
    await send("Группы не заданы: впишите ID групп в «Настройках» панели.");
    return true;
  }
  await sendWithMarkup(botToken, chatId, "В какую группу пригласить? Ссылка одноразовая, на 30 дней.", {
    inline_keyboard: groups.map((g) => [{ text: g.label, callback_data: `mn:inv:${g.key}` }]),
  });
  return true;
}

/** Нажатие кнопки меню (callback_data `mn:...`). Доверие уже проверено выше. */
export async function handleMenuCallback(botToken: string, query: MenuQuery): Promise<void> {
  const chatId = query.message?.chat?.id != null ? String(query.message.chat.id) : String(query.from?.id ?? "");
  if (query.id && chatId && /^mn:l[tls]:/.test(query.data ?? "")) {
    await answerCallback(botToken, query.id, "");
    await handleLinkStep(botToken, chatId, query.data ?? "").catch((err) => logError("telegramMenu:siteLink", err));
    return;
  }
  const approve = /^mn:tr:([0-9a-f-]{36})$/.exec(query.data ?? "");
  if (approve && query.id && chatId) {
    const done = await approveTransferByOwner(approve[1]).catch((err) => {
      logError("telegramMenu:approveTransfer", err);
      return false;
    });
    await answerCallback(botToken, query.id, done ? "Перенос разрешён, ей написали" : "Не получилось");
    return;
  }
  const match = /^mn:inv:(50|70|qa)$/.exec(query.data ?? "");
  if (!match || !query.id || !chatId) return;
  const group = (await inviteGroups()).find((g) => g.key === match[1]);
  if (!group) {
    await answerCallback(botToken, query.id, "Группа не задана в настройках");
    return;
  }
  const link = await createOneTimeInviteLink(botToken, group.chatId);
  if (!link) {
    await answerCallback(botToken, query.id, "Telegram не дал ссылку");
    await sendTelegramMessage(
      botToken,
      chatId,
      `Не получилось сделать ссылку в «${group.label}». Проверьте, что бот — администратор группы с правом приглашать.`
    ).catch((err) => logError("telegramMenu:inviteFail", err));
    return;
  }
  // Вход по ссылке не должен поднимать тревогу «непонятный вход» (groupAccess.ts):
  // кладём её в список ручных ссылок, последние 200.
  const known = ((await getSetting("manualInviteLinks")) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  await setSetting("manualInviteLinks", [...known, link].slice(-200).join("\n")).catch((err) =>
    logError("telegramMenu:rememberInvite", err)
  );
  await answerCallback(botToken, query.id, "Ссылка готова");
  await sendTelegramMessage(botToken, chatId, `👥 ${group.label}\n${link}\n\nОдна ссылка — один человек, действует 30 дней.`);
}
