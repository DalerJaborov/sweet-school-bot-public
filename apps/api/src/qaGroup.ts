import { prisma, getSetting, logError } from "./db.js";
import { downloadTelegramFile, sendTelegramMessage, sendTelegramVoice } from "./telegram.js";
import { saveOwnerMedia } from "./upload.js";
import { findQaAnswer } from "./ai/qaGroupReply.js";
import { voiceToText } from "./ai/voiceToText.js";

/**
 * ЗАХВАТ УЧЕБНОЙ TELEGRAM-ГРУППЫ (владелец 24.08.2026) + АВТООТВЕТ (владелец
 * 26.08.2026, «безопасный» вариант из трёх предложенных).
 *
 * В закрытой группе для учениц Ширин отвечает на технические вопросы по
 * готовке — отдельный жанр от продающей манеры Instagram-директа. Основная
 * задача — собирать архив (QaMessage) и пары «вопрос → ответ» (QaExample).
 *
 * АВТООТВЕТ (за флагом настройки `qaAutoReplyEnabled`, по умолчанию выключен)
 * — бот НЕ сочиняет технический совет сам, а повторяет ТОЛЬКО её же прошлый
 * ответ на близко совпавший повторный вопрос (см. ai/qaGroupReply.ts, тот же
 * матчинг, что у переотправки в Instagram-директе). Новый вопрос без близкого
 * совпадения — бот молчит, отвечает Ширин как обычно. Свободное сочинение
 * ответа моделью сознательно ИСКЛЮЧЕНО: неверный технический совет портит
 * десерт и репутацию школы (см. RECIPE_HOWTO в ai/offTopicGuard.ts) — модель
 * тут не участвует вовсе, только поиск среди уже проверенных её слов.
 *
 * ГОЛОС — И НА ВХОД, И НА ВЫХОД (владелец 26.08.2026). На выход: если у
 * найденной пары есть её реальная голосовая запись (mediaType "audio"),
 * бот пересылает именно её, не только расшифровку — тот же принцип "только
 * проверенное", просто в другом формате. На вход: если САМА ученица спросила
 * голосовым без подписи, бот расшифровывает вопрос (voiceToText.ts), иначе
 * сравнивать с архивом было бы нечем — иначе он молчал.
 *
 * ДВЕ НАСТРОЙКИ ОБЯЗАТЕЛЬНЫ, иначе функция тихо ничего не делает:
 *  - telegramQaGroupId — chat_id группы (отрицательное число для супергрупп);
 *  - telegramQaOwnerId — Telegram user_id самой Ширин (отличить её ответы от
 *    вопросов учениц).
 *
 * АРХИВ ПРОШЛОГО НЕ ДОСТАТЬ. У Telegram Bot API нет метода истории чата — бот
 * видит только то, что произошло ПОСЛЕ того, как его добавили в группу
 * (и только если отключён privacy mode через @BotFather /setprivacy, иначе он
 * получает лишь команды и реплаи на себя). Это платформенное ограничение, не
 * наше — тот же вывод, что дала проверка голосовых Instagram 24.08.2026.
 */

type TgPhotoSize = { file_id?: string };

export type TgGroupMessage = {
  message_id?: number;
  from?: { id?: number };
  chat?: { id?: number };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id?: number; text?: string; caption?: string };
  photo?: TgPhotoSize[];
  video?: { file_id?: string };
  voice?: { file_id?: string };
};

type Media = { url: string; type: "audio" | "image" | "video" };

async function downloadMedia(botToken: string, msg: TgGroupMessage): Promise<Media | null> {
  const photoId = msg.photo?.at(-1)?.file_id; // последний элемент — самое крупное фото
  const spec = photoId
    ? { fileId: photoId, type: "image" as const }
    : msg.video?.file_id
      ? { fileId: msg.video.file_id, type: "video" as const }
      : msg.voice?.file_id
        ? { fileId: msg.voice.file_id, type: "audio" as const }
        : null;
  if (!spec) return null;

  const downloaded = await downloadTelegramFile(botToken, spec.fileId);
  if (!downloaded) return null;
  const url = saveOwnerMedia(downloaded.buffer, downloaded.mimeType);
  return url ? { url, type: spec.type } : null;
}

/**
 * Вызывается из telegramWebhook.ts на каждое ОБЫЧНОЕ сообщение бота вообще (не
 * только из учебной группы — бот сейчас админ ещё в двух закрытых группах
 * доставки курсов). Сырой лог (QaMessage) пишем БЕЗ фильтра по chat_id
 * нарочно: единственный способ узнать chat_id новой группы, не имея сторонних
 * ботов вроде @RawDataBot — увидеть его в нашей же базе после первого
 * сообщения. Дальше владелец называет нужный chat_id, и телеграм-настройка
 * telegramQaGroupId сужает то, что попадает в ПАРЫ (QaExample) и в будущем — в
 * обучение; лишнее из других чатов при желании можно почистить в панели.
 *
 * Пары «вопрос → ответ» (QaExample) строятся, только когда обе настройки
 * заданы И сообщение из нужного чата — иначе они просто не собираются, хотя
 * сырой лог уже копится.
 */
