import { silenceIfFollowedByBusiness, releaseFollowSilenceIfClient } from "./profiles.js";
import { showsCourseInterest } from "./ai/relevance.js";
import { Router, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { upsertContact, handleIncomingDm, handleComment, cancelPendingFunnelSteps } from "./funnel.js";
import { aiReply, registerOfflineIfAsked, rescueIncomingImages, verifyReceiptsNow, type RescuedImage } from "./ai.js";
import { handleDeliveryChoiceReply } from "./course/deliveryChoice.js";
import { sendToContact } from "./messaging/send.js";
import { recordAdReferral, referralFromMeta } from "./metaConversions.js";
import { acceptWebhookEvents, processWebhookInbox, inboxKey, type InboxEvent } from "./webhookInbox.js";
import { debounceMessage } from "./debounce.js";
import { looksPersonal } from "./ai/personalContact.js";
import { detectAbuse } from "./ai/abuseFilter.js";
import { type ClientLanguage } from "./ai/clientLanguage.js";
import { contactLanguage } from "./ai/contactLanguage.js";
import { rememberOwnerReply, type OwnerMedia } from "./ai/styleLearning.js";
import { voiceToText } from "./ai/voiceToText.js";
import { findOwnMedia, viewableUrl } from "./ownMedia.js";
import { fetchAttachment, type Attachment } from "./ai/media.js";
import { saveOwnerMedia } from "./upload.js";
import type { MetaChannel } from "./instagram.js";
import { wasOurRecentReaction } from "./ai/reactions.js";
import { humanSilenceActive, loadHumanSilenceMs } from "./messaging/automation.js";

/** Сколько молчит бот, если в переписку вмешалась ЖИВАЯ хозяйка из приложения
 *  Instagram, а не наш код: написала текстом, ответила голосом или просто
 *  поставила реакцию на сообщение. Человек взял разговор на себя — влезать не
 *  нужно.
 *
 *  Десять минут, а не двадцать (решение владельца 22.08.2026): полчаса молчания
 *  после одного её сердечка означало, что следующий вопрос клиентки повисает в
 *  воздухе — хозяйка-то уже отошла. Десяти хватает, чтобы она дописала мысль. */
const HUMAN_TAKEOVER_SILENCE_MS = 10 * 60_000;

export const webhookRouter = Router();

/** Instagram присылает тип вложения как image/video/audio/file и др. (story_mention,
 *  share и т.п. попадаются, но нас интересуют только эти четыре — остальные молча
 *  отбрасываются в toAttachment). */
const KNOWN_KINDS = new Set(["image", "video", "audio", "file"]);

export type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    /** У пересланного рилса (ig_reel) Meta кладёт ещё reel_video_id — это id нашей публикации. */
    attachments?: { type?: string; payload?: { url?: string; reel_video_id?: string | number | null } }[];
    /** Ответ на нашу историю: Meta кладёт сюда её адрес и id. */
    reply_to?: { story?: { url?: string; id?: string }; mid?: string };
    /** Первое сообщение из рекламы «клик в переписку»: id объявления (metaConversions.ts). */
    referral?: unknown;
  };
  /** Отдельное событие messaging_referrals: человек открыл переписку из рекламы. */
  referral?: unknown;
  /** Кнопка «Начать» в Messenger из рекламы приносит referral здесь. */
  postback?: { payload?: string; referral?: unknown };
  /**
   * Реакция на сообщение (сердечко и прочие). Приходит отдельным событием, БЕЗ
   * message — поэтому раньше проваливалась мимо обработки целиком.
   *
   * Для нас это такое же вмешательство хозяйки, как текст: она увидела разговор и
   * ответила по-своему. Владелец 22.08.2026: «бот должен видеть всё, что делает
   * хозяйка — и смайлики, и реакции».
   */
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string };
};

/** Пересланная публикация или ответ на историю. Само видео Meta нам не отдаёт —
 *  только адрес, поэтому дальше решает ownMedia: наша публикация или чужая. */
const SHARED_TYPES = new Set(["share", "story_mention", "reel", "ig_reel"]);

type CommentChange = {
  field?: string;
  value?: {
    // Instagram
    id?: string;
    media?: { id?: string };
    text?: string;
    // Facebook (feed): другое имя у тех же по смыслу полей
    comment_id?: string;
    post_id?: string;
    message?: string;
    item?: string;
    verb?: string;
    from?: { id?: string; username?: string; name?: string };
  };
};

