import { prisma, logError, recordOutgoingMessage, getSetting } from "./db.js";
import {
  sendPrivateReply,
  replyToComment,
  deleteComment,
  metaChannelOf,
  mediaPermalink,
  type QuickButton,
  type Channel,
  type MetaChannel,
} from "./instagram.js";
import { sendToContact, sendAttachmentToContact } from "./messaging/send.js";
import { humanizeForContact } from "./messaging/humanize.js";
import {
  isBotFrozen,
  withMessagingPermission,
  withContactMessaging,
  contactAutomationBlocked,
} from "./messaging/automation.js";
import { silenceIfFollowedByBusiness, releaseFollowSilenceIfClient } from "./profiles.js";
import { instagramShortcode } from "./ownMedia.js";
import { aiReplyToComment } from "./ai.js";
import { detectAbuse } from "./ai/abuseFilter.js";
import { notifyFunnelGaveUp } from "./systemAlerts.js";
import type { Contact, Delivery, Funnel, FunnelStep, Prisma } from "@prisma/client";
import { parseStepButtonsJson, parseStringArray } from "./json.js";
import { canRetryMetaFailure } from "./messaging/metaErrors.js";
import { renderFunnelText } from "./funnelPlaceholders.js";
import { stripRepeatGreeting } from "./greeting.js";
import { shouldSkipRequisitesStep } from "./ai/repeatGuard.js";
import { funnelMenuFits } from "./ai/firstMessage.js";
import {
  ContactMessagingBlocked,
  humanSilenceActive,
  contactAutomationBlocked as policyBlocks,
} from "./messaging/automation.js";
import { isTrivialMessage } from "./trivialMessage.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { BUDGET_FALLBACK } from "./ai/prompts.js";

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
  // ПАУЗА ИЗ-ЗА ЖИВОГО РАЗГОВОРА — НЕ СБОЙ (11.11.2026). Дверь отправки отказала,
  // потому что Ширин сейчас ведёт разговор (или человек личный/заблокирован).
  // Раньше это считалось отказом Meta: 11 повторов за ~4 часа, и шаг уходил,
  // как только кончалась 3-часовая пауза, — поверх её разговора; а в Telegram
  // прилетало «воронка 11 раз не смогла… сдалась». Теперь цепочка просто
  // заканчивается: дальше разговор ведёт человек.
  if (err instanceof ContactMessagingBlocked) {
    await cancelDelivery(delivery.id, `остановлено: ${err.reason}`);
    return;
  }
  logError("funnel:step", err);

  const failCount = delivery.failCount + 1;
  if (failCount >= RETRY_MAX_ATTEMPTS || !canRetryMetaFailure(err)) {
    // Условно: цепочку, которую за время отправки отменили (клиент написал сам),
    // не превращаем обратно в «сбой» и не воскрешаем.
    const failed = await prisma.delivery.updateMany({
      where: { id: delivery.id, state: "ACTIVE" },
      data: { state: "FAILED", failCount, lastError: message, nextRunAt: null },
    });
    // Цепочку уже отменили (клиент написал сам, Ширин ответила) — она не «сдалась»,
    // тревогу «воронка N раз не смогла» не шлём (повторное ревью 11.11.2026).
    if ((failed?.count ?? 0) === 0) return;
    const who = contact.username ? `@${contact.username}` : contact.igUserId;
    await notifyFunnelGaveUp(who, failCount, message);
    return;
  }

  const delayMs = RETRY_DELAYS_MS[failCount - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  await prisma.delivery.updateMany({
    where: { id: delivery.id, state: "ACTIVE" },
    data: { state: "ACTIVE", failCount, lastError: message, nextRunAt: new Date(Date.now() + delayMs) },
  });
}

/**
 * ПЕРЕХОД ЦЕПОЧКИ ПОСЛЕ ШАГА — ТОЛЬКО ЕСЛИ ЕЁ НЕ ОТМЕНИЛИ (ревью 11.11.2026).
 * Шаг «в полёте» (печатает, ждёт Meta) — а клиент в это время написал сам, и
 * cancelPendingFunnelSteps поставил DONE. Безусловный update в конце sendStep
 * перетирал отмену: цепочка снова становилась ACTIVE и следующий шаг уходил поверх
 * живого разговора. Теперь переход пишется только по состоянию ACTIVE.
 */
