import { getSetting, logError } from "./db.js";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

/** Обычное текстовое сообщение — утренняя сводка и служебные уведомления.
 *  replyToMessageId — оформить как реплай (учебная группа: видно, на чей
 *  именно вопрос отвечает бот, когда в группе идёт несколько разговоров сразу). */
/** Возвращает message_id отправленного сообщения: он нужен, когда на это
 *  сообщение потом отвечают реплаем и ответ надо связать с исходным вопросом
 *  (чат платформы курсов, см. course/chat.ts). Прежним вызовам, которые
 *  результат игнорируют, возврат не мешает. */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  replyToMessageId?: number
): Promise<number | null> {
  const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
  return data.result?.message_id ?? null;
}

/** По расширению в file_path — content-type файлового сервера Telegram не
 *  всегда информативен (иногда просто application/octet-stream). */
const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

/**
 * Скачивает вложение по file_id (голосовое/фото/видео из группового чата —
 * см. qaGroup.ts). Два шага, как того требует Bot API: getFile отдаёт временный
 * путь, файл лежит на отдельном файловом сервере Telegram.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const metaRes = await fetch(`${API}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const meta = (await metaRes.json()) as { ok?: boolean; result?: { file_path?: string }; description?: string };
    const filePath = meta.result?.file_path;
    if (!meta.ok || !filePath) {
      logError("telegram:downloadFile", new Error(`getFile: ${meta.description ?? `HTTP ${metaRes.status}`}`));
      return null;
    }

    const fileRes = await fetch(`${API}/file/bot${botToken}/${filePath}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!fileRes.ok) {
      logError("telegram:downloadFile", new Error(`file fetch: HTTP ${fileRes.status}`));
      return null;
    }
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    const mimeType =
      fileRes.headers.get("content-type")?.split(";")[0]?.trim() || EXT_MIME[ext] || "application/octet-stream";
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    return { buffer, mimeType };
  } catch (err) {
    logError("telegram:downloadFile", err);
    return null;
  }
}

/** Карточка сомнительного чека владельцу — с фото и двумя кнопками. Дёргаем
 *  ТОЛЬКО когда бот сам не разобрался (не читается сумма/дата или подозрение на
 *  подделку): чёткий чек уходит клиенту автоматически, владельца не трогаем. */