type WebhookBody = {
  object?: string;
  entry?: { id?: string; messaging?: MessagingEvent[]; changes?: CommentChange[] }[];
};

/**
 * ОТКАЗ ЗДЕСЬ РАНЬШЕ БЫЛ ПОЛНОСТЬЮ ТИХИМ (разбор 30.08.2026).
 *
 * `false` даёт вебхуку 403 ДО разбора тела — и до этой правки об этом не
 * оставалось ни следа: ни в консоли, ни тем более в постоянном журнале. Живой
 * случай: человек написал с рекламы, ответа не получил, а разбираться было
 * не с чем. Отказ подписи — самое вероятное техническое объяснение такой
 * тишины (App Secret сменился, реклама привязана к другому приложению Meta) —
 * теперь виден и в ErrorLog, и в Telegram при первом появлении.
 */
async function verifySignature(req: Request): Promise<boolean> {
  // Два приложения Meta подписывают вебхуки по-разному: Instagram-приложение
  // (appSecret) и приложение Messenger/страницы (fbAppSecret). Принимаем любой
  // из заданных секретов. Разбор 09.11.2026: весь /webhooks/messenger получал 403,
  // и вместе с ним терялись сообщения людей (пересланные посты, «Курс»).
  const secrets = (await Promise.all([getSetting("appSecret"), getSetting("fbAppSecret")])).filter(
    (v): v is string => !!v,
  );
  if (secrets.length === 0) {
    logError(
      "webhook:signature",
      new Error(
        "Секрет приложения Meta не задан — входящий вебхук отклонён. " +
          "Впишите «Секрет приложения Meta» в настройках, чтобы возобновить приём подписанных событий."
      )
    );
    return false;
  }
  const header = req.header("x-hub-signature-256");
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!header || !raw) {
    logError("webhook:signature", new Error("Вебхук пришёл без заголовка подписи или без тела запроса — отклонён"));
    return false;
  }
  const got = Buffer.from(header);
  for (const secret of secrets) {
    const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"));
    if (expected.length === got.length && crypto.timingSafeEqual(got, expected)) return true;
  }
  let object = "?";
  try {
    object = String(JSON.parse(raw.toString("utf8"))?.object ?? "?");
  } catch {
    /* тело не JSON — оставляем «?» */
  }
  logError(
    "webhook:signature",
    new Error(
      `Подпись вебхука не совпала ни с одним секретом (путь ${req.path}, object=${object}, секретов задано: ${secrets.length}) — 403. ` +
        "Проверьте оба секрета в Настройках: Instagram-приложения и приложения Messenger."
    )
  );
  return false;
}

// Проверочный запрос Meta при подключении вебхука — общий для обоих каналов
// (у Instagram и Messenger он одинаковый, различаются только адреса).
webhookRouter.get(["/webhooks/instagram", "/webhooks/messenger"], async (req, res) => {
  const verifyToken = await getSetting("verifyToken");
  if (
    req.query["hub.mode"] === "subscribe" &&
    verifyToken &&
    req.query["hub.verify_token"] === verifyToken
  ) {
    res.send(String(req.query["hub.challenge"] ?? ""));
    return;
  }
  res.sendStatus(403);
});

/**
 * Один адрес на оба канала. Meta различает их полем `object`: "instagram" —
 * директ и комментарии Instagram, "page" — Messenger страницы Facebook. Формат
 * событий у них одинаковый (Messenger Platform), поэтому обработчик общий, а
 * канал прокидывается вниз — от него зависит, каким маркером отвечать.
 */
webhookRouter.post(["/webhooks/instagram", "/webhooks/messenger"], async (req, res) => {
  // Meta ждёт быстрый 200 — иначе начнёт дублировать доставку.
  if (!(await verifySignature(req))) {
    res.sendStatus(403);
    return;
  }
  // Runtime-валидация: Meta иногда меняет формат вебхука, и без проверки
  // неожиданные поля приводят к silent undefined-access глубоко в логике.
  // Здесь проверяем только верхнюю структуру — детали парсятся ниже по мере
  // необходимости, чтобы не дублировать схему для каждого подтипа события.
  const BodySchema = z.object({
    object: z.enum(["instagram", "page"]),
    entry: z.array(z.object({
      id: z.string().optional(),
      messaging: z.array(z.record(z.string(), z.unknown())).optional(),
      changes: z.array(z.record(z.string(), z.unknown())).optional(),
    }).passthrough()),
  }).passthrough();
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    logError("webhook:invalidPayload", new Error(`Malformed webhook body: ${parsed.error.message}`));
    res.sendStatus(400);
    return;
  }
  const body = parsed.data as WebhookBody;
  const channel: MetaChannel = body.object === "page" ? "MESSENGER" : "INSTAGRAM";
  const events: InboxEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) events.push({ channel, selfId: entry.id, kind: "message", event: event as Record<string, unknown> });
    for (const event of entry.changes ?? []) events.push({ channel, selfId: entry.id, kind: "comment", event: event as Record<string, unknown> });
  }
  try {
    await acceptWebhookEvents(events);
    res.sendStatus(200);
    void runWebhookInbox().catch((err) => logError("webhookInbox", err));
  } catch (err) {
    logError("webhook:accept", err);
    res.sendStatus(503); // Not committed: Meta must redeliver.
  }
});