async function advanceIfActive(id: string, data: Prisma.DeliveryUpdateManyMutationInput): Promise<boolean> {
  const res = await prisma.delivery.updateMany({ where: { id, state: "ACTIVE" }, data });
  return (res?.count ?? 0) > 0;
}

async function cancelDelivery(id: string, reason: string): Promise<void> {
  await prisma.delivery
    .update({ where: { id }, data: { state: "DONE", nextRunAt: null, lastError: reason.slice(0, 300) } })
    .catch((err) => logError("funnel:cancel", err));
}

/**
 * ОТЛОЖЕННЫЕ ШАГИ ВОРОНКИ ОТМЕНЯЮТСЯ, КОГДА РАЗГОВОР ПОШЁЛ ЖИВЬЁМ (владелец 11.11.2026).
 *
 * Разбор 48 часов: шаги воронки (видео, реквизиты) уходили через 3 часа после
 * того, как Ширин взяла разговор, и после того, как клиент уже сам задал вопрос
 * и получил ответ. Шаблон в такой момент звучит как автомат, который не слушает.
 *
 * Вызывается: клиент написал своими словами (не нажал кнопку) — webhook.ts до
 * запуска воронки; Ширин ответила сама — webhook.ts::handleEcho. Отменяются
 * только цепочки «в пути» (ACTIVE); ожидающие нажатия кнопки (WAITING) остаются:
 * человек может нажать кнопку позже, это его явный выбор.
 */
export async function cancelPendingFunnelSteps(contactId: string, reason: string): Promise<number> {
  try {
    const res = await prisma.delivery.updateMany({
      where: { contactId, state: "ACTIVE" },
      data: { state: "DONE", nextRunAt: null, lastError: reason.slice(0, 300) },
    });
    return res?.count ?? 0;
  } catch (err) {
    logError("funnel:cancelPending", err);
    return 0;
  }
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
  channel: Channel = "INSTAGRAM",
): Promise<Contact> {
  const args = {
    where: { channel_igUserId: { channel, igUserId } },
    create: { channel, igUserId, username: username ?? null },
    update: username ? { username } : {},
  };
  try {
    return await prisma.contact.upsert(args);
  } catch (err) {
    // Два первых сообщения нового человека обрабатываются параллельно (webhookInbox.ts):
    // upsert в SQLite не атомарен, второй create падает на уникальности — берём готовый.
    if ((err as { code?: string })?.code !== "P2002") throw err;
    return prisma.contact.upsert(args);
  }
}

