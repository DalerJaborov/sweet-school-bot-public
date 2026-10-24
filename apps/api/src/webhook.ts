import { Router, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { upsertContact, handleIncomingDm, handleComment } from "./funnel.js";
import { aiReply, registerOfflineIfAsked, rescueIncomingImages, type RescuedImage } from "./ai.js";
import { sendToContact } from "./messaging/send.js";
import { debounceMessage } from "./debounce.js";
import { looksPersonal } from "./ai/personalContact.js";
import { detectAbuse } from "./ai/abuseFilter.js";
import { detectClientLanguage, type ClientLanguage } from "./ai/clientLanguage.js";
import { rememberOwnerReply, type OwnerMedia } from "./ai/styleLearning.js";
import { voiceToText } from "./ai/voiceToText.js";
import { findOwnMedia, viewableUrl } from "./ownMedia.js";
import { fetchAttachment, type Attachment } from "./ai/media.js";
import { saveOwnerMedia } from "./upload.js";
import type { MetaChannel } from "./instagram.js";

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
    attachments?: { type?: string; payload?: { url?: string } }[];
    /** Ответ на нашу историю: Meta кладёт сюда её адрес и id. */
    reply_to?: { story?: { url?: string; id?: string }; mid?: string };
  };
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
  const secret = await getSetting("appSecret");
  if (!secret) {
    /**
     * ПУСТОЙ СЕКРЕТ — ЭТО ПЛОХО, НО ЗАКРЫВАТЬ ДВЕРЬ НЕЛЬЗЯ.
     *
     * Разбор безопасности 03.09.2026 верно указал: «не настроено, значит не
     * проверяем» — опасная трактовка. Кто угодно может прислать выдуманное
     * входящее от имени существующей ученицы и, попав в слова «потеряла
     * доступ», выбить её из курса: ей выпустится новая ссылка, а нынешняя
     * умрёт.
     *
     * Но переключить это на отказ вслепую оказалось хуже. Проверено живьём в
     * тот же день: в проде `appSecret` лежит ПУСТОЙ строкой, и строгая
     * проверка мгновенно отклонила все входящие из Instagram — школа
     * замолчала целиком. Тихий отказ ровно того вида, которого мы избегаем,
     * только устроенный своими руками.
     *
     * Поэтому пока секрет не задан: работаем, но громко. Ошибка в журнале
     * поднимает тревогу владельцу, и та же причина видна в /health. Как только
     * секрет впишут — проверка становится строгой сама, без правки кода.
     */
    logError(
      "webhook:signature",
      new Error(
        "Секрет приложения Meta не задан — подпись входящих не проверяется. " +
          "Впишите «Секрет приложения Meta» в настройках: без него посторонний может прислать боту выдуманное сообщение от имени ученицы."
      )
    );
    return true;
  }
  const header = req.header("x-hub-signature-256");
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!header || !raw) {
    logError("webhook:signature", new Error("Вебхук пришёл без заголовка подписи или без тела запроса — отклонён"));
    return false;
  }
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    if (!ok) {
      logError(
        "webhook:signature",
        new Error(
          "Подпись вебхука не совпала с App Secret — Meta отклонён кодом 403 ещё до разбора тела. " +
            "Проверьте App Secret в Настройках либо не привязана ли реклама к другому приложению Meta."
        )
      );
    }
    return ok;
  } catch {
    logError("webhook:signature", new Error("Подпись вебхука не сравнилась (неверная длина заголовка)"));
    return false;
  }
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
  res.sendStatus(200);

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
    return;
  }
  const body = parsed.data as WebhookBody;
  if (!Array.isArray(body.entry)) return;
  const channel: MetaChannel = body.object === "page" ? "MESSENGER" : "INSTAGRAM";

  try {
    for (const entry of body.entry) {
      const selfId = entry.id;
      for (const event of entry.messaging ?? []) {
        await handleMessage(event, selfId, channel).catch((err) => logError("webhook:message", err));
      }
      for (const change of entry.changes ?? []) {
        // Комментарий приходит по-разному: у Instagram это поле "comments", у
        // страницы Facebook — "feed" с item:"comment" (в том же "feed" летят и
        // лайки, и новые посты, поэтому вид проверяем отдельно).
        const isIgComment = channel === "INSTAGRAM" && change.field === "comments";
        const isFbComment =
          channel === "MESSENGER" &&
          change.field === "feed" &&
          change.value?.item === "comment" &&
          change.value?.verb === "add";
        if ((!isIgComment && !isFbComment) || !change.value) continue;

        const v = change.value;
        // У Facebook идентификатор комментария лежит в comment_id, а автор — во
        // вложенном from; у Instagram и то и другое в корне.
        const commentId = v.id ?? v.comment_id;
        const authorId = v.from?.id;
        const text = v.text ?? v.message;
        if (!commentId || !authorId || !text) continue;
        if (authorId === selfId) continue; // свои комментарии не триггерят воронку

        await handleComment({
          commentId,
          mediaId: v.media?.id ?? v.post_id ?? null,
          igUserId: authorId,
          username: v.from?.username ?? v.from?.name ?? null,
          text,
          channel,
        }).catch((err) => logError("webhook:comment", err));
      }
    }
  } catch (err) {
    logError("webhook", err);
  }
});

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
 *     нет. Записываем в историю (для памяти разговора) и молчим 20 минут с ЭТИМ
 *     клиентом — человек взял разговор на себя.
 */