export async function runWebhookInbox(): Promise<void> {
  await processWebhookInbox(async ({ channel, selfId, kind, event }) => {
    if (kind === "message") {
      const messageEvent = event as MessagingEvent;
      if (messageEvent.message && !messageEvent.message.mid) {
        messageEvent.message.mid = `inbox:${inboxKey({ channel, selfId, kind, event })}`;
      }
      await handleMessage(messageEvent, selfId, channel, true);
      return;
    }
    const change = event as CommentChange;
    const isComment = channel === "INSTAGRAM" ? change.field === "comments"
      : change.field === "feed" && change.value?.item === "comment" && change.value?.verb === "add";
    if (!isComment || !change.value) return;
    const v = change.value;
    const commentId = v.id ?? v.comment_id;
    const authorId = v.from?.id;
    const text = v.text ?? v.message;
    if (!commentId || !authorId || !text || authorId === selfId) return;
    await handleComment({ commentId, mediaId: v.media?.id ?? v.post_id ?? null,
      igUserId: authorId, username: v.from?.username ?? v.from?.name ?? null, text, channel });
  });
}

function toAttachments(raw: MessagingEvent["message"]): Attachment[] {
  return (raw?.attachments ?? [])
    .filter((a) => a.type && KNOWN_KINDS.has(a.type) && a.payload?.url)
    .map((a) => ({ url: a.payload!.url as string, kind: a.type as Attachment["kind"] }));
}

/**
 * Эхо (is_echo=true) — исходящее сообщение, отражённое вебхуком. Два источника:
 *  1) наш же вызов sendText — mid уже есть в базе (мы сами его туда положили
 *     сразу после отправки), это просто подтверждение, ничего не делаем;
 *  2) ЖИВАЯ хозяйка ответила из приложения Instagram — такого mid в базе ещё
 *     нет. Записываем в историю и ставим паузу автоответов: humanSilenceHours
 *     (по умолчанию 3 часа) от её ПОСЛЕДНЕГО ответа — человек взял разговор
 *     на себя (владелец 09.11.2026: раньше пауза была навсегда).
 */