/** Отправляет один шаг и переводит доставку в следующее состояние. */
async function sendStep(
  delivery: Delivery & { contact: Contact },
  funnel: Funnel,
  step: FunnelStep,
  privateReplyCommentId?: string,
): Promise<void> {
  const buttons = parseStepButtons(step);
  // Ответ на комментарий идёт мимо sendToContact, поэтому правка «по-человечески»
  // (тире, особые буквы по стилю клиента) — здесь же, и в историю пишется то, что ушло.
  const rendered = (await renderFunnelText(step.text)).trim();
  let text = rendered ? await humanizeForContact(delivery.contactId, rendered) : rendered;
  // Ответ на комментарий идёт мимо sendText, где режется повторное приветствие:
  // человек написал в директ и под постом почти одновременно — две воронки
  // здоровались по очереди (разбор 11.11.2026). Режем и здесь.
  if (privateReplyCommentId && text) text = await stripRepeatGreeting(delivery.contactId, text);
  // Реквизиты уже ушли в последние минуты (ответ ИИ или другой шаг) или человек
  // уже оплатил и получил ссылку — текст шага с номером не повторяем (пункт 5).
  if (text && (await shouldSkipRequisitesStep(delivery.contactId, text))) text = "";
  let mid: string | null = null;

  // Шаг может быть ЧИСТЫМ вложением — фото меню или видео без подписи, как это
  // было в ManyChat. Тогда текстовое сообщение не шлём вовсе: пустой пузырь
  // выглядел бы как сбой, да и Meta его не примет.
  if (text || buttons.length > 0) {
    if (privateReplyCommentId) {
      mid = await withContactMessaging(delivery.contact.id, "reply", () =>
        withMessagingPermission("funnel", () =>
          sendPrivateReply(privateReplyCommentId, text, buttons, metaChannelOf(delivery.contact)),
        ),
      );
    } else {
      mid = await withMessagingPermission("funnel", () => sendToContact(delivery.contact, text, buttons));
    }
    await recordOutgoingMessage(delivery.contactId, text, mid);
  }

  if (step.mediaUrl && step.mediaType) {
    try {
      await withMessagingPermission("funnel", () =>
        sendAttachmentToContact(delivery.contact, step.mediaUrl!, step.mediaType as "video" | "image" | "file"),
      );
    } catch (err) {
      // Текст уже ушёл — падение вложения не должно ронять всю цепочку.
      logError("funnel:attachment", err);
    }
  }

  if (buttons.length > 0) {
    // Шаг с кнопками ставит цепочку на паузу до нажатия.
    await advanceIfActive(delivery.id, { state: "WAITING", nextRunAt: null });
    return;
  }

  const next = step.stopAfter
    ? null
    : await prisma.funnelStep.findFirst({
        where: { funnelId: funnel.id, order: { gt: step.order } },
        orderBy: { order: "asc" },
      });
  if (!next) {
    await advanceIfActive(delivery.id, { state: "DONE", nextRunAt: null });
    return;
  }
  await advanceIfActive(delivery.id, {
    state: "ACTIVE",
    nextOrder: next.order,
    nextRunAt: new Date(Date.now() + next.delaySeconds * 1000),
  });
}

/** Запуск воронки для человека. Повторный запуск той же воронки не происходит —
 *  защита стоит на уникальности пары «воронка + человек». */
export async function startFunnel(
  funnel: Funnel,
  contact: Contact,
  opts: { commentId?: string; commentText?: string; claimDeferredId?: string } = {},
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
  // Отложенная воронка (settleDeferredFunnel): строка — не прошлый проход, а место,
  // занятое на время ответа ИИ. Захват атомарный — два хода не отправят меню дважды.
  const claimDeferred = Boolean(
    opts.claimDeferredId && previous?.id === opts.claimDeferredId && previous?.lastError === FUNNEL_DEFERRED,
  );
  if (previous && !claimDeferred) {
    if (funnel.repeatAfterDays <= 0) return false; // повтор запрещён совсем
    const daysSince = (Date.now() - previous.createdAt.getTime()) / 86_400_000;
    if (daysSince < funnel.repeatAfterDays) return false; // ещё рано
  }
  if (previous && claimDeferred) {
    const claimed = await prisma.delivery.updateMany({
      where: { id: previous.id, state: "DONE", lastError: FUNNEL_DEFERRED },
      data: { state: "ACTIVE", lastError: null },
    });
    if ((claimed?.count ?? 0) === 0) return false;
  }

  let delivery;
  try {
    delivery = previous
      ? await prisma.delivery.update({
          where: { id: previous.id },
          data: {
            state: "ACTIVE",
            nextOrder: firstStep.order,
            nextRunAt: new Date(Date.now() + 5 * 60_000),
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
            nextRunAt: new Date(Date.now() + 5 * 60_000),
            commentId: opts.commentId ?? null,
            commentText: opts.commentText ?? null,
          },
          include: { contact: true },
        });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false;
    throw err;
  }

  await addTag(contact, funnel.startTag);
  let firstStepSent = false;
  try {
    await sendStep(delivery, funnel, firstStep, opts.commentId);
    firstStepSent = true;
  } catch (err) {
    await retryOrGiveUp(delivery, contact, err);
  }
  // Публичный ответ — только когда первый шаг РЕАЛЬНО ушёл в директ: иначе
  // «написали вам в директ» под постом было бы неправдой.
  if (firstStepSent && opts.commentId) await replyPubliclyUnderComment(contact, opts.commentId);
  return true;
}