export async function handleQaGroupMessage(msg: TgGroupMessage): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;

  const groupId = (await getSetting("telegramQaGroupId"))?.trim();
  const ownerId = (await getSetting("telegramQaOwnerId"))?.trim();
  const isConfiguredGroup = !!groupId && String(msg.chat?.id) === groupId;

  const fromOwner = !!ownerId && String(msg.from?.id) === ownerId;
  let text = (msg.text ?? msg.caption ?? "").trim() || null;
  // Файл скачиваем и сохраняем только для настроенной группы: во время
  // бутстрапа (groupId ещё не задан) текста достаточно, чтобы узнать chat_id,
  // а тратить хранилище на вложения из чужих чатов незачем.
  const media = isConfiguredGroup
    ? await downloadMedia(botToken, msg).catch((err) => {
        logError("qaGroup:media", err);
        return null;
      })
    : null;

  // Голосовой ВОПРОС ученицы (без текста/подписи) — расшифровываем, иначе
  // автоответу banально нечем сравнивать с архивом (владелец 26.08.2026:
  // голос должен работать и на вход, не только на выход). Только когда
  // автоответ вообще включён — иначе тратить вызов Gemini не на что, и
  // только для настроенной группы (тот же смысл, что у downloadMedia выше).
  // Расшифровка нужна и для БАЗЫ ЗНАНИЙ, не только для автоответа: владелец
  // 05.09.2026 выключил автоответ, но копить пары «вопрос → ответ Ширин» велел
  // дальше. Отдельный выключатель qaVoiceTranscribeEnabled (по умолчанию включён).
  if (!fromOwner && !text && media?.type === "audio" && isConfiguredGroup && (await getSetting("qaVoiceTranscribeEnabled")) !== "false") {
    text = await voiceToText(media.url).catch((err) => {
      logError("qaGroup:voiceToText", err);
      return null;
    });
  }

  await prisma.qaMessage
    .create({
      data: {
        chatId: String(msg.chat?.id),
        telegramUserId: msg.from?.id != null ? String(msg.from.id) : null,
        telegramMsgId: msg.message_id ?? null,
        fromOwner,
        text,
        mediaUrl: media?.url,
        mediaType: media?.type,
      },
    })
    .catch((err) => logError("qaGroup:log", err));

  if (!isConfiguredGroup || !ownerId) return; // группа/владелица ещё не настроены — только сырой лог

  if (!fromOwner) {
    // Ученица написала — копим (пара строится на будущем ответе Ширин, ниже),
    // и пробуем безопасный автоответ: только если в архиве уже есть близко
    // совпавший вопрос, на который она отвечала раньше.
    if (text) await attemptAutoReply(botToken, msg, text).catch((err) => logError("qaGroup:autoReply", err));
    return;
  }
  if (!text && !media) return; // пустой ответ без вложения — нечего запоминать

  // Явный реплай — самый надёжный признак вопроса, на который она отвечает: в
  // живой группе несколько разговоров идут параллельно, и «последнее сообщение
  // в чате» не всегда то, на что она реагирует. Нет реплая — берём последнее
  // сообщение НЕ от неё в этом же чате (тот же приём, что historyImport.ts).
  let studentText = (msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "").trim();
  if (!studentText) {
    const last = await prisma.qaMessage.findFirst({
      where: { chatId: String(msg.chat?.id), fromOwner: false, text: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    studentText = last?.text ?? "";
  }

  await prisma.qaExample
    .create({
      data: {
        studentText: studentText.slice(0, 500),
        ownerText: text ?? "",
        mediaUrl: media?.url,
        mediaType: media?.type,
      },
    })
    .catch((err) => {
      // P2002 = дубликат пары (вопрос+ответ уже сохранены) — это нормально.
      if ((err as { code?: string })?.code !== "P2002") {
        logError("qaGroup:saveQaPair", err);
      }
    });
}

/** Метка перед повторённым ответом — честно про то, что это подбор по архиву,
 *  а не Ширин печатает live. Иначе странно, если она потом ответит иначе. */
const AUTO_REPLY_PREFIX = "📋 Похожий вопрос уже был:\n\n";
/** Когда у найденной пары есть голос, но текста нет (расшифровки не было на
 *  live-захвате — см. handleQaGroupMessage, транскрибирует только bulk-импорт) —
 *  подпись перед голосовым, чтобы не уходило совсем без метки. */
const AUTO_REPLY_VOICE_ONLY = "📋 Похожий вопрос уже был — голосовой ответ:";

async function attemptAutoReply(botToken: string, msg: TgGroupMessage, studentText: string): Promise<void> {
  if ((await getSetting("qaAutoReplyEnabled")) !== "true") return;
  const match = await findQaAnswer(studentText);
  if (!match) return;
  const ownerText = match.ownerText.trim();
  const hasVoice = match.mediaType === "audio" && Boolean(match.mediaUrl);
  if (!ownerText && !hasVoice) return;

  const chatId = String(msg.chat?.id);
  await sendTelegramMessage(
    botToken,
    chatId,
    ownerText ? `${AUTO_REPLY_PREFIX}${ownerText}` : AUTO_REPLY_VOICE_ONLY,
    msg.message_id
  );
  // Голос — её реальная запись, не синтез: тот же принцип "повторяем ТОЛЬКО
  // проверенное", что и с текстом. Идёт вторым сообщением следом за меткой,
  // тот же порядок, что у grantCourses/sendReusedMedia (текст, потом файл).
  if (hasVoice) {
    await sendTelegramVoice(botToken, chatId, match.mediaUrl as string).catch((err) =>
      logError("qaGroup:autoReplyVoice", err)
    );
  }
}