/** Экспорт ради юнит-теста транзакции (tests/unit/webhookEcho.test.ts); из кода снаружи не вызывать. */
export async function handleEcho(event: MessagingEvent, channel: MetaChannel = "INSTAGRAM"): Promise<void> {
  const msg = event.message;
  const recipientId = event.recipient?.id;
  if (!msg?.mid || !recipientId) return;

  const known = await prisma.message.findUnique({ where: { mid: msg.mid } });
  if (known) return; // наша же отправка, эхо от Meta — не человек

  const contact = await upsertContact(recipientId, null, channel);

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
   * Расшифровка и скачивание идут ДО записи в базу, чтобы текст и ссылка легли
   * сразу: дописывать их потом значит гонку с ответом бота, который уже читает
   * историю.
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
        data: { contactId: contact.id, direction: "OUT", mid: msg.mid, text: echoText ?? null, byHuman: true },
      });
      await tx.contact.update({
        where: { id: contact.id },
        data: { humanSilencedUntil: new Date(Date.now() + HUMAN_TAKEOVER_SILENCE_MS) },
      });
      return true;
    })
    .catch((err) => {
      // P2002 = дубликат mid (гонка с параллельным вебхуком) — это нормально.
      if ((err as { code?: string })?.code !== "P2002") {
        logError("webhook:handleEcho:record", err);
      }
      return false;
    });
  if (!recorded) return;

  // ЖИВОЕ ОБУЧЕНИЕ. Хозяйка ответила сама — значит показала, как надо. Берём
  // последнее сообщение клиента и её ответ (текст и/или сам файл) как образец:
  // чем дольше система работает, тем ближе бот к её стилю. Фото/видео БЕЗ
  // подписи тоже учит — сама картинка уже ответ, терять её из-за пустого текста
  // нельзя (см. rememberOwnerReply).
  if (echoText || ownerMedia) {
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
  ru: "Вижу, что вы что-то прислали, но фото не загрузилось 🙏 Пришлите, пожалуйста, ещё раз.",
  tg: "Мебинам, ки чизе фиристодед, аммо расм бор нашуд 🙏 Лутфан бори дигар фиристед.",
  en: "I can see you sent something, but the photo didn't load 🙏 Could you send it again?",
};

const ABUSE_LABEL: Record<NonNullable<ReturnType<typeof detectAbuse>>, string> = {
  flirt: "флирт",
  insult: "оскорбление",
  spam: "рекламный спам",
};

function isHumanSilenced(contact: { humanSilencedUntil: Date | null }): boolean {
  return !!contact.humanSilencedUntil && contact.humanSilencedUntil.getTime() > Date.now();
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

  const contact = await upsertContact(recipientId, null, channel);
  await prisma.contact.update({
    where: { id: contact.id },
    data: { humanSilencedUntil: new Date(Date.now() + HUMAN_TAKEOVER_SILENCE_MS) },
  });
}

