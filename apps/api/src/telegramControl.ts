import { logError } from "./db.js";
import {
  answerCallback,
  chatRole,
  editMessageWithMarkup,
  mutedKinds,
  sendTelegramMessage,
  sendWithMarkup,
  setKindEnabled,
  setShirinEnabled,
  shirinEnabled,
  type ChatRole,
} from "./telegram.js";
import { NOTIFY_INFO, MUTABLE_KINDS, isNotifyKind, kindFromMessageText, type NotifyKind } from "./notifyKinds.js";
import {
  describeBotState,
  getBotState,
  pauseFunnels,
  resumeFunnels,
  setAiReplies,
  setCommentReplies,
  setFrozen,
  startEverything,
  stopEverything,
  type BotState,
} from "./botControl.js";
import { parseOwnerCommand, type OwnerIntent } from "./ownerCommands.js";
import { buildMainSummary } from "./todaySummary.js";
import { plural } from "./dailyReport.js";

/**
 * УПРАВЛЕНИЕ БОТОМ ПРЯМО В TELEGRAM (11.11.2026) — кнопки и простые слова, без
 * мини-приложения. Вся работа — в botControl.ts / telegram.ts (роли, виды
 * уведомлений); здесь только разговор: меню, нажатия, переспрос кнопкой.
 *
 *  • «⚙️ Управление» — состояние бота и кнопки: ответы людям, пауза «всё, кроме
 *    воронки», воронка, ответы под комментариями, «выключить всё»;
 *  • «🔔 Уведомления» — тумблеры по видам (свои у каждого: владелец и Ширин);
 *  • слова: «не присылай мне оплаты», «выключи бота», «что у меня выключено» —
 *    ownerCommands.ts; неоднозначное («выключи бота») переспрашиваем кнопками.
 * Управлять ботом может только владелец платформы; Ширин — своими уведомлениями.
 */
type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };

export type ControlQuery = {
  id?: string;
  data?: string;
  from?: { id?: number };
  message?: { message_id?: number; chat?: { id?: number }; text?: string };
};

const CANCEL: { text: string; callback_data: string }[] = [{ text: "Отмена", callback_data: "ct:x" }];

// ---------- «Сегодня»: деньги, оплаты, записи ----------

const rub = (n: number) => n.toLocaleString("ru-RU").replace(/ /g, " ");

export async function buildTodayText(): Promise<string> {
  const s = await buildMainSummary();
  const lines = [
    `📊 Сегодня: ${rub(s.money.today)} сомони`,
    `   ${s.money.salesToday} ${plural(s.money.salesToday, "оплата", "оплаты", "оплат")} · за неделю ${rub(s.money.week)} с. (${s.money.salesWeek})`,
    `📝 Офлайн: сегодня ${s.offline.today}, за неделю ${s.offline.week}`,
  ];
  if (s.pendingReceipts > 0) lines.push(`🧾 Чеков на проверке: ${s.pendingReceipts} — в панели «Чеки»`);
  if (s.recent.length > 0) {
    lines.push("", "Последнее:");
    for (const e of s.recent) lines.push(`${e.kind === "payment" ? "💰" : "📝"} ${e.who} — ${e.what}`);
  }
  lines.push(
    "",
    s.bot.ai && !s.bot.frozen
      ? "🟢 Бот отвечает людям"
      : "🔴 Бот сейчас не отвечает как обычно — кнопка «⚙️ Управление»",
  );
  return lines.join("\n");
}

// ---------- меню управления ----------