export async function sendReceiptForReview(
  botToken: string,
  ownerChatId: string,
  input: {
    imageUrl: string;
    caption: string;
    receiptId: string;
    /** Сумма не прочиталась — вместо одной кнопки «Подтвердить» показываем
     *  выбор курса явно (решение владельца 25.08.2026: не угадывать 70 сомони
     *  по умолчанию). См. c50/c70/cboth в telegramWebhook.ts handleDecision. */
    needsCourseChoice?: boolean;
  }
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const inline_keyboard = input.needsCourseChoice
    ? [
        [
          { text: "Арт-десерты · 50", callback_data: `c50:${input.receiptId}` },
          { text: "21 рецепт · 70", callback_data: `c70:${input.receiptId}` },
        ],
        [
          { text: "Оба курса", callback_data: `cboth:${input.receiptId}` },
          { text: "❌ Отклонить", callback_data: `no:${input.receiptId}` },
        ],
      ]
    : [
        [
          { text: "✅ Подтвердить", callback_data: `ok:${input.receiptId}` },
          { text: "❌ Отклонить", callback_data: `no:${input.receiptId}` },
        ],
      ];
  try {
    const res = await fetch(`${API}/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ownerChatId,
        photo: input.imageUrl,
        caption: input.caption,
        reply_markup: { inline_keyboard },
      }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
    return true;
  } catch (err) {
    logError("telegram:review", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Текстовое уведомление с кнопками — тот же приём, что у карточки чека
 *  (sendReceiptForReview), но без фото. Нужен для «серой зоны»: клиент просит
 *  человека или упёрся в заглушку офф-топика, и под уведомлением об этом в
 *  Telegram нужны кнопки быстрых ответов (см. ai.ts `callOwnerToChat`,
 *  telegramWebhook.ts, ветка `qr:`). */
export async function sendMessageWithButtons(
  botToken: string,
  chatId: string,
  text: string,
  buttons: { text: string; callback_data: string }[][]
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
    return true;
  } catch (err) {
    logError("telegram:buttons", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Гасит «часики» на нажатой кнопке и (по желанию) заменяет подпись под фото,
 *  чтобы в чате осталось видно, какое решение принято. */
export async function answerCallback(botToken: string, callbackId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`${API}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
  } catch (err) {
    logError("telegram:answerCallback", err);
  }
}

export async function editCaption(
  botToken: string,
  chatId: number | string,
  messageId: number,
  caption: string
): Promise<void> {
  try {
    const res = await fetch(`${API}/bot${botToken}/editMessageCaption`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption, reply_markup: { inline_keyboard: [] } }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
  } catch (err) {
    logError("telegram:editCaption", err);
  }
}

/** То же самое, что editCaption, но для обычного текстового сообщения (не
 *  фото) — карточка чека правит подпись, а уведомление о «серой зоне» из
 *  sendMessageWithButtons правит текст. Отдельная ручка Telegram API: на
 *  текстовом сообщении editMessageCaption не сработает. */
export async function editMessageText(
  botToken: string,
  chatId: number | string,
  messageId: number,
  text: string
): Promise<void> {
  try {
    const res = await fetch(`${API}/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
  } catch (err) {
    logError("telegram:editMessageText", err);
  }
}

/** Голосовое сообщение по URL — переотправка её же реального голоса (учебная
 *  группа, см. ai/qaGroupReply.ts): файл уже в OGG/Opus, как и всякая
 *  голосовая, скачанная через downloadTelegramFile из оригинального
 *  voice-сообщения Telegram, так что sendVoice принимает его как есть. */
export async function sendTelegramVoice(
  botToken: string,
  chatId: string,
  voiceUrl: string,
  replyToMessageId?: number
): Promise<void> {
  const res = await fetch(`${API}/bot${botToken}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      voice: voiceUrl,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || !data.ok) throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
}

/**
 * Одноразовая Telegram-приглашалка через сам Telegram Bot API — то, что владелец
 * уже нажимает руками в приложении Telegram (member_limit: 1, срок действия).
 * Тут ровно то же самое, только по API, автоматически: отдельная своя система
 * одноразовых ссылок не нужна — Telegram уже гасит ссылку после первого входа.
 *
 * Бот школы должен быть администратором целевой группы/канала с правом
 * приглашать пользователей — иначе Telegram ответит 403.
 */
export async function createOneTimeInviteLink(
  botToken: string,
  chatId: string,
  // Было 7 дней — владелец попросил больше (25.08.2026 веч.): человек может
  // отвлечься на неделю и вернуться к ссылке, которая уже истекла. Месяц —
  // достаточный запас, при этом всё ещё "одноразовая" (member_limit:1).
  expireSeconds = 30 * 24 * 3600
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/bot${botToken}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + expireSeconds,
      }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok?: boolean; result?: { invite_link?: string }; description?: string };
    if (!res.ok || !data.ok || !data.result?.invite_link) {
      throw new Error(`Telegram API: ${data.description ?? `HTTP ${res.status}`}`);
    }
    return data.result.invite_link;
  } catch (err) {
    logError("telegram:invite", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Кому слать тревоги владельцу: личный чат (telegramOwnerChatId) и чат сводок
 * (telegramReportChatId), без дублей. На проде 05.09.2026 ключ владельца
 * оказался переименован в «…_paused» — и всё, что писало только в него
 * (запись на офлайн-курс, часть тревог), молча пропадало. Один список на всех.
 */
export async function ownerAlertChatIds(): Promise<string[]> {
  const ids = [(await getSetting("telegramOwnerChatId"))?.trim(), (await getSetting("telegramReportChatId"))?.trim()];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}