/**
 * ПУБЛИЧНЫЙ ОТВЕТ ПОД КОММЕНТАРИЕМ (владелец 08.11.2026, как было в ManyChat).
 *
 * Когда COMMENT-воронка отправила человеку первый шаг в директ, под самим
 * комментарием появляется короткое «написали вам в директ». Зачем: человек
 * понимает, куда смотреть (запрос в директ от незнакомого аккаунта часто
 * падает в «Запросы»), а остальные под рекламой видят, что школа отвечает.
 *
 * Фразы разные и выбираются случайно: одинаковый текст под каждым
 * комментарием Meta может принять за спам. Только «шумо», без «лутфан»
 * (см. разговорник). Названия курсов и цены сюда не пишем — всё в директе.
 *
 * РУБИЛЬНИК `commentPublicReplyEnabled` — по умолчанию ВКЛЮЧЁН; "false"
 * выключает только публичный ответ, воронка в директ работает как раньше.
 * Ошибка Meta здесь воронку не ломает: директ уже ушёл, пишем только в журнал.
 */
export const COMMENT_PUBLIC_REPLY_SETTING = "commentPublicReplyEnabled";
export const COMMENT_PUBLIC_REPLIES = [
  "Ба директ навиштем 💌",
  "Ҷавобро ба директатон фиристодем ✨",
  "Ба шумо дар директ навиштем 🤍",
  "Паёми моро дар директ бинед 🌸",
  "Маълумотро ба директ фиристодем 💌",
];

async function commentPublicReplyEnabled(): Promise<boolean> {
  return (await getSetting(COMMENT_PUBLIC_REPLY_SETTING)) !== "false";
}

async function replyPubliclyUnderComment(contact: Contact, commentId: string): Promise<void> {
  try {
    if (!(await commentPublicReplyEnabled())) return;
    const text = COMMENT_PUBLIC_REPLIES[Math.floor(Math.random() * COMMENT_PUBLIC_REPLIES.length)];
    await withContactMessaging(contact.id, "reply", () =>
      withMessagingPermission("funnel", () => replyToComment(commentId, text, metaChannelOf(contact))),
    );
  } catch (err) {
    logError("funnel:publicReply", err);
  }
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
  const claimed = await prisma.delivery.updateMany({
    where: { id: delivery.id, state: "WAITING" },
    data: { state: "ACTIVE", nextOrder: step.order, nextRunAt: new Date(Date.now() + 5 * 60_000) },
  });
  if (claimed.count === 0) {
    if (delivery.state === "ACTIVE") return true; // The original tap is still scheduled/running.
    const text =
      contact.preferredLanguage === "tg"
        ? "Ин тугма дигар кор намекунад. Саволатонро нависен ё тугмаи охиринро пахш кунен."
        : "Эта кнопка больше не активна. Напишите ваш вопрос или выберите кнопку в последнем сообщении.";
    const mid = await withMessagingPermission("funnel", () => sendToContact(contact, text));
    await recordOutgoingMessage(contact.id, text, mid);
    return true;
  }

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
    await retryOrGiveUp({ ...delivery, nextOrder: step.order }, contact, err);
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
export async function handleIncomingDm(
  contact: Contact,
  text: string | null,
  payload: string | null,
  opts: { hasAttachments?: boolean; aiAvailable?: boolean } = {},
): Promise<boolean> {
  if (payload && (await handleQuickReply(contact, payload))) return true;

  const funnels = await prisma.funnel.findMany({ where: { enabled: true, trigger: "DM" } });
  for (const funnel of funnels) {
    // Метку здесь НЕ проверяем: «проходил ли уже и не рано ли повторять» решает
    // startFunnel по окну repeatAfterDays. Метка осталась пометкой в карточке.
    const keywords = parseKeywords(funnel);
    if (!matchesKeywords(keywords, text ?? "")) continue;
    if (!(await funnelDue(funnel, contact))) continue;
    // Правила ниже — только для воронки «на любое первое сообщение». Если владелец
    // сам задал ключевые слова («цена»), значит хочет воронку именно на них.
    const anyMessage = keywords.length === 0;
    // Меню другой воронки (с комментария) только что ушло этому человеку — второе
    // «Ассалому алейкум, ба шумо кадом маълумот…» подряд не шлём. На «салом»
    // отвечать нечего (меню уже перед ним), на вопрос ответит ИИ.
    if (anyMessage && opts.aiAvailable !== false && (await otherFunnelGreetedRecently(funnel, contact))) {
      await markFunnelSkipped(funnel, contact, "пропущено: меню другой воронки уже ушло");
      return funnelMenuFits(text, opts.hasAttachments) && isTrivialMessage(text);
    }
    // Первое сообщение — настоящий вопрос (или фото/голосовое): меню-приветствие
    // проглотило бы его. Отвечает ИИ (ai/firstMessage.ts), а воронка ОТЛОЖЕНА:
    // отметку «пропущено» ставит settleDeferredFunnel только после того, как ответ
    // реально ушёл; ИИ промолчал или упал — уходит обычное меню (ревью 11.11.2026).
    // Ответов ИИ нет (экстренная пауза, выключен консультант) — лучше меню, чем тишина.
    if (anyMessage && opts.aiAvailable !== false && !funnelMenuFits(text, opts.hasAttachments)) {
      await markFunnelSkipped(funnel, contact, FUNNEL_DEFERRED);
      return false;
    }
    if (await startFunnel(funnel, contact)) return true;
  }
  return false;
}

/**
 * ВОРОНКА ОТЛОЖЕНА ДО ОТВЕТА ИИ (ревью 11.11.2026). Первым сообщением пришёл вопрос:
 * отвечает ИИ, а строка доставки стоит с этой отметкой — чтобы второй пузырь
 * («салом») в окне ожидания не запустил меню поверх. Начинается с «пропущено»:
 * otherFunnelGreetedRecently её не считает «уже поздоровались».
 */
export const FUNNEL_DEFERRED = "пропущено (ждёт ответа ИИ): первым сообщением пришёл вопрос";
export const FUNNEL_SKIPPED_AI_ANSWERED = "пропущено: первым сообщением пришёл вопрос, ответил ИИ";
const FUNNEL_SKIPPED_HUMAN = "пропущено: первым сообщением пришёл вопрос, разговор ведёт Ширин";

/**
 * Ответил ли кто-то человеку после `since`: бот (текст, фото меню, карточка) или
 * сама Ширин. «Напишите чуть позже» (кончился бюджет ИИ) ответом не считается —
 * тогда лучше меню воронки.
 */
async function answeredSince(contactId: string, since: Date): Promise<boolean> {
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", createdAt: { gte: since } },
    select: { text: true },
    take: 20,
  });
  const notAnswers = new Set(Object.values(BUDGET_FALLBACK).map((t) => t.trim()));
  return (rows ?? []).some((r) => !notAnswers.has((r.text ?? "").trim()));
}

