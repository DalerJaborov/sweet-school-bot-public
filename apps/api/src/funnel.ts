import { prisma, logError, recordOutgoingMessage } from "./db.js";
import { sendPrivateReply, replyToComment, deleteComment, metaChannelOf, mediaPermalink, type QuickButton, type Channel, type MetaChannel } from "./instagram.js";
import { sendToContact, sendAttachmentToContact } from "./messaging/send.js";
import { instagramShortcode } from "./ownMedia.js";
import { aiReplyToComment } from "./ai.js";
import { detectAbuse } from "./ai/abuseFilter.js";
import { notifyFunnelGaveUp } from "./systemAlerts.js";
import type { Contact, Delivery, Funnel, FunnelStep } from "@prisma/client";
import { parseStepButtonsJson, parseStringArray } from "./json.js";

/**
 * ОТКАЗ ШАГА — РАСТУЩАЯ ПАУЗА, А НЕ МГНОВЕННЫЙ ОКОНЧАТЕЛЬНЫЙ FAILED
 * (30.08.2026, тот же приём и те же числа, что в aiReplyRetry.ts).
 *
 * До этой правки один отказ Instagram API (сеть моргнула, токен на секунду не
 * ответил) хоронил разговор навсегда: `runDueDeliveries` подхватывает только
 * `state: "ACTIVE"`, а `FAILED` для неё не существует. Живой случай 30.08.2026:
 * человек написал с рекламы, воронка стартовала, первая отправка не удалась —
 * и ответа не было вовсе, даже обычным ботом (webhook.ts считает воронку
 * «обработавшей» комментарий независимо от того, ушло ли реально сообщение).
 *
 * Расписание короче, чем у обычного ИИ-ответа (aiReplyRetry.ts, ~13 часов):
 * человек, кликнувший рекламу, ждёт РЕАКЦИИ здесь и сейчас, а не утра. После
 * потолка — окончательный FAILED и персональная тревога в Telegram (не через
 * общий дедуп «Здоровье системы»: каждый такой случай — другой конкретный
 * человек, о котором стоит узнать индивидуально, даже если причина отказа
 * технически повторяется).
 */
const RETRY_DELAYS_MS = [30_000, 60_000, 180_000, 600_000, 1_800_000]; // 30с, 1м, 3м, 10м, 30м
const RETRY_MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 6; // ещё 6×30м ≈ до 4 часов сверху

async function retryOrGiveUp(delivery: Delivery, contact: Contact, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logError("funnel:step", err);

  const failCount = delivery.failCount + 1;
  if (failCount >= RETRY_MAX_ATTEMPTS) {
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { state: "FAILED", failCount, lastError: message, nextRunAt: null },
    });
    const who = contact.username ? `@${contact.username}` : contact.igUserId;
    await notifyFunnelGaveUp(who, failCount, message);
    return;
  }

  const delayMs = RETRY_DELAYS_MS[failCount - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  await prisma.delivery.update({
    where: { id: delivery.id },
    data: { state: "ACTIVE", failCount, lastError: message, nextRunAt: new Date(Date.now() + delayMs) },
  });
}

/** Кнопки шага → quick-reply кнопки Meta с payload вида step:<funnelId>:<order>. */
export function parseStepButtons(step: Pick<FunnelStep, "funnelId" | "buttons">): QuickButton[] {
  return parseStepButtonsJson(step.buttons).map((b) => ({
    title: b.title,
    payload: `step:${step.funnelId}:${b.targetOrder}`,
  }));
}

export function parseTags(contact: Pick<Contact, "tags">): string[] {
  return parseStringArray(contact.tags);
}

async function addTag(contact: Contact, tag: string): Promise<void> {
  const tags = parseTags(contact);
  if (tags.includes(tag)) return;
  tags.push(tag);
  await prisma.contact.update({ where: { id: contact.id }, data: { tags: JSON.stringify(tags) } });
}

export async function upsertContact(
  igUserId: string,
  username?: string | null,
  channel: Channel = "INSTAGRAM"
): Promise<Contact> {
  return prisma.contact.upsert({
    where: { channel_igUserId: { channel, igUserId } },
    create: { channel, igUserId, username: username ?? null },
    update: username ? { username } : {},
  });
}