function controlMarkup(s: BotState): Markup {
  return {
    inline_keyboard: [
      [
        {
          text: s.ai ? "🔴 Выключить ответы людям" : "🟢 Включить ответы людям",
          callback_data: `ct:ai:${s.ai ? 0 : 1}`,
        },
      ],
      [
        {
          text: s.frozen ? "▶️ Снять паузу (всё, кроме воронки)" : "⏸ Пауза: всё, кроме воронки",
          callback_data: `ct:fr:${s.frozen ? 0 : 1}`,
        },
      ],
      [
        {
          text: s.funnelsOn > 0 ? "⏸ Воронку на паузу" : s.funnelsPaused ? "▶️ Вернуть воронку" : "Воронка выключена",
          callback_data: `ct:fn:${s.funnelsOn > 0 ? 0 : 1}`,
        },
      ],
      [
        {
          text: s.comments ? "🔴 Не отвечать под комментариями" : "🟢 Отвечать под комментариями",
          callback_data: `ct:cm:${s.comments ? 0 : 1}`,
        },
      ],
      [
        { text: "📊 Сегодня", callback_data: "mn:today" },
        { text: "🔑 Выдать ссылку", callback_data: "mn:grant" },
      ],
      [
        { text: "🔔 Уведомления", callback_data: "ct:n" },
        { text: "Ещё", callback_data: "mn:more" },
      ],
      [
        { text: "⛔ Выключить бота совсем", callback_data: "ct:all:0" },
        { text: "✅ Включить всё", callback_data: "ct:all:1" },
      ],
    ],
  };
}

async function controlText(extra?: string): Promise<{ text: string; markup: Markup }> {
  const s = await getBotState();
  return {
    text: [extra, "⚙️ Управление ботом", ...describeBotState(s)].filter(Boolean).join("\n"),
    markup: controlMarkup(s),
  };
}

export async function sendControlMenu(botToken: string, chatId: string, extra?: string): Promise<void> {
  const m = await controlText(extra);
  await sendWithMarkup(botToken, chatId, m.text, m.markup);
}

async function refreshControlMenu(
  botToken: string,
  query: ControlQuery,
  chatId: string,
  extra?: string,
): Promise<void> {
  const m = await controlText(extra);
  const messageId = query.message?.message_id;
  if (messageId && (await editMessageWithMarkup(botToken, chatId, messageId, m.text, m.markup))) return;
  await sendWithMarkup(botToken, chatId, m.text, m.markup);
}

// ---------- уведомления ----------

/** Какие виды роль вообще может получать: Ширин — только «главное». */
function kindsFor(role: ChatRole): NotifyKind[] {
  return MUTABLE_KINDS.filter((k) => role === "owner" || NOTIFY_INFO[k].audience === "main");
}