/**
 * Решение по отложенной воронке, когда ход ИИ закончился (webhook.ts, после
 * aiReply — в том числе если он упал). Ответ ушёл — отметка «пропущено, ответил
 * ИИ». Ответа нет (ключей нет, бюджет, «не по делу», фильтры, ошибка) — обычное
 * меню воронки, а не тишина. Ширин уже ведёт разговор — меню не шлём.
 */
export async function settleDeferredFunnel(contactId: string, since: Date): Promise<void> {
  const pending = await prisma.delivery.findMany({
    where: { contactId, state: "DONE", lastError: FUNNEL_DEFERRED },
    include: { funnel: true, contact: true },
  });
  if (!pending || pending.length === 0) return;
  const answered = await answeredSince(contactId, since);
  for (const d of pending) {
    const mark = (reason: string) =>
      prisma.delivery.updateMany({ where: { id: d.id, lastError: FUNNEL_DEFERRED }, data: { lastError: reason } });
    if (answered) {
      await mark(FUNNEL_SKIPPED_AI_ANSWERED);
      continue;
    }
    if (!d.funnel?.enabled || policyBlocks(d.contact) || humanSilenceActive(d.contact)) {
      await mark(FUNNEL_SKIPPED_HUMAN);
      continue;
    }
    await startFunnel(d.funnel, d.contact, { claimDeferredId: d.id });
  }
}

/**
 * Отменять ли отложенные шаги воронки на сообщение клиента (ревью 11.11.2026).
 * Только если кто-то ответит вместо шаблона: ИИ включён, бот не на экстренной
 * паузе («всё, кроме воронки»), ключи есть — и сообщение не пустяк («рахмат», «ок»).
 * Иначе отмена оставляла человека без следующего шага и без ответа.
 */
