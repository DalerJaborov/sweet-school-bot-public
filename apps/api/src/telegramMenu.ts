import { approveTransferByOwner } from "./course/phoneChange.js";
import { prisma, getSetting, setSetting, logError } from "./db.js";
import { answerCallback, chatRole, createOneTimeInviteLink, sendTelegramMessage, sendWithMarkup, trustedChatIds, type ChatRole } from "./telegram.js";
import { buildTodayText, handleOwnerWords, sendControlMenu, sendNotifyMenu } from "./telegramControl.js";
import { buildReport, offsetMs, truncate } from "./dailyReport.js";
import { env } from "./env.js";
import {
  SITE_TARGETS, SITE_SOURCES, SOURCES_WITH_LABEL, TARGET_LABEL, SOURCE_LABEL, createSiteLink, shortUrl,
  type SiteTarget, type SiteLang, type SiteSource,
} from "./links/siteLinks.js";
import { chatKeyFor, COURSE_50, COURSE_70, COURSE_TITLE } from "./courses.js";
import { createOffer, findPeople, getPerson, issueOwnerLink, REASON_TEXT, takeOffer, type Person } from "./course/ownerLink.js";

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
// Новое главное меню (11.11.2026): мало кнопок, остальное — под «Ещё» в управлении.
export const BTN_TODAY = "📊 Сегодня";
export const BTN_CONTROL = "⚙️ Управление";
export const BTN_NOTIFY = "🔔 Уведомления";
export const BTN_GRANT_LINK = "🔑 Выдать ссылку";
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
export function menuKeyboard(role: ChatRole = "owner"): Record<string, unknown> {
  // Владельцу — четыре кнопки; Ширин — без «Управления» (ботом управляет владелец).
  const rows: Record<string, unknown>[][] =
    role === "owner"
      ? [[{ text: BTN_TODAY }, { text: BTN_GRANT_LINK }], [{ text: BTN_CONTROL }, { text: BTN_NOTIFY }], []]
      : [[{ text: BTN_TODAY }, { text: BTN_GRANT_LINK }], [{ text: BTN_NOTIFY }], []];
  if (env.publicBaseUrl.startsWith("https://")) {
    rows[2].push({ text: "🖥 Открыть панель", web_app: { url: `${env.publicBaseUrl}/panel/` } });
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


// ---------- «Выдать доступ»: человек → «В Telegram» / «На сайт» → ссылка ----------

const coursesText = (p: Person) => p.courses.map((c) => COURSE_SHORT[c] ?? c).join(", ");
const personLabel = (p: Person) => `${p.handle}${p.name ? ` · ${p.name}` : ""}`;

/** Что человеку приходит вместе с кнопкой «Переслать»: коротко, по-русски и по-таджикски. */
function shareButton(url: string): Record<string, unknown> {
  const text = "Ваша личная ссылка на уроки Ширин. Линки шахсии шумо ба дарсҳои Ширин.";
  return {
    inline_keyboard: [
      [{ text: "📤 Переслать человеку", url: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}` }],
    ],
  };
}

async function sendChoice(botToken: string, chatId: string, p: Person): Promise<void> {
  const n = createOffer(p.id);
  await sendWithMarkup(botToken, chatId, `${personLabel(p)}
Курсы: ${coursesText(p)}

Какую ссылку выдать? Она придёт сюда, вам: скопируйте и перешлите человеку куда удобно (WhatsApp, Instagram).`, {
    inline_keyboard: [
      [
        { text: "✈️ Ссылка в Telegram-группу", callback_data: `mn:ik:${n}:t` },
        { text: "🌐 Ссылка на сайт (без Telegram)", callback_data: `mn:ik:${n}:w` },
      ],
    ],
  });
}

/** Ответ на вопрос «Кому выдать доступ?»: нашли одного — сразу выбор канала, нескольких — список. */
async function offerPeople(botToken: string, chatId: string, query: string): Promise<void> {
  const people = await findPeople(query);
  if (people.length === 0) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `Не нашла «${query.trim()}» среди тех, у кого есть оплаченный курс.

Попробуйте ник из переписки или имя ученицы.`,
    );
    return;
  }
  if (people.length === 1) {
    await sendChoice(botToken, chatId, people[0]);
    return;
  }
  await sendWithMarkup(botToken, chatId, "Нашла нескольких. Кому выдать?", {
    inline_keyboard: people.map((p) => [{ text: personLabel(p).slice(0, 60), callback_data: `mn:ip:${createOffer(p.id)}` }]),
  });
}

/** Нажатия «mn:ip:» (выбор человека) и «mn:ik:» (выбор Telegram/сайт). Каждая карточка — одно нажатие и 15 минут. */
async function handleGrantStep(botToken: string, queryId: string, chatId: string, data: string): Promise<boolean> {
  const stale = "Карточка устарела или уже использована. Найдите человека заново.";
  const pick = /^mn:ip:([0-9a-f]{12})$/.exec(data);
  if (pick) {
    const person = await getPerson(takeOffer(pick[1]) ?? "");
    if (!person) {
      await answerCallback(botToken, queryId, stale);
      return true;
    }
    await answerCallback(botToken, queryId, "");
    await sendChoice(botToken, chatId, person);
    return true;
  }
  const go = /^mn:ik:([0-9a-f]{12}):([tw])$/.exec(data);
  if (!go) return false;
  const contactId = takeOffer(go[1]);
  if (!contactId) {
    await answerCallback(botToken, queryId, stale);
    return true;
  }
  const kind = go[2] === "t" ? "telegram" : "web";
  await answerCallback(botToken, queryId, "Готовлю ссылку");
  const person = await getPerson(contactId);
  const who = person ? personLabel(person) : "ученицы";
  const result = await issueOwnerLink(contactId, kind).catch((err) => {
    logError("telegramMenu:issueLink", err);
    return null;
  });
  if (!result) {
    await sendTelegramMessage(botToken, chatId, "Не получилось выдать ссылку. Загляните в журнал ошибок в панели.");
  } else if (!result.ok) {
    await sendTelegramMessage(botToken, chatId, REASON_TEXT[result.reason]);
  } else if (result.kind === "web") {
    const body =
      `🌐 Ссылка на сайт для ${who}

${result.url}

` +
      "Она личная: откроется на первом телефоне, где её нажмут, пересылать дальше нельзя. " +
      "Прошлая ссылка с этой минуты не работает.";
    // Прошлая ссылка уже погашена: если сообщение не ушло, повторяем без кнопки, а не теряем ссылку.
    if (!(await sendWithMarkup(botToken, chatId, body, shareButton(result.url)))) {
      await sendTelegramMessage(botToken, chatId, body);
    }
  } else {
    for (const l of result.links) {
      const body =
        `✈️ Приглашение в группу для ${who}
${COURSE_SHORT[l.course] ?? l.course}

${l.url}

` +
        "Одно приглашение — один человек, действует 30 дней. Прежнее неиспользованное приглашение этой ученицы не работает.";
      if (!(await sendWithMarkup(botToken, chatId, body, shareButton(l.url)))) {
        await sendTelegramMessage(botToken, chatId, body);
      }
    }
  }
  return true;
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
    ![BTN_REPORT, BTN_WAITING, BTN_INVITE, BTN_PAYMENTS, BTN_FIND, BTN_GRANT, BTN_LINK, BTN_TODAY, BTN_CONTROL, BTN_NOTIFY, BTN_GRANT_LINK].includes(text)
  ) {
    // Не кнопка: возможно, простые слова владельца («не присылай мне оплаты», «выключи бота»).
    if (message.chat?.type && message.chat.type !== "private") return false;
    const wordsChat = message.chat?.id != null ? String(message.chat.id) : "";
    const wordsToken = (await getSetting("telegramBotToken"))?.trim();
    if (!wordsToken || !wordsChat || !(await trustedChatIds()).includes(wordsChat)) return false;
    return handleOwnerWords(message, wordsToken, wordsChat);
  }

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
    await offerPeople(botToken, chatId, text).catch(async (err) => {
      logError("telegramMenu:grantSearch", err);
      await send("Не получилось найти. Загляните в журнал ошибок в панели.");
    });
    return true;
  }
  if (text === BTN_PAYMENTS) {
    await send(await buildPaymentsText());
    return true;
  }
  if (text === BTN_FIND || text === BTN_GRANT || text === BTN_GRANT_LINK) {
    await sendWithMarkup(botToken, chatId, text === BTN_FIND ? PROMPT_FIND : `${PROMPT_GRANT} или именем`, {
      force_reply: true,
      input_field_placeholder: text === BTN_FIND ? "@ник" : "ник или имя",
    });
    return true;
  }
  if (text === BTN_TODAY) {
    await send(await buildTodayText());
    return true;
  }
  if (text === BTN_CONTROL) {
    if ((await chatRole(chatId)) !== "owner") await send("Ботом управляет владелец. Вам доступны «Сегодня», «Выдать ссылку» и «Уведомления».");
    else await sendControlMenu(botToken, chatId);
    return true;
  }
  if (text === BTN_NOTIFY) {
    await sendNotifyMenu(botToken, chatId);
    return true;
  }
  if (isMenu) {
    await sendWithMarkup(
      botToken,
      chatId,
      "Кнопки внизу — быстрые действия. Ботом можно управлять и словами: «не присылай мне оплаты», «выключи бота», «что у меня выключено».",
      menuKeyboard((await chatRole(chatId)) ?? "shirin"),
    );
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

/** Кнопки «Ещё» под управлением: прежние быстрые действия по коду. */
const MORE_COMMANDS: Record<string, { label: string; text: string }> = {
  find: { label: "🔎 Найти ученицу", text: BTN_FIND },
  pay: { label: "💳 Последние оплаты", text: BTN_PAYMENTS },
  inv: { label: "👥 Приглашение в группу", text: BTN_INVITE },
  link: { label: "🔗 Ссылка на сайт", text: BTN_LINK },
  rep: { label: "📊 Сводка дня", text: BTN_REPORT },
  wait: { label: "🧾 Чеки без решения", text: BTN_WAITING },
};

/** Нажатие кнопки меню (callback_data `mn:...`). Доверие уже проверено выше. */
export async function handleMenuCallback(botToken: string, query: MenuQuery): Promise<void> {
  const chatId = query.message?.chat?.id != null ? String(query.message.chat.id) : String(query.from?.id ?? "");
  if (query.id && chatId && /^mn:(today|grant|more|cmd:[a-z]+)$/.test(query.data ?? "")) {
    await answerCallback(botToken, query.id, "");
    const data = query.data ?? "";
    if (data === "mn:today") await sendTelegramMessage(botToken, chatId, await buildTodayText());
    else if (data === "mn:grant") {
      await sendWithMarkup(botToken, chatId, `${PROMPT_GRANT} или именем`, { force_reply: true, input_field_placeholder: "ник или имя" });
    } else if (data === "mn:more") {
      await sendWithMarkup(botToken, chatId, "Ещё быстрые действия:", {
        inline_keyboard: Object.entries(MORE_COMMANDS).map(([k, v]) => [{ text: v.label, callback_data: `mn:cmd:${k}` }]),
      });
    } else {
      const cmd = MORE_COMMANDS[data.slice("mn:cmd:".length)];
      if (cmd) await handleMenuCommand({ text: cmd.text, chat: { id: chatId, type: "private" } }).catch((err) => logError("telegramMenu:more", err));
    }
    return;
  }
  if (query.id && chatId && /^mn:l[tls]:/.test(query.data ?? "")) {
    await answerCallback(botToken, query.id, "");
    await handleLinkStep(botToken, chatId, query.data ?? "").catch((err) => logError("telegramMenu:siteLink", err));
    return;
  }
  if (query.id && chatId && /^mn:i[pk]:/.test(query.data ?? "")) {
    await handleGrantStep(botToken, query.id, chatId, query.data ?? "").catch((err) => logError("telegramMenu:grant", err));
    return;
  }
  const approve = /^mn:tr:([0-9a-f-]{36})$/.exec(query.data ?? "");
  if (approve && query.id && chatId) {
    const done = await approveTransferByOwner(approve[1]).catch((err) => {
      logError("telegramMenu:approveTransfer", err);
      return "failed" as const;
    });
    const answer = {
      ok: "Перенос разрешён, ей написали",
      expired: "Карточка устарела или уже использована: пусть напишет боту снова",
      blocked: "Устройство заблокировано: сначала разблокируйте его в панели",
      failed: "Не получилось отправить ссылку. Новая карточка придёт, когда она напишет снова",
    }[done];
    await answerCallback(botToken, query.id, answer);
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