/** Экспорт ради юнит-теста транзакции (tests/unit/webhookEcho.test.ts); из кода снаружи не вызывать. */
export async function handleEcho(event: MessagingEvent, channel: MetaChannel = "INSTAGRAM"): Promise<void> {
  const msg = event.message;
  const recipientId = event.recipient?.id;
  if (!msg?.mid || !recipientId) return;

  const known = await prisma.message.findUnique({ where: { mid: msg.mid } });
  if (known) return; // наша же отправка, эхо от Meta — не человек

  const contact = await upsertContact(recipientId, null, channel);

  // Запись эха и «замолчать боту» — ОДНОЙ транзакцией. Meta шлёт вебхук
  // повторно, если не получила 200 вовремя: два одинаковых эха приходили
  // почти одновременно, первый писал сообщение, второй падал на дубликате mid
  // (P2002), но ОБА продлевали humanSilencedUntil и оба запускали обучение
  // ниже — один и тот же ответ Ширин ложился в образцы дважды. Теперь дубликат
  // откатывает транзакцию целиком и на этом заканчивает: всё нужное уже сделал
  // первый вебхук.
  const recorded = await prisma
    .$transaction(async (tx) => {
      await tx.message.create({
        // byHuman: это писала Ширин из приложения, а не бот. Отсюда потом собирается
        // список «бот ответил плохо — вот как надо» (см. раздел «Качество»).
        data: { contactId: contact.id, direction: "OUT", mid: msg.mid, text: msg.text?.trim() || null, byHuman: true },
      });
      // Отметка обновляется на КАЖДОМ её сообщении, а не только на первом:
      // пауза бота временная и считается от её последнего ответа
      // (messaging/automation.ts::humanTakeoverActive, владелец 09.11.2026).
      await tx.contact.updateMany({
        where: { id: contact.id },
        data: { humanTakenOverAt: new Date(), humanTakeoverMid: msg.mid, humanSilencedUntil: null },
      });
      return true;
    })
    .catch((err) => {
      // P2002 = дубликат mid (гонка с параллельным вебхуком) — это нормально.
      if ((err as { code?: string })?.code !== "P2002") {
        logError("webhook:handleEcho:record", err);
        throw err;
      }
      return false;
    });
  if (!recorded) return;

  // Ширин написала сама — отложенные шаги воронки этому человеку больше не уходят
  // (разбор 11.11.2026: видео и реквизиты прилетали через 3 часа поверх её разговора).
  await cancelPendingFunnelSteps(contact.id, "остановлено: Ширин ответила сама");

  /**
   * ГОЛОСОВОЙ/ФОТО/ВИДЕО ОТВЕТ ХОЗЯЙКИ — СОХРАНЯЕМ И РАСШИФРОВЫВАЕМ (22.08,
   * расширено 24.08.2026).
   *
   * Ширин часто отвечает клиенткам голосом прямо из приложения, иногда фото или
   * видео. Раньше такое эхо ложилось в историю пустым (если без подписи) или
   * только текстом расшифровки — сам файл скачивался только для распознавания
   * речи и тут же выбрасывался. Дальше это рвалось сразу в двух местах: модель
   * не видела середину разговора (вопрос — пустота — продолжение) и отвечала
   * невпопад, а обучение манере не получало образца ни по голосу, ни по фото —
   * при том что живые ответы хозяйки самые ценные, там нет редактуры.
   *
   * Ссылка Instagram на вложение короткоживущая — если её не скачать сейчас, то
   * потом уже никогда (проверено 24.08: у отправленных на прошлой неделе
   * голосовых ссылки в архиве Graph API вообще не возвращаются). Поэтому файл
   * скачивается и сохраняется своей копией прямо здесь, даже если распознавание
   * речи не пригодится (фото/видео) или не получится.
   *
   * Пауза уже записана выше. Медленные скачивание и расшифровка
   * только дополняют историю и не оставляют окно для ответа бота.
   */
  const attachment = (msg.attachments ?? []).find(
    (a) => a.type === "audio" || a.type === "image" || a.type === "video"
  );
  const attachmentUrl = attachment?.payload?.url;
  const voiceText = attachment?.type === "audio" && attachmentUrl ? await voiceToText(attachmentUrl) : null;
  const echoText = msg.text?.trim() || voiceText;

  let ownerMedia: OwnerMedia | undefined;
  if (attachmentUrl && (attachment?.type === "audio" || attachment?.type === "image" || attachment?.type === "video")) {
    const downloaded = await fetchAttachment(attachmentUrl).catch((err) => {
      logError("webhook:handleEcho:fetchAttachment", err);
      return null;
    });
    const savedUrl = downloaded ? saveOwnerMedia(downloaded.buffer, downloaded.mimeType) : null;
    if (savedUrl) ownerMedia = { url: savedUrl, type: attachment.type };
  }

  // Enrich the already-recorded echo only after the durable takeover is active.
  if (echoText || ownerMedia) {
    await prisma.message.updateMany({ where: { mid: msg.mid, byHuman: true }, data: { text: echoText ?? null, ...(ownerMedia?.type === "image" ? { imageUrl: ownerMedia.url } : {}) } });
  }


  // ЖИВОЕ ОБУЧЕНИЕ. Хозяйка ответила сама — значит показала, как надо. Берём
  // последнее сообщение клиента и её ответ (текст и/или сам файл) как образец:
  // чем дольше система работает, тем ближе бот к её стилю. Фото/видео БЕЗ
  // подписи тоже учит — сама картинка уже ответ, терять её из-за пустого текста
  // нельзя (см. rememberOwnerReply).
  if (echoText || ownerMedia) {
    // Graph may return its send result after the echo. Give recordOutgoingMessage
    // time to correct byHuman before admitting this sample into style learning.
    await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
    if (!(await prisma.message.findUnique({ where: { mid: msg.mid } }))?.byHuman) return;
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    await rememberOwnerReply(lastIn?.text ?? "", echoText ?? "", "TAKEOVER", ownerMedia, contact.id).catch((err) =>
      logError("webhook:learn", err)
    );
  }
}

