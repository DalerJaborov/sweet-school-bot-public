import { MetaDeliveryError, metaResponseError } from "./messaging/metaErrors.js";
import { env } from "./env.js";
import { getSetting, prisma, logWarn } from "./db.js";
import { stripRepeatGreeting } from "./greeting.js";
import { toOwnerVoice } from "./voice.js";
import { assertMessagingAllowed } from "./messaging/automation.js";

const GRAPH_VERSION = "v23.0";
const TIMEOUT_MS = 15_000;
const GRAPH_ORIGIN = "https://graph.instagram.com";
/** Messenger живёт на другом хосте — и, в отличие от graph.instagram.com, он с
 *  нашего VPS доступен НАПРЯМУЮ, прокси ему не нужен (проверено в основной CRM:
 *  WhatsApp через graph.facebook.com отвечал, когда Instagram молчал). */
const FB_GRAPH_ORIGIN = "https://graph.facebook.com";

/** Канал контакта. WEB — чат на сайте: в Meta такого человека нет, ему
 *  отвечает messaging/send.ts записью в базу, а не запросом к Graph API. */
export type Channel = "INSTAGRAM" | "MESSENGER" | "WEB" | "WHATSAPP";
/** Каналы, у которых есть Graph API — только с ними умеют функции этого файла. */
export type MetaChannel = Exclude<Channel, "WEB" | "WHATSAPP">;
export type QuickButton = { title: string; payload: string };

/** Канал контакта — им же и отвечаем: инстаграмному человеку через Instagram,
 *  пришедшему из Messenger — через страницу Facebook. Живёт здесь, а не в
 *  funnel.ts, чтобы ai.ts мог им пользоваться без круговой зависимости
 *  (funnel.ts уже импортирует ai.ts). */
export function channelOf(contact: { channel: string }): Channel {
  if (["WEB", "WHATSAPP", "MESSENGER", "INSTAGRAM"].includes(contact.channel)) return contact.channel as Channel;
  throw new Error(`Unsupported messaging channel: ${contact.channel}`);
}

/** Канал Meta для операций, которых у сайта не бывает (комментарии, private
 *  reply). Контакт WEB сюда попадать не должен — на всякий случай считаем его
 *  Instagram, как было до появления сайта. */
export function metaChannelOf(contact: { channel: string }): MetaChannel {
  if (contact.channel === "INSTAGRAM" || contact.channel === "MESSENGER") return contact.channel;
  throw new Error(`Not a Meta channel: ${contact.channel}`);
}

async function igToken(): Promise<string> {
  const token = await getSetting("igToken");
  if (!token) throw new Error("Маркер Instagram не задан в Настройках");
  return token;
}

async function fbPageToken(): Promise<string> {
  const token = await getSetting("fbPageToken");
  if (!token) throw new Error("Маркер страницы Facebook не задан в Настройках");
  return token;
}

/** С части серверов graph.instagram.com недоступен напрямую (сетевой уровень) —
 *  тогда ходим через Cloudflare Worker-прокси. Worker не пробрасывает заголовок
 *  Authorization дальше, поэтому маркер через прокси уходит query-параметром. */
function buildRequest(path: string, token: string): { url: string; headers: Record<string, string> } {
  if (!env.igProxyBase) {
    return { url: `${GRAPH_ORIGIN}${path}`, headers: { Authorization: `Bearer ${token}` } };
  }
  const sep = path.includes("?") ? "&" : "?";
  return {
    url: `${env.igProxyBase}${path}${sep}access_token=${encodeURIComponent(token)}`,
    headers: env.igProxyKey ? { "x-proxy-key": env.igProxyKey } : {},
  };
}

async function callGraph(
  path: string,
  body: unknown,
  channel: MetaChannel = "INSTAGRAM",
  timeoutMs: number = TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const { url, headers } =
    channel === "MESSENGER"
      ? {
          url: `${FB_GRAPH_ORIGIN}${path}?access_token=${encodeURIComponent(await fbPageToken())}`,
          headers: {} as Record<string, string>,
        }
      : buildRequest(path, await igToken());

  const controller = new AbortController();
  // Tokens/settings and the typing animation can outlive the owner's switch.
  // Check at the actual transport boundary as well as at each entry point.
  await assertMessagingAllowed();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw metaResponseError(res.status, text);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Meta может ответить успехом с пустым телом — это не ошибка.
      return {};
    }
  } catch (error) {
    if (error instanceof MetaDeliveryError) throw error;
    // No response does not mean no delivery. Never blindly replay this request.
    throw new MetaDeliveryError("AMBIGUOUS", 0);
  } finally {
    clearTimeout(timer);
  }
}

function buildMessage(text: string, buttons: QuickButton[]): Record<string, unknown> {
  const message: Record<string, unknown> = { text };
  if (buttons.length > 0) {
    // Ограничения Meta: до 13 кнопок, надпись ≤ 20 символов, payload ≤ 1000.
    message.quick_replies = buttons.slice(0, 13).map((b) => ({
      content_type: "text",
      title: b.title.slice(0, 20),
      payload: b.payload.slice(0, 1000),
    }));
  }
  return message;
}