async function notifyMenu(role: ChatRole): Promise<{ text: string; markup: Markup }> {
  const off = await mutedKinds(role);
  const rows = kindsFor(role).map((k) => [
    { text: `${off.has(k) ? "🔕 Выключено" : "✅ Приходит"}: ${NOTIFY_INFO[k].label}`, callback_data: `nf:t:${k}` },
  ]);
  const lines = [
    "🔔 Уведомления: нажмите на вид, чтобы включить или выключить.",
    "Раз в день вечером — «Итог дня». Остальное приходит сразу и редко.",
  ];
  if (role === "owner") {
    const sh = await shirinEnabled();
    rows.push([{ text: `${sh ? "✅" : "🔕"} Ширин получает главное: ${sh ? "да" : "нет"}`, callback_data: "nf:sh" }]);
    lines.push("«Главное» — оплаты, записи на офлайн, итог дня. Служебное Ширин не приходит никогда.");
  }
  rows.push([{ text: "← Назад", callback_data: "ct:m" }]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

async function showNotifyMenu(botToken: string, chatId: string, role: ChatRole, query?: ControlQuery): Promise<void> {
  const m = await notifyMenu(role);
  const messageId = query?.message?.message_id;
  if (messageId && (await editMessageWithMarkup(botToken, chatId, messageId, m.text, m.markup))) return;
  await sendWithMarkup(botToken, chatId, m.text, m.markup);
}

export async function sendNotifyMenu(botToken: string, chatId: string): Promise<void> {
  await showNotifyMenu(botToken, chatId, (await chatRole(chatId)) ?? "shirin");
}

const labels = (kinds: NotifyKind[]) => kinds.map((k) => `«${NOTIFY_INFO[k].label}»`).join(", ");

async function muteKinds(role: ChatRole, kinds: NotifyKind[]): Promise<string> {
  if (kinds.length > 0 && kinds.every((k) => NOTIFY_INFO[k].locked)) {
    return "Это выключить нельзя: без вашей кнопки чек или перенос телефона зависнет.";
  }
  const allowed = kinds.filter((k) => kindsFor(role).includes(k) && !NOTIFY_INFO[k].locked);
  if (allowed.length === 0) return "Такое вам и так не приходит.";
  for (const k of allowed) await setKindEnabled(role, k, false);
  return `🔕 Готово, больше не пришлю: ${labels(allowed)}.\nВернуть — «включи обратно» или кнопка «🔔 Уведомления».`;
}

// ---------- нажатия ----------

/** Нажатия `ct:*` (управление) и `nf:*` (уведомления). Доверие к чату уже проверено выше. */
export async function handleControlCallback(botToken: string, query: ControlQuery): Promise<void> {
  const chatId = query.message?.chat?.id != null ? String(query.message.chat.id) : String(query.from?.id ?? "");
  const data = query.data ?? "";
  if (!query.id || !chatId) return;
  const role = (await chatRole(chatId)) ?? "shirin";

  // --- уведомления: доступны обоим, но каждый меняет только свои ---
  if (data.startsWith("nf:")) {
    const toggle = /^nf:t:([a-z]+)$/.exec(data);
    const mute = /^nf:off:([a-z]+)$/.exec(data);
    const unmute = /^nf:on:([a-z]+)$/.exec(data);
    if (data === "nf:sh") {
      if (role !== "owner") return void (await answerCallback(botToken, query.id, "Это может только владелец"));
      await setShirinEnabled(!(await shirinEnabled()));
      await answerCallback(botToken, query.id, "Готово");
      return showNotifyMenu(botToken, chatId, role, query);
    }
    if (data === "nf:offall") {
      for (const k of kindsFor(role)) await setKindEnabled(role, k, false);
      await answerCallback(botToken, query.id, "Всё выключено");
      return showNotifyMenu(botToken, chatId, role, query);
    }
    if (toggle && isNotifyKind(toggle[1]) && kindsFor(role).includes(toggle[1])) {
      const k = toggle[1];
      await setKindEnabled(role, k, (await mutedKinds(role)).has(k));
      await answerCallback(botToken, query.id, (await mutedKinds(role)).has(k) ? "Выключено" : "Включено");
      return showNotifyMenu(botToken, chatId, role, query);
    }
    if (unmute && isNotifyKind(unmute[1]) && kindsFor(role).includes(unmute[1])) {
      await setKindEnabled(role, unmute[1], true);
      await answerCallback(botToken, query.id, "Включено");
      await sendTelegramMessage(botToken, chatId, `✅ Включил: ${labels([unmute[1]])}.`).catch((err) => logError("telegramControl:unmute", err));
      return;
    }
    if (mute && isNotifyKind(mute[1])) {
      await answerCallback(botToken, query.id, "Не буду присылать");
      const text = await muteKinds(role, [mute[1]]);
      await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("telegramControl:mute", err));
      return;
    }
    await answerCallback(botToken, query.id, "");
    return;
  }

  if (data === "ct:n") {
    await answerCallback(botToken, query.id, "");
    return showNotifyMenu(botToken, chatId, role, query);
  }
  if (data === "ct:x") {
    await answerCallback(botToken, query.id, "Ок, ничего не меняю");
    return;
  }

  // --- управление ботом: только владелец ---
  if (role !== "owner") {
    await answerCallback(botToken, query.id, "Управлять ботом может только владелец");
    return;
  }
  if (data === "ct:m") {
    await answerCallback(botToken, query.id, "");
    return refreshControlMenu(botToken, query, chatId);
  }
  const m = /^ct:(ai|fr|fn|cm|all):([01])$/.exec(data);
  if (!m) {
    await answerCallback(botToken, query.id, "");
    return;
  }
  const on = m[2] === "1";
  let done: string;
  try {
    if (m[1] === "ai") {
      await setAiReplies(on);
      done = on ? "Ответы людям включены" : "Ответы людям выключены";
    } else if (m[1] === "fr") {
      await setFrozen(on);
      done = on ? "Пауза включена: воронка работает, остальное стоит" : "Пауза снята";
    } else if (m[1] === "fn") {
      if (on) done = (await resumeFunnels()) > 0 ? "Воронка снова работает" : "Нечего возвращать";
      else done = (await pauseFunnels()) > 0 ? "Воронка на паузе" : "Воронка и так выключена";
    } else if (m[1] === "cm") {
      await setCommentReplies(on);
      done = on ? "Ответы под комментариями включены" : "Ответы под комментариями выключены";
    } else if (on) {
      await startEverything();
      done = "Всё включено";
    } else {
      await stopEverything();
      done = "Бот выключен совсем: ответы, остальное и воронка";
    }
  } catch (err) {
    logError("telegramControl:apply", err);
    await answerCallback(botToken, query.id, "Не получилось, загляните в журнал");
    return;
  }
  await answerCallback(botToken, query.id, done);
  await refreshControlMenu(botToken, query, chatId, `✔ ${done}.`);
}

// ---------- слова владельца ----------

type TgMessageLike = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string };
  reply_to_message?: { text?: string };
  // Пересланное сообщение — чужие слова, не команда нам (поля Bot API, старые и новые).
  forward_origin?: unknown;
  forward_date?: number;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: string;
};