/** Отправляет один шаг и переводит доставку в следующее состояние. */
async function sendStep(
  delivery: Delivery & { contact: Contact },
  funnel: Funnel,
  step: FunnelStep,
  privateReplyCommentId?: string
): Promise<void> {
  const buttons = parseStepButtons(step);
  const text = step.text.trim();
  let mid: string | null = null;

  // Шаг может быть ЧИСТЫМ вложением — фото меню или видео без подписи, как это
  // было в ManyChat. Тогда текстовое сообщение не шлём вовсе: пустой пузырь
  // выглядел бы как сбой, да и Meta его не примет.
  if (text || buttons.length > 0) {
    if (privateReplyCommentId) {
      mid = await sendPrivateReply(privateReplyCommentId, text, buttons, metaChannelOf(delivery.contact));
    } else {
      mid = await sendToContact(delivery.contact, text, buttons);
    }
    await recordOutgoingMessage(delivery.contactId, text, mid);
  }

  if (step.mediaUrl && step.mediaType) {
    try {
      await sendAttachmentToContact(delivery.contact, step.mediaUrl, step.mediaType as "video" | "image" | "file");
    } catch (err) {
      // Текст уже ушёл — падение вложения не должно ронять всю цепочку.
      logError("funnel:attachment", err);
    }
  }

  if (buttons.length > 0) {
    // Шаг с кнопками ставит цепочку на паузу до нажатия.
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { state: "WAITING", nextRunAt: null },
    });
    return;
  }

  const next = step.stopAfter
    ? null
    : await prisma.funnelStep.findFirst({
        where: { funnelId: funnel.id, order: { gt: step.order } },
        orderBy: { order: "asc" },
      });
  if (!next) {
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { state: "DONE", nextRunAt: null },
    });
    return;
  }
  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      state: "ACTIVE",
      nextOrder: next.order,
      nextRunAt: new Date(Date.now() + next.delaySeconds * 1000),
    },
  });
}

/** Запуск воронки для человека. Повторный запуск той же воронки не происходит —
 *  защита стоит на уникальности пары «воронка + человек». */
export async function startFunnel(
  funnel: Funnel,
  contact: Contact,
  opts: { commentId?: string; commentText?: string } = {}
): Promise<boolean> {
  const firstStep = await prisma.funnelStep.findFirst({
    where: { funnelId: funnel.id },
    orderBy: { order: "asc" },
  });
  if (!firstStep) return false;

  // Проходил ли уже — и не рано ли повторять. Пара «воронка+человек» уникальна,
  // поэтому прошлый заход не создаётся заново, а ПЕРЕЗАПУСКАЕТСЯ, когда окно
  // повтора (repeatAfterDays) прошло.
  const previous = await prisma.delivery.findUnique({
    where: { funnelId_contactId: { funnelId: funnel.id, contactId: contact.id } },
  });
  if (previous) {
    if (funnel.repeatAfterDays <= 0) return false; // повтор запрещён совсем
    const daysSince = (Date.now() - previous.createdAt.getTime()) / 86_400_000;
    if (daysSince < funnel.repeatAfterDays) return false; // ещё рано
  }

  let delivery;
  try {
    delivery = previous
      ? await prisma.delivery.update({
          where: { id: previous.id },
          data: {
            state: "ACTIVE",
            nextOrder: firstStep.order,
            nextRunAt: null,
            lastError: null,
            createdAt: new Date(), // отсчёт окна повтора идёт от нового прохода
            commentId: opts.commentId ?? null,
            commentText: opts.commentText ?? null,
          },
          include: { contact: true },
        })
      : await prisma.delivery.create({
          data: {
            funnelId: funnel.id,
            contactId: contact.id,
            state: "ACTIVE",
            nextOrder: firstStep.order,
            nextRunAt: null,
            commentId: opts.commentId ?? null,
            commentText: opts.commentText ?? null,
          },
          include: { contact: true },
        });
  } catch {
    // Гонка: два сообщения почти одновременно — второй заход просто молчит.
    return false;
  }

  await addTag(contact, funnel.startTag);
  try {
    await sendStep(delivery, funnel, firstStep, opts.commentId);
  } catch (err) {
    await retryOrGiveUp(delivery, contact, err);
  }
  return true;
}