export async function clientMessageStopsFunnel(text: string | null, attachments: readonly unknown[]): Promise<boolean> {
  const meaningful = text?.trim() ? !isTrivialMessage(text) : attachments.length > 0;
  if (!meaningful) return false;
  if (await isBotFrozen()) return false;
  if ((await getSetting("aiEnabled")) !== "true") return false;
  return (await resolveGeminiKeys()).length > 0;
}

/** Запустилась бы воронка для этого человека сейчас (то же правило, что в startFunnel). */
async function funnelDue(funnel: Funnel, contact: Contact): Promise<boolean> {
  const previous = await prisma.delivery.findUnique({
    where: { funnelId_contactId: { funnelId: funnel.id, contactId: contact.id } },
  });
  if (!previous) return true;
  if (funnel.repeatAfterDays <= 0) return false;
  return (Date.now() - previous.createdAt.getTime()) / 86_400_000 >= funnel.repeatAfterDays;
}

/** Окно «уже здоровались» — то же, что у среза повторного приветствия (greeting.ts). */
const OTHER_FUNNEL_WINDOW_MS = 12 * 3_600_000;

async function otherFunnelGreetedRecently(funnel: Funnel, contact: Contact): Promise<boolean> {
  const other = await prisma.delivery.findFirst({
    where: {
      contactId: contact.id,
      funnelId: { not: funnel.id },
      createdAt: { gte: new Date(Date.now() - OTHER_FUNNEL_WINDOW_MS) },
      // Пропущенная воронка (вопрос вместо меню) меню не слала.
      OR: [{ lastError: null }, { NOT: { lastError: { startsWith: "пропущено" } } }],
    },
    select: { id: true },
  });
  return Boolean(other);
}

/**
 * Воронка считается пройденной без отправки: иначе следующий «салом» через час
 * запустил бы меню-приветствие посреди уже начатого разговора. Окно повтора
 * (repeatAfterDays) отсчитывается от этой отметки, как от обычного прохода.
 */