export function isForwardedMessage(m: TgMessageLike): boolean {
  return Boolean(m.forward_origin || m.forward_date || m.forward_from || m.forward_from_chat || m.forward_sender_name);
}

async function askWhichMute(botToken: string, chatId: string, role: ChatRole): Promise<void> {
  const rows = kindsFor(role).map((k) => [{ text: NOTIFY_INFO[k].label, callback_data: `nf:off:${k}` }]);
  rows.push([{ text: "Выключить всё", callback_data: "nf:offall" }]);
  rows.push(CANCEL);
  await sendWithMarkup(botToken, chatId, "Что именно больше не присылать?", { inline_keyboard: rows });
}

const BOT_ON_QUESTION: Record<"ai" | "freeze" | "funnels" | "comments" | "all", { text: string; data: string }> = {
  ai: { text: "Включить ответы людям?", data: "ct:ai:1" },
  freeze: { text: "Снять паузу? Бот снова начнёт отвечать.", data: "ct:fr:0" },
  funnels: { text: "Вернуть воронку с рилсов?", data: "ct:fn:1" },
  comments: { text: "Включить ответы под комментариями?", data: "ct:cm:1" },
  all: { text: "Включить бота полностью: ответы людям, воронку, снять паузу?", data: "ct:all:1" },
};

/** Включение — только после нажатия кнопки: фраза словами могла быть сказана не про это. */
async function askBotOn(botToken: string, chatId: string, what: keyof typeof BOT_ON_QUESTION): Promise<void> {
  const q = BOT_ON_QUESTION[what];
  await sendWithMarkup(botToken, chatId, q.text, {
    inline_keyboard: [[{ text: "Да, включить", callback_data: q.data }], CANCEL],
  });
}

async function askUnmute(botToken: string, chatId: string, kinds: NotifyKind[]): Promise<void> {
  await sendWithMarkup(botToken, chatId, `Включить уведомления: ${labels(kinds)}?`, {
    inline_keyboard: [...kinds.map((k) => [{ text: `Да, включить: ${NOTIFY_INFO[k].label}`, callback_data: `nf:on:${k}` }]), CANCEL],
  });
}

async function askWhichBotOff(botToken: string, chatId: string): Promise<void> {
  await sendWithMarkup(botToken, chatId, "Что выключить?", {
    inline_keyboard: [
      [{ text: "Только ответы людям", callback_data: "ct:ai:0" }],
      [{ text: "Пауза: всё, кроме воронки", callback_data: "ct:fr:1" }],
      [{ text: "Только воронку с рилсов", callback_data: "ct:fn:0" }],
      [{ text: "Бота совсем", callback_data: "ct:all:0" }],
      CANCEL,
    ],
  });
}