/** Фото пришло, но скачать не вышло даже с повтором — просим прислать ещё раз,
 *  вместо того чтобы отвечать так, будто ничего не было (см. лог выше). */
const COULD_NOT_LOAD_PHOTO: Record<ClientLanguage, string> = {
  ru: "Вижу, что вы что-то прислали, но фото не загрузилось. Пришлите ещё раз",
  tg: "Мебинам ки чизе фиристодед, аммо сурат кушода нашуд. Боз як бор фиристен",
  en: "I can see you sent something, but the photo didn't load. Could you send it again?",
};

const ABUSE_LABEL: Record<NonNullable<ReturnType<typeof detectAbuse>>, string> = {
  flirt: "флирт",
  insult: "оскорбление",
  spam: "рекламный спам",
};

/** Одна дверь с отправкой: пауза после живого ответа Ширин временная (см. automation.ts). */
function isHumanSilenced(contact: { channel?: string; humanSilencedUntil: Date | null; humanTakenOverAt?: Date | null }): boolean {
  return humanSilenceActive(contact);
}

/**
 * Реакция хозяйки на сообщение — молчим, как после её текста.
 *
 * Реакция клиента нас не касается: молчать надо, когда разговор берёт на себя
 * ЧЕЛОВЕК С НАШЕЙ СТОРОНЫ. Отличаем по отправителю: если реакцию поставил наш же
 * аккаунт — это она.
 */
async function handleReaction(event: MessagingEvent, selfId?: string, channel: MetaChannel = "INSTAGRAM"): Promise<void> {
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  // Реакция ОТ нас: отправитель — наш аккаунт, а собеседник лежит в recipient.
  if (!senderId || senderId !== selfId || !recipientId) return;
  if (event.reaction?.action === "unreact") return; // сняла реакцию — не вмешательство
  // Реакцию поставил сам бот (ai/reactions.ts) — это не хозяйка, молчать после неё не нужно.
  if (wasOurRecentReaction(recipientId)) return;

  const contact = await upsertContact(recipientId, null, channel);
  await prisma.contact.update({
    where: { id: contact.id },
    data: { humanSilencedUntil: new Date(Date.now() + HUMAN_TAKEOVER_SILENCE_MS) },
  });
}