/** Нажатие кнопки: payload вида step:<funnelId>:<order>. Возвращает true, если кнопка наша. */
export async function handleQuickReply(contact: Contact, payload: string): Promise<boolean> {
  const match = /^step:(.+):(\d+)$/.exec(payload);
  if (!match) return false;
  const step = await prisma.funnelStep.findUnique({
    where: { funnelId_order: { funnelId: match[1], order: Number(match[2]) } },
    include: { funnel: true },
  });
  if (!step) return false;
  const delivery = await prisma.delivery.findUnique({
    where: { funnelId_contactId: { funnelId: step.funnelId, contactId: contact.id } },
    include: { contact: true },
  });
  if (!delivery) return false;

  // Атомарный захват: sendStep ставит доставку в WAITING именно перед кнопкой —
  // двойное нажатие (клиент тапнул дважды почти одновременно) без этой проверки
  // проходило оба раза и слало шаг воронки клиенту дважды.
  const claimed = await prisma.delivery.updateMany({ where: { id: delivery.id, state: "WAITING" }, data: { state: "ACTIVE" } });
  if (claimed.count === 0) return true;

  try {
    if (step.delaySeconds > 0) {
      await prisma.delivery.update({
        where: { id: delivery.id },
        data: { state: "ACTIVE", nextOrder: step.order, nextRunAt: new Date(Date.now() + step.delaySeconds * 1000) },
      });
    } else {
      await sendStep(delivery, step.funnel, step);
    }
  } catch (err) {
    logError("funnel:quickReply", err);
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { state: "FAILED", lastError: err instanceof Error ? err.message : String(err) },
    });
  }
  return true;
}

export function parseKeywords(funnel: Pick<Funnel, "keywords">): string[] {
  return parseStringArray(funnel.keywords);
}

/** Подходит ли текст под ключевые слова воронки. Пустой список слов — воронка
 *  запускается на ЛЮБОЕ сообщение (так у нас заведено по умолчанию), иначе
 *  нужно хотя бы одно вхождение без учёта регистра, как в ManyChat. */
export function matchesKeywords(keywords: string[], text: string): boolean {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/** Входящее сообщение в директ. Возвращает true, если сообщение обработала воронка
 *  (иначе им займётся ИИ-консультант).
 *
 *  Пустой список ключевых слов — воронка запускается на ЛЮБОЕ первое сообщение
 *  (так у нас заведено по умолчанию). Если слова заданы — ждём хотя бы одно из
 *  них в тексте, ровно как в ManyChat («Message contains ...») и как уже работает
 *  сторона комментариев (handleComment ниже). */
export async function handleIncomingDm(contact: Contact, text: string | null, payload: string | null): Promise<boolean> {
  if (payload && (await handleQuickReply(contact, payload))) return true;

  const funnels = await prisma.funnel.findMany({ where: { enabled: true, trigger: "DM" } });
  for (const funnel of funnels) {
    // Метку здесь НЕ проверяем: «проходил ли уже и не рано ли повторять» решает
    // startFunnel по окну repeatAfterDays. Метка осталась пометкой в карточке.
    if (!matchesKeywords(parseKeywords(funnel), text ?? "")) continue;
    if (await startFunnel(funnel, contact)) return true;
  }
  return false;
}

/** Пиктограммы + вариационные селекторы/ZWJ, которые их склеивают ("❤️" = сердце
 *  + невидимый модификатор ️). Если после вычитания этого не осталось ни
 *  буквы, ни цифры — комментарий был из одних эмодзи. Юникод-точки кодами, а не
 *  вставленными невидимыми символами, — иначе их не отличить глазами в диффе. */
const EMOJI_AND_JOINERS = /[\p{Extended_Pictographic}\u200d\ufe0f\s]/gu;
const THANK_YOU_EMOJI = ["❤️", "\u{1F9E1}", "\u{1F49B}", "\u{1F49A}", "\u{1FA77}", "\u{1F970}", "\u{1F60A}"];

function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.replace(EMOJI_AND_JOINERS, "").length === 0;
}