/**
 * «ПРОЧИТАНО» И «ПЕЧАТАЕТ…» — самое дешёвое, что отличает живую переписку.
 *
 * До этого между вопросом клиента и ответом стояла полная тишина в 5–15 секунд, а
 * потом ответ возникал из пустоты. Так не пишет ни один человек: сначала он читает
 * (появляется отметка), потом набирает (появляется «печатает»), и только потом
 * приходит текст. Именно эта пауза — самое подозрительное место в диалоге, и
 * закрывается она двумя вызовами Meta, а не переделкой бота.
 *
 * Отправляется БЕЗ ожидания результата и без падений: индикатор — украшение, и ни
 * одно сообщение не должно потеряться из-за того, что не показалась анимация.
 * Meta закрывает окно ответа через 24 часа, и тогда sender_action отвечает ошибкой —
 * это нормальный исход, а не повод ронять отправку.
 */
async function senderAction(igUserId: string, action: "mark_seen" | "typing_on", channel: MetaChannel): Promise<void> {
  try {
    await callGraph(`/${GRAPH_VERSION}/me/messages`, { recipient: { id: igUserId }, sender_action: action }, channel, 8_000);
  } catch {
    // Тишина намеренно: индикатор не стоит ни одной строки в журнале ошибок.
  }
}

/**
 * Реакция-смайлик на входящее сообщение (официальный sender_action=react, документация
 * Meta Instagram Messaging; permissions instagram_business_manage_messages). Ошибку НЕ
 * глотаем: вызывающий (ai/reactions.ts) тогда ответит обычным текстом.
 */
export async function reactToInstagramMessage(igUserId: string, messageId: string, emoji: string): Promise<void> {
  await assertMessagingAllowed();
  await callGraph(
    `/${GRAPH_VERSION}/me/messages`,
    { recipient: { id: igUserId }, sender_action: "react", payload: { message_id: messageId, reaction: emoji } },
    "INSTAGRAM",
    8_000
  );
}

/**
 * СКОЛЬКО «НАБИРАТЬ» ПЕРЕД ОТВЕТОМ.
 *
 * Ровный интервал выдаёт автомат даже подсознательно: живой человек то отвечает за
 * пять секунд, то думает полминуты. Поэтому время зависит от ДЛИНЫ ответа (длинный
 * текст дольше набирают) и слегка случайно.
 *
 * Скорость взята человеческая, но бодрая — около 12 знаков в секунду: это быстрый
 * набор с телефона. Медленнее делать нельзя: владелец как раз жаловался, что сестра
 * успевает ответить раньше бота, — правдоподобие не должно стоить нам сделки.
 */
const TYPING_CHARS_PER_SECOND = 12;
const TYPING_MIN_MS = 700;
const TYPING_MAX_MS = 4_000;

function typingDelayMs(text: string): number {
  const base = (text.length / TYPING_CHARS_PER_SECOND) * 1000;
  // ±25% разброса, чтобы паузы не были одинаковыми при похожей длине.
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, base * jitter)));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Обычное сообщение в директ, с кнопками или без. Возвращает mid от Meta (если дала).
 *
 *  Здесь же снимается повторное приветствие: это единственная дверь наружу, через
 *  которую проходят и шаги воронки, и ответы ИИ, и догоняющие — правило «здороваемся
 *  один раз» держится тут, а не в каждом тексте по отдельности (см. greeting.ts). */
export async function sendText(
  igUserId: string,
  text: string,
  buttons: QuickButton[] = [],
  channel: MetaChannel = "INSTAGRAM"
): Promise<string | null> {
  await assertMessagingAllowed();
  const clean = await withoutRepeatGreeting(igUserId, text, channel);
  // Прочитали → набираем → отвечаем: порядок как у живого человека (см. senderAction).
  await senderAction(igUserId, "mark_seen", channel);
  await senderAction(igUserId, "typing_on", channel);
  await sleep(typingDelayMs(clean));

  const payload = { recipient: { id: igUserId }, message: buildMessage(clean, buttons) };
  const res = await callGraph(`/${GRAPH_VERSION}/me/messages`, payload, channel);
  if (typeof res.message_id !== "string" || !res.message_id) throw new MetaDeliveryError("AMBIGUOUS", 200);
  return res.message_id;
}

/** Ищет контакт по каналу и id, чтобы решить, здоровались ли уже. Контакта нет
 *  (первое касание) — текст уходит нетронутым: это и есть первое приветствие. */
async function withoutRepeatGreeting(igUserId: string, text: string, channel: MetaChannel): Promise<string> {
  try {
    const contact = await prisma.contact.findUnique({
      where: { channel_igUserId: { channel, igUserId } },
      select: { id: true },
    });
    return toOwnerVoice(await stripRepeatGreeting(contact?.id ?? null, text));
  } catch {
    return toOwnerVoice(text); // подстраховка: правка голоса дешёвая, её оставляем всегда
  }
}

/** Ответ на комментарий личным сообщением (private reply) — единственный способ
 *  написать первым тому, кто только прокомментировал и ещё не писал в директ. */