export async function handleMessage(event: MessagingEvent, selfId?: string, channel: MetaChannel = "INSTAGRAM", resume = false): Promise<void> {
  const msg = event.message;
  const senderId = event.sender?.id;
  if (event.reaction) {
    await handleReaction(event, selfId, channel);
    return;
  }
  // Метка рекламы — до всех фильтров ниже: даже если на само сообщение бот
  // промолчит, знать, что человек пришёл из объявления, нужно для отчёта о
  // продажах и для передачи оплаты в Meta.
  // Отдельное событие без сообщения (открыл переписку, кнопка «Начать») контакт
  // НЕ создаёт — иначе счётчик новых заявок вырос бы на тех, кто не написал.
  // Сбой здесь не должен задержать само сообщение: только запись в журнал.
  const referral = senderId && senderId !== selfId && !msg?.is_echo
    ? referralFromMeta(msg?.referral ?? event.referral ?? event.postback?.referral) : null;
  if (referral && senderId) {
    try {
      const existing = msg
        ? await prisma.contact.upsert({
            where: { channel_igUserId: { channel, igUserId: senderId } },
            create: { channel, igUserId: senderId }, update: {}, select: { id: true },
          })
        : await prisma.contact.findUnique({ where: { channel_igUserId: { channel, igUserId: senderId } }, select: { id: true } });
      if (existing) await recordAdReferral(existing.id, referral);
    } catch (err) {
      logError("webhook:adReferral", err);
    }
  }
  if (!msg) return;
  if (msg.is_echo || senderId === selfId) {
    await handleEcho(event, channel);
    return;
  }
  if (!senderId) return;

  const text = msg.text ?? null;
  const payload = msg.quick_reply?.payload ?? null;
  const attachments = toAttachments(msg);

  /**
   * ПЕРЕСЛАННЫЙ РИЛС / ОТВЕТ НА ИСТОРИЮ. Meta присылает не файл, а адрес
   * публикации. Дальше два разных исхода:
   *  — это НАША публикация: бот берёт её подпись и обложку из своей ленты и
   *    отвечает по существу («сколько стоит?» — про этот самый курс);
   *  — это ЧУЖАЯ публикация: посмотреть её мы не можем, Meta чужие файлы не
   *    отдаёт, а гадать — значит выдумывать. Решение владельца: молчание.
   */
  const sharedAttachment = (msg.attachments ?? []).find((a) => a.type && SHARED_TYPES.has(a.type));
  const sharedUrl = sharedAttachment?.payload?.url ?? msg.reply_to?.story?.url;
  const reelId = sharedAttachment?.payload?.reel_video_id;
  const sharedMediaId = msg.reply_to?.story?.id ?? (reelId !== undefined && reelId !== null ? String(reelId) : undefined);
  /** Ответ на ИСТОРИЮ (reply_to.story) — это всегда НАША история: ответить на
   *  чужую историю в наш директ нельзя. */
  const repliesToOurStory = Boolean(msg.reply_to?.story);
  let ownMediaHint: string | undefined;

  if (sharedUrl || sharedMediaId) {
    const own = await findOwnMedia({ url: sharedUrl, mediaId: sharedMediaId }).catch((err) => {
      logError("webhook:handleIncomingDm:findOwnMedia", err);
      return null;
    });
    if (own) {
      // Обложку отдаём модели глазами, подпись — текстом: вместе они объясняют,
      // о чём спрашивает человек, лучше, чем сам ролик без подписи.
      const preview = viewableUrl(own);
      if (preview) attachments.push({ url: preview, kind: "image" });
      ownMediaHint =
        `[Человек прислал НАШУ публикацию и спрашивает про неё. Подпись публикации: ` +
        `${own.caption?.slice(0, 600) || "(без подписи)"}]`;
    } else if (repliesToOurStory) {
      // ОТВЕТ НА НАШУ ИСТОРИЮ, КОТОРУЮ НЕ НАШЛИ В ЛЕНТЕ (разбор 09.11.2026).
      // Раньше это считалось «чужим роликом» и молчало, а с ним пропадал и сам
      // вопрос: «сколько стоит курс?» под свежей историей терялся целиком, даже
      // в базу не попадал. История не находится, когда её только что выложили
      // (лента в памяти несколько минут), когда она уже исчезла или когда Meta
      // не отдала /me/stories. Но чья она — известно точно: ответить на чужую
      // историю в наш директ нельзя. Отвечаем на текст человека, не выдумывая
      // её содержимое.
      ownMediaHint = "[Человек ответил на НАШУ историю в Instagram. Что было в истории, нам не видно — отвечайте на его слова и не описывайте саму историю.]";
    } else if (text && showsCourseInterest(text)) {
      // ЧУЖАЯ публикация, но в том же сообщении вопрос про курс или цену —
      // отвечаем на вопрос (владелец 09.11.2026: «если касаются курса — в
      // личку»). Саму публикацию по-прежнему не обсуждаем: её не видно.
      ownMediaHint = "[Человек переслал чужую публикацию — её содержимое нам не видно. Отвечайте только на его вопрос, саму публикацию не описывайте.]";
    } else {
      return; // чужой ролик без вопроса про курс — молчим (решение владельца)
    }
  }

  // Раньше сообщение без текста (только фото/видео/голосовое) отбрасывалось здесь —
  // бот их физически не видел. Теперь вложение без подписи тоже доходит до ИИ.
  if (!text && !payload && attachments.length === 0) return;

  let contact = await upsertContact(senderId, null, channel);
  await loadHumanSilenceMs();
  if (msg.mid) {
    try {
      await prisma.message.create({ data: { contactId: contact.id, direction: "IN", mid: msg.mid, text, payload } });
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err;
      if (!resume) return;
    }
  }


  /**
   * ГОЛОСОВОЕ ОТ КЛИЕНТКИ — РАСШИФРОВЫВАЕМ СРАЗУ.
   *
   * В Таджикистане голосом пишут очень много: печатать на телефоне долго, а на
   * таджикской раскладке ещё и неудобно. До этой правки такое сообщение
   * доходило до модели файлом, но БЕЗ текста — и весь разбор, который смотрит
   * на слова, для него просто не выполнялся: ни защита от офф-топика, ни
   * картинки меню, ни повтор голосовых Ширин, ни отправка отзыва. Голосом
   * спрашивали то же самое, что и текстом, а получали заметно более бедный
   * ответ.
   *
   * Хуже того, в истории переписки такие сообщения оставались пустыми: модель
   * потом читала разговор с дырами и отвечала невпопад — ровно та же беда,
   * которую уже чинили для голосовых Ширин (см. handleEcho выше).
   *
   * Расшифровка идёт ДО записи в базу, чтобы текст лёг сразу и попал и в
   * историю, и в ответ. Не получилось — работаем как раньше, файлом.
   */
  const voice = attachments.find((a) => a.kind === "audio");
  let recognized: string | null = null;
  const frozen = (await getSetting("botFrozen")) === "true";
  if (!frozen && !text && voice) {
    recognized = await voiceToText(voice.url).catch((err) => {
      logError("webhook:incomingVoice", err);
      return null;
    });
  }
  const textOrVoice = text ?? recognized;

  // Личный контакт хозяйки (мама, сестра, подруга) — бот молчит навсегда. Запись
  // в историю всё равно идёт: переписка сохраняется, просто без ответов бота.
  // То же для заблокированных за спам/флирт (владелец 05.09.2026) — снять
  // блок можно из панели «Ученицы».
  // Исключение — АВТО-отметка «Ширин подписана»: если человек нажал кнопку
  // воронки или пишет про курс/цену, это клиент, и отметка снимается
  // (profiles.ts::releaseFollowSilenceIfClient, владелец 09.11.2026). Ручную
  // отметку бот не снимает никогда.
  contact = await releaseFollowSilenceIfClient(contact, { text: textOrVoice, payload });
  if (msg.mid && recognized) await prisma.message.update({ where: { mid: msg.mid }, data: { text: recognized } });
  if (contact.personal || contact.spamBlockedAt || contact.whatsappSavedContact) return;

  // На кого подписана Ширин (знакомые, родня, поставщики) — бот молчит; платящих,
  // пишущих про курс и тех, кто прислал картинку (возможный чек), не трогаем.
  // См. profiles.ts.
  if (await silenceIfFollowedByBusiness(contact, { hasImage: attachments.some((a) => a.kind === "image"), text: textOrVoice, payload })) return;


  // ФЛИРТ / ОСКОРБЛЕНИЯ / РЕКЛАМНЫЙ СПАМ / ВИДЕО БЕЗ ТЕКСТА в директе от того,
  // кто не покупал (владелец 05.09.2026): блокируем сразу, без ответа. Оплатившую
  // ученицу не блокируем никогда — у неё может быть претензия резкими словами,
  // и она имеет право прислать видео своего десерта.
  if (!contact.paid) {
    const abuse = textOrVoice ? detectAbuse(textOrVoice) : null;
    const videoOnly = !textOrVoice && attachments.some((a) => a.kind === "video");
    if (abuse || videoOnly) {
      const reason = abuse ? `${ABUSE_LABEL[abuse]}: «${(textOrVoice ?? "").slice(0, 100)}»` : "видео без текста от нового человека";
      await prisma.contact
        .update({ where: { id: contact.id }, data: { spamBlockedAt: new Date(), spamReason: reason } })
        .catch((err) => logError("webhook:spamBlock", err));
      return;
    }
  }

  if (textOrVoice && looksPersonal(textOrVoice)) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { personal: true, personalReason: `Похоже на личную переписку: «${textOrVoice.slice(0, 100)}»` },
    });
    return;
  }

  // Клиент написал сам (не нажал кнопку) — отложенные шаги воронки отменяются:
  // разговор пошёл живьём, шаблон поверх него звучит как автомат (пункт 6, 11.11.2026).
  if (!payload && (textOrVoice || attachments.length > 0)) {
    await cancelPendingFunnelSteps(contact.id, "остановлено: клиент написал сам");
  }
  const hasAttachments = attachments.length > 0;

  // Frozen means funnel-only, including before receipt intake and signup.
  // Preserve the incoming history and human takeover rules, then stop here.
  if (frozen || (await getSetting("botFrozen")) === "true") {
    if (!isHumanSilenced(contact)) await handleIncomingDm(contact, textOrVoice, payload, { hasAttachments, aiAvailable: false });
    return;
  }

  // Only the confirmed pending course delivery may continue after human takeover.
  // The deterministic handler reloads receipt evidence and all contact gates.
  if (textOrVoice && await handleDeliveryChoiceReply(contact, textOrVoice)) return;

  // Запись на офлайн-курс — детерминированно и до всех фильтров ниже: номер
  // телефона от желающего не должен пропасть из-за воронки, паузы или бюджета.
  await registerOfflineIfAsked(contact, textOrVoice).catch((err) => logError("webhook:offlineSignup", err));

  // СПАСАЕМ КАРТИНКИ ДО проверки isHumanSilenced, а не после (живой случай
  // 23.08.2026: roza97788 прислала чек ровно во время паузы после ответа Ширин —
  // бот вернулся бы здесь же и картинка пропала бы навсегда, ссылку так и не
  // выдали). Скачивается, сохраняется своя копия и встаёт в очередь разбора
  // (receiptRetry.ts подхватит её фоновым тиком) независимо от того, ответит ли
  // бот текстом прямо сейчас.
  const hasImageAttachment = attachments.some((a) => a.kind === "image");
  const rescuedImages: RescuedImage[] = hasImageAttachment
    ? await rescueIncomingImages(contact, attachments).catch((err) => {
        logError("webhook:rescue", err);
        return [];
      })
    : [];

  // ФОТО ПРИШЛО, НО НЕ СКАЧАЛОСЬ (живой случай 05.09.2026, @lazina_0101 — см.
  // media.ts). Раньше в этот ход бумажный след не оставался вовсе: разговор
  // шёл дальше с пустым текстом, и свободная модель один раз уже подтвердила
  // «Кабул кардем, хозир дохил мекнем» тому, чей чек мы на самом деле потеряли
  // — человек ушёл ждать ссылку, которая никогда не придёт. Единственное
  // вложение сообщения — картинка, текста нет, спасти не удалось (даже с
  // повтором в fetchAttachment) — отвечаем сами и честно, до модели этот ход
  // не доходит вовсе, тем же приёмом, что и ai/receiptClaim.ts.
  if (hasImageAttachment && rescuedImages.length === 0 && !textOrVoice && !isHumanSilenced(contact) && (await getSetting("botFrozen")) !== "true") {
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    const language = await contactLanguage(contact.id, lastIn?.text ?? "");
    const text = COULD_NOT_LOAD_PHOTO[language];
    const mid = await sendToContact(contact, text);
    if (mid) await recordOutgoingMessage(contact.id, text, mid);
    return;
  }

  // Хозяйка сама ведёт разговор — бот не встревает, даже если пришли кнопка или
  // ключевое слово воронки. Пауза временная: humanSilenceHours от её последнего
  // ответа (messaging/automation.ts); пропущенное за паузу подберёт сторож
  // unansweredWatch.ts.
  if (isHumanSilenced(contact)) {
    // ЧЕК ПРИ ШИРИН (владелец 11.11.2026): Ширин переписывается, а клиент прислал
    // настоящий чек — бот САМ проверяет его сразу и выдаёт ссылку (дверь
    // verified_receipt_access пропускает это через паузу). Раньше чек ждал
    // фоновой перепроверки 3+ минуты, Ширин за это время отправляла ссылку
    // руками, и владельцу уходило «Чек требует проверки: похоже, Ширин уже
    // отправила ссылку вне системы». Текстом бот по-прежнему не отвечает.
    if (rescuedImages.length > 0) {
      await verifyReceiptsNow(contact, rescuedImages).catch((err) => logError("webhook:receiptDuringHuman", err));
    }
    return;
  }

  const aiAvailable = (await getSetting("aiEnabled")) === "true";
  const handledByFunnel = await handleIncomingDm(contact, textOrVoice, payload, { hasAttachments, aiAvailable });
  if (handledByFunnel || (!textOrVoice && attachments.length === 0)) return;

  // Человеческий тайминг: ждём, вдруг человек допишет ещё пузырь — отвечаем на
  // всё сразу одним ответом (окно и потолок — debounce.ts).
  // Подсказка про нашу публикацию идёт вместе с текстом человека — модель должна
  // знать, о чём он спрашивает, ещё до того, как посмотрит обложку.
  const textForAi = ownMediaHint ? `${ownMediaHint}\n${textOrVoice ?? ""}`.trim() : textOrVoice ?? "";

  await debounceMessage(contact.id, textForAi, attachments, rescuedImages, async (mergedText, mergedAttachments, mergedRescued) => {
    const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
    if (!fresh || isHumanSilenced(fresh)) return; // за время ожидания подключилась хозяйка — картинки уже спасены выше
    await aiReply(fresh, mergedText, mergedAttachments, mergedRescued);
  });
}
