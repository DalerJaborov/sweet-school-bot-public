import { prisma, getSetting, setSetting, logError } from "./db.js";
import { answerCallback, createOneTimeInviteLink, sendTelegramMessage, sendWithMarkup, trustedChatIds } from "./telegram.js";
import { buildReport, offsetMs, truncate } from "./dailyReport.js";
import { env } from "./env.js";
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
const MENU_COMMANDS = ["/start", "/menu", "/меню"];

type TgMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string };
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
  const rows: Record<string, unknown>[][] = [[{ text: BTN_REPORT }, { text: BTN_WAITING }], [{ text: BTN_INVITE }]];
  if (env.publicBaseUrl.startsWith("https://")) {
    rows[1].push({ text: "🖥 Открыть панель", web_app: { url: `${env.publicBaseUrl}/panel/` } });
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
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

/** true — сообщение было командой меню и обработано; дальше его вести не нужно. */
export async function handleMenuCommand(message: TgMessage): Promise<boolean> {
  const text = (message.text ?? "").trim();
  const lower = text.toLowerCase();
  const isMenu = MENU_COMMANDS.some((c) => lower === c || lower.startsWith(`${c}@`));
  if (!isMenu && ![BTN_REPORT, BTN_WAITING, BTN_INVITE].includes(text)) return false;

  // Только личная переписка: в группе учениц эти слова — обычные сообщения.
  if (message.chat?.type && message.chat.type !== "private") return false;
  const chatId = message.chat?.id != null ? String(message.chat.id) : "";
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const allowed = await trustedChatIds();
  if (!botToken || !chatId || !allowed.includes(chatId)) return false;

  const send = (body: string) => sendTelegramMessage(botToken, chatId, body, message.message_id ?? undefined);

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
  const match = /^mn:inv:(50|70|qa)$/.exec(query.data ?? "");
  const chatId = query.message?.chat?.id != null ? String(query.message.chat.id) : String(query.from?.id ?? "");
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