async function markFunnelSkipped(funnel: Funnel, contact: Contact, reason: string): Promise<void> {
  const where = { funnelId_contactId: { funnelId: funnel.id, contactId: contact.id } };
  try {
    await prisma.delivery.create({
      data: {
        funnelId: funnel.id,
        contactId: contact.id,
        state: "DONE",
        nextOrder: 0,
        nextRunAt: null,
        lastError: reason,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") {
      logError("funnel:markSkipped", err);
      return;
    }
    // Прошлый проход есть. Перезаписываем только законченный (окно повтора прошло) —
    // живую цепочку, которую параллельное первое сообщение только что запустило, не трогаем.
    await prisma.delivery
      .updateMany({
        where: { ...where.funnelId_contactId, state: { in: ["DONE", "FAILED"] } },
        data: { state: "DONE", nextRunAt: null, lastError: reason, createdAt: new Date() },
      })
      .catch((e) => logError("funnel:markSkipped", e));
  }
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
type CommentInput = {
  commentId: string;
  mediaId: string | null;
  igUserId: string;
  username: string | null;
  text: string;
  channel?: MetaChannel;
};
const commentTasks = new Map<string, Promise<void>>();
export async function handleComment(input: CommentInput): Promise<void> {
  const running = commentTasks.get(input.commentId);
  if (running) return running;
  const task = (async () => {
    if (await prisma.seenComment.findUnique({ where: { commentId: input.commentId } })) return;
    const result = await processComment(input);
    // Итог записываем вместе с отметкой «видели»: по нему сторож unansweredWatch.ts
    // находит комментарии, оставшиеся без ответа не по нашему решению.
    try {
      await prisma.seenComment.create({
        data: {
          commentId: input.commentId,
          contactId: result.contactId ?? null,
          outcome: result.outcome,
          text: input.text.slice(0, 300),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err;
    }
  })();
  commentTasks.set(input.commentId, task);
  try {
    await task;
  } finally {
    commentTasks.delete(input.commentId);
  }
}

/**
 * Чем кончилась обработка комментария. Хранится в SeenComment.outcome.
 * «Ждёт ответа» (COMMENT_WAITING_OUTCOMES) — без ответа осталось НЕ по нашему
 * решению: выключены ответы ИИ, кончился бюджет, сбой модели, Ширин ведёт
 * переписку с этим человеком. Про такие сторож пишет владельцу в Telegram.
 */
export type CommentOutcome =
  | "deleted" // флирт/оскорбление/спам — удалили
  | "frozen" // экстренная пауза бота
  | "emoji" // сердечко в ответ на смайлики
  | "funnel" // воронка: первый шаг в директ (+ ответ под комментарием)
  | "ai" // ответ ИИ в директ (+ ответ под комментарием)
  | "public_heart" // ИИ решил, что писать в директ нечего — сердечко под комментарием
  | "guard" // шаблонный ответ защиты (не по теме)
  | "silent_contact" // личный/заблокированный/знакомая Ширин — молчим нарочно
  | "silent_guard" // «пустите бесплатно» — молчим нарочно
  | "waiting_human" // переписку с этим человеком сейчас ведёт Ширин
  | "ai_off" // ответы ИИ под комментариями выключены
  | "no_keys" // нет ключей Gemini
  | "budget" // кончился дневной бюджет ИИ
  | "ai_error"; // модель или отправка не сработали

export const COMMENT_WAITING_OUTCOMES: readonly CommentOutcome[] = [
  "waiting_human",
  "ai_off",
  "no_keys",
  "budget",
  "ai_error",
];

type CommentResult = { outcome: CommentOutcome; contactId?: string };

async function processComment(input: CommentInput): Promise<CommentResult> {
  const channel: MetaChannel = input.channel ?? "INSTAGRAM";

  // Флирт, оскорбления, рекламный спам — не отвечаем вовсе, удаляем: такому не
  // место под роликом школы, а любой ответ только продолжает разговор.
  const abuse = detectAbuse(input.text);
  if (abuse) {
    await deleteComment(input.commentId, channel);
    return { outcome: "deleted" };
  }

  // Комментарий из одних эмодзи ("❤️🔥", "😍😍😍") — не начало разговора, а реакция.
  // Публичное сердечко в ответ, без запуска всей воронки с кнопками курсов.
  if (isEmojiOnly(input.text)) {
    if (await isBotFrozen()) return { outcome: "frozen" };
    const contact = await upsertContact(input.igUserId, input.username, channel);
    await replyHeartUnderComment(contact, input.commentId, channel);
    return { outcome: "emoji", contactId: contact.id };
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
    const silent = await silentForComment(contact, input.text);
    if (silent) return { outcome: silent, contactId: contact.id };
    // Человек уже получил меню в директе (написал туда сам минуту назад) — второе
    // меню с приветствием не шлём. Простой комментарий («+», «маълумот») —
    // только «написали вам в директ» под ним; вопрос — отвечает ИИ.
    if ((await funnelDue(funnel, contact)) && (await otherFunnelGreetedRecently(funnel, contact))) {
      await markFunnelSkipped(funnel, contact, "пропущено: меню другой воронки уже ушло");
      if (funnelMenuFits(input.text)) {
        await replyPubliclyUnderComment(contact, input.commentId);
        return { outcome: "funnel", contactId: contact.id };
      }
      return answerCommentWithAi(contact, input);
    }
    if (await startFunnel(funnel, contact, { commentId: input.commentId, commentText: input.text })) {
      return { outcome: "funnel", contactId: contact.id }; // одна воронка на комментарий, как в ManyChat
    }
    // Воронку этот человек уже проходил (окно повтора repeatAfterDays не
    // прошло) или у неё нет шагов. Раньше здесь был `return` — и повторный
    // комментарий под рекламой оставался вовсе без ответа (разбор 09.11.2026).
    // Теперь отвечает ИИ, как под любым другим роликом.
    return answerCommentWithAi(contact, input);
  }

  // Ни одна воронка не подошла (ролик не в списке продающих) — не молчим:
  // обычный тёплый ответ ИИ личным сообщением, без кнопок и без нажима на продажу.
  const contact = await upsertContact(input.igUserId, input.username, channel);
  const silent = await silentForComment(contact, input.text);
  if (silent) return { outcome: silent, contactId: contact.id };
  return answerCommentWithAi(contact, input);
}

/**
 * Ответ ИИ на комментарий + короткий публичный ответ под ним.
 * Ответ ушёл в директ — под комментарием «написали вам в директ» (как у
 * воронки: человек знает, куда смотреть, а запрос от незнакомого аккаунта
 * часто лежит в «Запросах»). ИИ решил, что писать нечего ([NO_REPLY], обычно
 * похвала вроде «Офарин!») — публичное сердечко, чтобы комментарий не висел
 * без ответа (владелец 09.11.2026).
 */
async function answerCommentWithAi(contact: Contact, input: CommentInput): Promise<CommentResult> {
  const channel: MetaChannel = input.channel ?? "INSTAGRAM";
  const outcome = (await aiReplyToComment(contact, input.commentId, input.text)) ?? "ai";
  if (outcome === "ai") await replyPubliclyUnderComment(contact, input.commentId);
  if (outcome === "no_reply") {
    // Сбой здесь — только в журнал: иначе подстраховка комментариев повторила бы
    // и платный ход модели ради одного сердечка.
    try {
      await replyHeartUnderComment(contact, input.commentId, channel);
    } catch (err) {
      logError("funnel:commentHeart", err);
      return { outcome: "ai_error", contactId: contact.id };
    }
    return { outcome: "public_heart", contactId: contact.id };
  }
  return { outcome, contactId: contact.id };
}

/** Публичное сердечко под комментарием (ошибку Meta отдаёт вызывающему). */
async function replyHeartUnderComment(contact: Contact, commentId: string, channel: MetaChannel): Promise<void> {
  const emoji = THANK_YOU_EMOJI[Math.floor(Math.random() * THANK_YOU_EMOJI.length)];
  await withContactMessaging(contact.id, "reply", () => replyToComment(commentId, emoji, channel));
}

/**
 * Кому под комментарием не отвечаем вовсе — ни воронкой, ни ИИ, ни публично.
 * Личные контакты, заблокированные, переписка у живого человека — то же
 * правило, что в директе (contactAutomationBlocked). И знакомые: на кого
 * подписана Ширин (profiles.ts, владелец 08.11.2026). Раньше комментарий
 * знакомой запускал воронку: первый шаг уходил, а на её ответ в директе бот
 * уже молчал — обрыв на полуслове хуже, чем отсутствие воронки.
 *
 * Исключение (владелец 09.11.2026): знакомая по подписке, которая пишет про
 * курс или цену, — клиент, авто-отметка снимается (profiles.ts).
 *
 * Возвращает причину молчания или null — отвечать можно.
 */
async function silentForComment(original: Contact, text: string): Promise<CommentOutcome | null> {
  const contact = await releaseFollowSilenceIfClient(original, { text });
  if (contact.personal || contact.spamBlockedAt || contact.whatsappSavedContact) return "silent_contact";
  // Переписку с этим человеком сейчас ведёт Ширин — бот не встревает, но
  // комментарий не теряется: сторож напомнит владельцу в Telegram.
  if (contactAutomationBlocked(contact)) return "waiting_human";
  return (await silenceIfFollowedByBusiness(contact, { hasImage: false, text })) ? "silent_contact" : null;
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
      // Условно: между выборкой и захватом цепочку могли отменить (клиент написал сам).
      if (!(await advanceIfActive(delivery.id, { nextRunAt: new Date(Date.now() + 5 * 60_000) }))) continue;
      const step = await prisma.funnelStep.findUnique({
        where: { funnelId_order: { funnelId: delivery.funnelId, order: delivery.nextOrder } },
      });
      if (!step) {
        await prisma.delivery.update({ where: { id: delivery.id }, data: { state: "DONE" } });
        continue;
      }
      // Ширин ведёт разговор или человек личный/заблокирован — отложенный шаг не
      // ждёт конца паузы, а отменяется (см. cancelPendingFunnelSteps).
      if (policyBlocks(delivery.contact) || humanSilenceActive(delivery.contact)) {
        await cancelDelivery(delivery.id, "остановлено: разговор ведёт Ширин");
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