export async function handleMessage(event: MessagingEvent, selfId?: string, channel: MetaChannel = "INSTAGRAM"): Promise<void> {
  const msg = event.message;
  const senderId = event.sender?.id;
  if (event.reaction) {
    await handleReaction(event, selfId, channel);
    return;
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
  const sharedUrl =
    (msg.attachments ?? []).find((a) => a.type && SHARED_TYPES.has(a.type))?.payload?.url ??
    msg.reply_to?.story?.url;
  const sharedStoryId = msg.reply_to?.story?.id;
  let ownMediaHint: string | undefined;

  if (sharedUrl || sharedStoryId) {
    const own = await findOwnMedia({ url: sharedUrl, mediaId: sharedStoryId }).catch((err) => {
      logError("webhook:handleIncomingDm:findOwnMedia", err);
      return null;
    });
    if (!own) return; // чужой ролик — молчим, даже если к нему что-то написали
    // Обложку отдаём модели глазами, подпись — текстом: вместе они объясняют,
    // о чём спрашивает человек, лучше, чем сам ролик без подписи.
    const preview = viewableUrl(own);
    if (preview) attachments.push({ url: preview, kind: "image" });
    ownMediaHint =
      `[Человек прислал НАШУ публикацию и спрашивает про неё. Подпись публикации: ` +
      `${own.caption?.slice(0, 600) || "(без подписи)"}]`;
  }

  // Раньше сообщение без текста (только фото/видео/голосовое) отбрасывалось здесь —
  // бот их физически не видел. Теперь вложение без подписи тоже доходит до ИИ.
  if (!text && !payload && attachments.length === 0) return;

  const contact = await upsertContact(senderId, null, channel);

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
  if (contact.personal || contact.spamBlockedAt) {
    if (msg.mid) {
      await prisma.message
        .create({ data: { contactId: contact.id, direction: "IN", mid: msg.mid, text, payload } })
        .catch((err) => {
          // P2002 = дубликат mid (повторная доставка вебхука) — это нормально.
          if ((err as { code?: string })?.code !== "P2002") {
            logError("webhook:personalContact:createMessage", err);
          }
        });
    }
    return;
  }
  // mid уникален в базе — повторная доставка того же сообщения обрывается здесь.
  // Само сообщение сохраняем ДО проверки looksPersonal ниже — раньше именно то
  // сообщение, из-за которого контакт помечался «личный», нигде не сохранялось
  // (только обрезанный до 100 символов фрагмент в personalReason).
  if (msg.mid) {
    try {
      await prisma.message.create({
        // textOrVoice, а не text: голосовое ложится в историю расшифровкой,
        // иначе модель читает разговор с дырами.
        data: { contactId: contact.id, direction: "IN", mid: msg.mid, text: textOrVoice, payload },
      });
    } catch {
      return;
    }
  }

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

  // Frozen means funnel-only, including before receipt intake and signup.
  // Preserve the incoming history and human takeover rules, then stop here.
  if (frozen || (await getSetting("botFrozen")) === "true") {
    if (!isHumanSilenced(contact)) await handleIncomingDm(contact, textOrVoice, payload);
    return;
  }

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
  if (hasImageAttachment && rescuedImages.length === 0 && !textOrVoice && (await getSetting("botFrozen")) !== "true") {
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    const language = detectClientLanguage(lastIn?.text ?? "");
    const text = COULD_NOT_LOAD_PHOTO[language];
    const mid = await sendToContact(contact, text).catch((err) => {
      logError("webhook:couldNotLoadPhoto:send", err);
      return null;
    });
    if (mid) await recordOutgoingMessage(contact.id, text, mid);
    return;
  }

  // Хозяйка сама ведёт разговор — бот не встревает, даже если пришли кнопка или
  // ключевое слово воронки. Тишина снимается сама через 20 минут без её участия.
  if (isHumanSilenced(contact)) return;

  const handledByFunnel = await handleIncomingDm(contact, textOrVoice, payload);
  if (handledByFunnel || (!textOrVoice && attachments.length === 0)) return;

  // Человеческий тайминг: ждём, вдруг человек допишет ещё пузырь — отвечаем на
  // всё сразу, максимум через 9 секунд после последнего сообщения.
  // Подсказка про нашу публикацию идёт вместе с текстом человека — модель должна
  // знать, о чём он спрашивает, ещё до того, как посмотрит обложку.
  const textForAi = ownMediaHint ? `${ownMediaHint}\n${textOrVoice ?? ""}`.trim() : textOrVoice ?? "";

  debounceMessage(contact.id, textForAi, attachments, rescuedImages, async (mergedText, mergedAttachments, mergedRescued) => {
    const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
    if (!fresh || isHumanSilenced(fresh)) return; // за время ожидания подключилась хозяйка — картинки уже спасены выше
    await aiReply(fresh, mergedText, mergedAttachments, mergedRescued).catch((err) => logError("webhook:aiReply", err));
  });
}
