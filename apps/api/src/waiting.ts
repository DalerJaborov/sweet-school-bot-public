import { Router } from "express";
import { autoCatch } from "./asyncRoute.js";
import { prisma } from "./db.js";
import { isTrivialKind, isTrivialMessage } from "./trivialMessage.js";
import { attentionText, chatTitle, describeIncoming } from "./whatsapp/attention.js";

/**
 * «КЛИЕНТАМ НУЖЕН ОТВЕТ» — для экрана «Сегодня» в панели.
 *
 * Сюда попадают ТОЛЬКО клиенты, которых бот сам передал человеку:
 *   1. клиент попросил позвать Ширин (Contact.humanRequestedAt, ставит
 *      ai.ts callOwnerToChat) и живой ответ после этого ещё не был;
 *   2. бот не смог ответить: ответ ИИ завис в очереди повторов
 *      (PendingAiReply, две и больше неудачные попытки);
 *   3. WhatsApp: чат помечен «нужен ответ» (WhatsAppInbox.status = attention).
 * Просто «последнее входящее сообщение» не показывается НИКОГДА: «Рахмат»,
 * «Хоб майла» и приветствия владелец видеть не хочет, а если надо — прочитает
 * сам в Instagram. Выключенный помощник («ждут все») тоже ничего не меняет.
 *
 * Пустяки (благодарность, «ок», «хоб», приветствие, смайлик, стикер, реакция)
 * отсеиваются в любом случае — см. trivialMessage.ts.
 *
 * Наружу уходят имя, канал и причина простыми словами. Текст переписки
 * карточке не отдаём — он открывается отдельно, по нажатию
 * (GET /admin/contacts/:id/messages).
 */
export const waitingRouter = autoCatch(Router());

/** Старше недели — уже не «ждёт», а забытый разговор. */
const WINDOW_MS = 7 * 86_400_000;
const LIMIT = 30;

export type WaitingClient = {
  contactId: string;
  name: string;
  channel: string;
  channelLabel: string;
  /** Куда нажать, чтобы ответить (Instagram по имени). null — ссылки нет, панель покажет переписку. */
  replyUrl: string | null;
  /** Почему клиент здесь — простыми словами. */
  reason: string;
  at: string;
};

export function channelLabel(channel: string): string {
  switch (channel) {
    case "INSTAGRAM":
      return "Instagram";
    case "WHATSAPP":
      return "WhatsApp";
    case "MESSENGER":
      return "Messenger";
    case "WEB":
      return "Сайт";
    default:
      return "Чат";
  }
}

type ContactLite = { channel: string; igUserId: string; username: string | null; name: string | null };

export function waitingName(c: ContactLite): string {
  if (c.name?.trim()) return c.name.trim();
  if (c.username?.trim()) return c.channel === "INSTAGRAM" ? `@${c.username.trim()}` : c.username.trim();
  return "Клиент без имени";
}

/**
 * Ссылка «ответить» — только Instagram по имени (ig.me/m/<имя> открывает
 * личные сообщения). WhatsApp намеренно без ссылки: wa.me открыл бы личный
 * WhatsApp того, кто нажал, а не рабочий номер школы.
 */
export function replyUrlOf(c: ContactLite): string | null {
  if (c.channel === "INSTAGRAM" && c.username?.trim()) return `https://ig.me/m/${encodeURIComponent(c.username.trim())}`;
  return null;
}

export const REASON_ASKED_HUMAN = "Просит позвать Ширин";
export const REASON_BOT_FAILED = "Помощник не смог ответить";

/** Приоритет причины, если у клиента их несколько: просьба человека важнее поломки. */
const PRIORITY = [REASON_ASKED_HUMAN, REASON_BOT_FAILED];

export async function waitingClients(now = Date.now()): Promise<WaitingClient[]> {
  const since = new Date(now - WINDOW_MS);
  const found = new Map<string, { reason: string; at: Date; chatId?: string }>();
  const add = (contactId: string, reason: string, at: Date, chatId?: string) => {
    const prev = found.get(contactId);
    const rank = (r: string) => (PRIORITY.indexOf(r) === -1 ? PRIORITY.length : PRIORITY.indexOf(r));
    if (!prev || rank(reason) < rank(prev.reason)) found.set(contactId, { reason, at, chatId });
  };

  // 1. Клиент попросил позвать человека, и после этого живой ответ не приходил.
  const asked = await prisma.contact.findMany({
    where: { humanRequestedAt: { gte: since }, personal: false, spamBlockedAt: null, whatsappSavedContact: false },
    orderBy: { humanRequestedAt: "desc" },
    take: 200,
    select: { id: true, humanRequestedAt: true },
  });
  if (asked.length > 0) {
    const replies = await prisma.message.findMany({
      where: { contactId: { in: asked.map((c) => c.id) }, direction: "OUT", byHuman: true, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { contactId: true, createdAt: true },
    });
    const lastHuman = new Map<string, Date>();
    for (const m of replies) if (!lastHuman.has(m.contactId)) lastHuman.set(m.contactId, m.createdAt);
    for (const c of asked) {
      const human = lastHuman.get(c.id);
      if (human && human >= c.humanRequestedAt!) continue;
      add(c.id, REASON_ASKED_HUMAN, c.humanRequestedAt!);
    }
  }

  // 2. Ответ ИИ завис: две и больше неудачные попытки. Пустяки не считаем.
  const stuck = await prisma.pendingAiReply.findMany({
    where: { attempts: { gte: 2 }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { contactId: true, text: true, createdAt: true },
  });
  for (const p of stuck) if (!isTrivialMessage(p.text)) add(p.contactId, REASON_BOT_FAILED, p.createdAt);

  // 3. WhatsApp: чат помечен «нужен ответ».
  const marked = await prisma.whatsAppInbox.findMany({
    where: { status: "attention", contactId: { not: null }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  for (const row of marked) {
    if (isTrivialKind(row.kind)) continue;
    const incoming = describeIncoming(row.payload);
    // Текстовое «Рахмат» — пустяк; фото/голосовое без текста — нет, оно непонятно без человека.
    if (incoming.kind === "text" && incoming.text !== "" && isTrivialMessage(incoming.text)) continue;
    add(row.contactId!, attentionText(row.attentionReason), row.createdAt, row.chatId);
  }

  if (found.size === 0) return [];
  const contacts = await prisma.contact.findMany({
    where: { id: { in: [...found.keys()] }, personal: false, spamBlockedAt: null },
    select: { id: true, channel: true, igUserId: true, username: true, name: true },
  });
  const out: WaitingClient[] = [];
  for (const c of contacts) {
    const f = found.get(c.id)!;
    const name = c.channel === "WHATSAPP" && !c.name?.trim() && f.chatId ? chatTitle(null, f.chatId) : waitingName(c);
    out.push({
      contactId: c.id,
      name,
      channel: c.channel,
      channelLabel: channelLabel(c.channel),
      replyUrl: replyUrlOf(c),
      reason: f.reason,
      at: f.at.toISOString(),
    });
  }
  // Кто ждёт дольше всех — первым.
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(0, LIMIT);
}

waitingRouter.get("/admin/v1/waiting", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const clients = await waitingClients();
  res.json({ count: clients.length, clients });
});