/** Комментарий под публикацией — Instagram или страницы Facebook. */
export async function handleComment(input: {
  commentId: string;
  mediaId: string | null;
  igUserId: string;
  username: string | null;
  text: string;
  channel?: MetaChannel;
}): Promise<void> {
  const channel: MetaChannel = input.channel ?? "INSTAGRAM";

  // Повторная доставка вебхука не должна отправить второе приглашение.
  try {
    await prisma.seenComment.create({ data: { commentId: input.commentId } });
  } catch {
    return;
  }

  // Флирт, оскорбления, рекламный спам — не отвечаем вовсе, удаляем: такому не
  // место под роликом школы, а любой ответ только продолжает разговор.
  const abuse = detectAbuse(input.text);
  if (abuse) {
    await deleteComment(input.commentId, channel).catch((err) => logError(`funnel:delete:${abuse}`, err));
    return;
  }

  // Комментарий из одних эмодзи ("❤️🔥", "😍😍😍") — не начало разговора, а реакция.
  // Публичное сердечко в ответ, без запуска всей воронки с кнопками курсов.
  if (isEmojiOnly(input.text)) {
    const emoji = THANK_YOU_EMOJI[Math.floor(Math.random() * THANK_YOU_EMOJI.length)];
    await replyToComment(input.commentId, emoji, channel).catch((err) => logError("funnel:emojiReply", err));
    return;
  }

  const funnels = await prisma.funnel.findMany({ where: { enabled: true, trigger: "COMMENT" } });
  for (const funnel of funnels) {
    const targetMediaIds = parseMediaIds(funnel);
    // Воронка привязана к публикациям — идентификаторами или ссылкой — значит
    // звучит ТОЛЬКО под ними, под остальными молчит. Не привязана ничем — как
    // раньше, решают anyComment/keywords.
    const restricted = targetMediaIds.length > 0 || Boolean(funnel.postUrl?.trim());
    if (restricted && (!input.mediaId || !targetMediaIds.includes(input.mediaId))) {
      // Публикация могла быть привязана СЫЛКОЙ, а не идентификатором: рекламных
      // постов нет в ленте аккаунта, и узнать их id заранее неоткуда. Спрашиваем
      // адрес у самой публикации и, если это она, запоминаем id навсегда.
      if (!(await matchesByLink(funnel, input.mediaId, channel))) continue;
    }
    // anyComment — под привязанным роликом отвечаем на любой комментарий; иначе
    // нужны ключевые слова, и ПУСТОЙ список здесь значит «не совпало», а не «всё
    // подходит» (в отличие от директа, где пустой список — запуск на любое).
    const keywords = parseKeywords(funnel);
    const matches = funnel.anyComment || (keywords.length > 0 && matchesKeywords(keywords, input.text));
    if (!matches) continue;

    const contact = await upsertContact(input.igUserId, input.username, channel);
    await startFunnel(funnel, contact, { commentId: input.commentId, commentText: input.text });
    return; // одна воронка на комментарий, как в ManyChat
  }

  // Ни одна воронка не подошла (ролик не в списке продающих) — не молчим:
  // обычный тёплый ответ ИИ личным сообщением, без кнопок и без нажима на продажу.
  const contact = await upsertContact(input.igUserId, input.username, channel);
  await aiReplyToComment(contact, input.commentId, input.text).catch((err) => logError("funnel:aiComment", err));
}

/**
 * Привязка публикации ССЫЛКОЙ вместо идентификатора.
 *
 * ЗАЧЕМ. Рекламной публикации («тёмного поста») нет в ленте аккаунта: её видно
 * только в рекламном кабинете, и `/me/media` её не отдаёт — значит и узнать её
 * id заранее неоткуда. Зато сам Graph по id публикации отдаёт её адрес. Поэтому
 * владелец вставляет в воронку обычную ссылку, а мы при ПЕРВОМ же комментарии
 * сверяем короткий код и, если совпал, дописываем id в список — дальше воронка
 * работает как обычная, без лишних запросов.
 */
async function matchesByLink(funnel: Funnel, mediaId: string | null, channel: MetaChannel): Promise<boolean> {
  if (!mediaId || !funnel.postUrl) return false;
  const wanted = funnel.postUrl
    .split(/[\s,\n]+/)
    .map((u) => instagramShortcode(u))
    .filter((c): c is string => Boolean(c));
  if (wanted.length === 0) return false;

  const permalink = await mediaPermalink(mediaId, channel);
  const code = instagramShortcode(permalink);
  if (!code || !wanted.includes(code)) return false;

  const ids = [...new Set([...parseMediaIds(funnel), mediaId])];
  await prisma.funnel
    .update({ where: { id: funnel.id }, data: { mediaIds: JSON.stringify(ids) } })
    .catch((err) => logError("funnel:bindMedia", err));
  return true;
}

export function parseMediaIds(funnel: Pick<Funnel, "mediaIds">): string[] {
  return parseStringArray(funnel.mediaIds);
}

let workerBusy = false;

/** Фоновый разносчик отложенных шагов. Дёргается раз в 10 секунд из index.ts. */
export async function runDueDeliveries(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const due = await prisma.delivery.findMany({
      where: { state: "ACTIVE", nextRunAt: { lte: new Date() } },
      include: { contact: true, funnel: true },
      take: 20,
    });
    for (const delivery of due) {
      // Сначала снимаем с расписания, потом шлём — повторный тик не отправит дубль.
      await prisma.delivery.update({ where: { id: delivery.id }, data: { nextRunAt: null } });
      const step = await prisma.funnelStep.findUnique({
        where: { funnelId_order: { funnelId: delivery.funnelId, order: delivery.nextOrder } },
      });
      if (!step) {
        await prisma.delivery.update({ where: { id: delivery.id }, data: { state: "DONE" } });
        continue;
      }
      try {
        await sendStep(delivery, delivery.funnel, step);
      } catch (err) {
        await retryOrGiveUp(delivery, delivery.contact, err);
      }
    }
  } finally {
    workerBusy = false;
  }
}