async function applyOwnerIntent(
  botToken: string,
  chatId: string,
  role: ChatRole,
  intent: OwnerIntent,
  replyKind: NotifyKind | null,
): Promise<void> {
  const say = (t: string) => sendTelegramMessage(botToken, chatId, t);
  const botIntent = ["ai", "freeze", "funnels", "comments", "askBotOff", "askBotOn", "menu"].includes(intent.type);
  if (botIntent && role !== "owner") {
    await say("Управлять ботом может только владелец.");
    return;
  }
  switch (intent.type) {
    case "mute":
      await say(await muteKinds(role, intent.kinds));
      return;
    case "askMute":
      if (replyKind) await say(await muteKinds(role, [replyKind]));
      else await askWhichMute(botToken, chatId, role);
      return;
    case "unmute": {
      const allowed = intent.kinds.filter((k) => kindsFor(role).includes(k));
      for (const k of allowed) await setKindEnabled(role, k, true);
      await say(allowed.length > 0 ? `✅ Включил: ${labels(allowed)}.` : "Такого вам и не приходило.");
      return;
    }
    case "askUnmute": {
      const allowed = intent.kinds.filter((k) => kindsFor(role).includes(k));
      if (allowed.length === 0) await say("Такого вам и не приходило.");
      else await askUnmute(botToken, chatId, allowed);
      return;
    }
    case "unmuteAll": {
      const off = await mutedKinds(role);
      for (const k of off) await setKindEnabled(role, k, true);
      await say(off.size > 0 ? `✅ Включил обратно: ${labels([...off])}.` : "У вас ничего не выключено.");
      return;
    }
    case "whatOff": {
      const off = [...(await mutedKinds(role))].filter((k) => kindsFor(role).includes(k));
      const extra: string[] = [];
      if (role === "owner" && !(await shirinEnabled())) extra.push("Ширин ничего не приходит");
      await say(
        off.length === 0 && extra.length === 0
          ? "У вас ничего не выключено."
          : `Выключено: ${[...(off.length ? [labels(off)] : []), ...extra].join("; ")}.\nВернуть — «включи обратно».`,
      );
      return;
    }
    case "ai":
      await setAiReplies(false);
      return sendControlMenu(botToken, chatId, "✔ Ответы людям выключены.");
    case "freeze":
      await setFrozen(true);
      return sendControlMenu(botToken, chatId, "✔ Пауза включена: воронка работает, остальное стоит.");
    case "funnels": {
      const n = await pauseFunnels();
      return sendControlMenu(botToken, chatId, n > 0 ? "✔ Воронка на паузе." : "Воронки уже в нужном состоянии.");
    }
    case "comments":
      await setCommentReplies(false);
      return sendControlMenu(botToken, chatId, "✔ Ответы под комментариями выключены.");
    case "askBotOff":
      return askWhichBotOff(botToken, chatId);
    case "askBotOn":
      return askBotOn(botToken, chatId, intent.what);
    case "menu":
      return sendControlMenu(botToken, chatId);
  }
}

/**
 * Слова владельца в личном чате. true — это была команда и она выполнена (или
 * задан уточняющий вопрос кнопками); false — не наше, пусть читают другие
 * обработчики. Ответ реплаем на чужое сообщение (вопрос ученицы и т. п.) не
 * трогаем: это не команда боту.
 */
export async function handleOwnerWords(message: TgMessageLike, botToken: string, chatId: string): Promise<boolean> {
  const text = (message.text ?? "").trim();
  if (!text || text.startsWith("/")) return false;
  if (isForwardedMessage(message)) return false;
  const replyText = message.reply_to_message?.text;
  const replyKind = replyText ? kindFromMessageText(replyText) : null;
  if (replyText && !replyKind) return false;
  const intent = parseOwnerCommand(text);
  if (!intent) return false;
  const role = await chatRole(chatId);
  if (!role) return false;
  await applyOwnerIntent(botToken, chatId, role, intent, replyKind).catch((err) =>
    logError("telegramControl:words", err),
  );
  return true;
}