export async function sendPrivateReply(
  commentId: string,
  text: string,
  buttons: QuickButton[] = [],
  channel: MetaChannel = "INSTAGRAM"
): Promise<string | null> {
  await assertMessagingAllowed();
  const res = await callGraph(
    `/${GRAPH_VERSION}/me/messages`,
    { recipient: { comment_id: commentId }, message: buildMessage(toOwnerVoice(text), buttons) },
    channel
  );
  if (typeof res.message_id !== "string" || !res.message_id) throw new MetaDeliveryError("AMBIGUOUS", 200);
  return res.message_id;
}

/** Удаляет комментарий под нашей публикацией — для спама, флирта и оскорблений:
 *  такое не отвечаем, а убираем с глаз, чтобы не висело под роликом школы. */
export async function deleteComment(commentId: string, channel: MetaChannel = "INSTAGRAM"): Promise<void> {
  const path = `/${GRAPH_VERSION}/${commentId}`;
  let url: string;
  let headers: Record<string, string> = {};

  if (channel === "MESSENGER") {
    url = `${FB_GRAPH_ORIGIN}${path}?access_token=${encodeURIComponent(await fbPageToken())}`;
  } else {
    const token = await igToken();
    url = env.igProxyBase
      ? `${env.igProxyBase}${path}?access_token=${encodeURIComponent(token)}`
      : `${GRAPH_ORIGIN}${path}`;
    headers = env.igProxyBase
      ? env.igProxyKey
        ? { "x-proxy-key": env.igProxyKey }
        : {}
      : { Authorization: `Bearer ${token}` };
  }

  const res = await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw metaResponseError(res.status, await res.text());
}

/**
 * Адрес публикации по её идентификатору. Нужен, чтобы узнать рекламный пост,
 * которого нет в ленте аккаунта: id из вебхука есть, а сопоставить его со
 * ссылкой, которую вставил владелец, иначе нечем. Сбой — null, не исключение:
 * из-за неудавшейся сверки нельзя ронять обработку комментария.
 */
export async function mediaPermalink(mediaId: string, channel: MetaChannel = "INSTAGRAM"): Promise<string | null> {
  const path = `/${GRAPH_VERSION}/${mediaId}`;
  let url: string;
  let headers: Record<string, string> = {};

  if (channel === "MESSENGER") {
    url = `${FB_GRAPH_ORIGIN}${path}?fields=permalink_url&access_token=${encodeURIComponent(await fbPageToken())}`;
  } else {
    const token = await igToken();
    url = env.igProxyBase
      ? `${env.igProxyBase}${path}?fields=permalink&access_token=${encodeURIComponent(token)}`
      : `${GRAPH_ORIGIN}${path}?fields=permalink`;
    headers = env.igProxyBase
      ? env.igProxyKey
        ? { "x-proxy-key": env.igProxyKey }
        : {}
      : { Authorization: `Bearer ${token}` };
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { permalink?: string; permalink_url?: string };
    return data.permalink ?? data.permalink_url ?? null;
  } catch {
    return null;
  }
}

/** Публичный ответ ПРЯМО НА комментарий (не в директ) — для короткого «спасибо»
 *  на комментарий из одних эмодзи, без запуска всей воронки. */
export async function replyToComment(
  commentId: string,
  text: string,
  channel: MetaChannel = "INSTAGRAM"
): Promise<string | null> {
  await assertMessagingAllowed();
  const res = await callGraph(`/${commentId}/replies`, { message: text }, channel);
  return typeof res.id === "string" ? res.id : null;
}

/** Вложение по ссылке: видео, картинка или файл. */
/**
 * ВЛОЖЕНИЮ НУЖНО БОЛЬШЕ ВРЕМЕНИ, ЧЕМ ТЕКСТУ (22.08.2026).
 *
 * Отправляя вложение, мы даём Meta ССЫЛКУ, и она скачивает файл сама — то есть в
 * наши 15 секунд должна уложиться её загрузка целиком. Для текста этого с запасом
 * хватает, для ролика меню — нет: 22.08 в журнале пять раз за день «[funnel:attachment]
 * This operation was aborted», и каждый такой раз клиент получал воронку наполовину —
 * подпись без видео, о котором в подписи и говорится.
 *
 * Минута — не «на всякий случай», а под самый тяжёлый наш ролик на медленном канале.
 */
const ATTACHMENT_TIMEOUT_MS = 60_000;

export async function sendAttachment(
  igUserId: string,
  url: string,
  type: "video" | "image" | "audio" | "file",
  channel: MetaChannel = "INSTAGRAM"
): Promise<string | null> {
  await assertMessagingAllowed();
  const payload = { recipient: { id: igUserId }, message: { attachment: { type, payload: { url } } } };

  const res = await callGraph(`/${GRAPH_VERSION}/me/messages`, payload, channel, ATTACHMENT_TIMEOUT_MS);
  if (typeof res.message_id !== "string" || !res.message_id) throw new MetaDeliveryError("AMBIGUOUS", 200);
  return res.message_id;
}
