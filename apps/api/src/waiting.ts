import { Router } from "express";
import { autoCatch } from "./asyncRoute.js";
import { prisma, getSetting } from "./db.js";

/**
 * «КЛИЕНТЫ ЖДУТ ОТВЕТА» — для экрана «Сегодня» в панели.
 *
 * Человек ждёт живого ответа, когда его последнее СВОБОДНОЕ сообщение пришло
 * после последнего ответа ЖИВОГО человека (byHuman), а бот отвечать не будет:
 *   - клиент попросил позвать человека — бот замолчал на час (ai.ts
 *     callOwnerToChat, humanSilencedUntil); сообщение клиента пришло до конца
 *     этой тишины;
 *   - хозяйка вела разговор из приложения Instagram (humanTakenOverAt) и
 *     клиент написал снова;
 *   - помощник выключен целиком (aiEnabled не "true") или бот заморожен
 *     (botFrozen) — тогда ждут все, кто написал.
 *
 * ОТВЕТЫ БОТА НЕ СЧИТАЮТСЯ. Сразу после просьбы «позовите человека» бот шлёт
 * «зову Ширин» — и это исходящее сообщение раньше становилось «последним»,
 * клиент пропадал из списка в тот же миг. Теперь смотрим только на свободные
 * входящие и на ответы живого человека.
 *
 * Новых полей не нужно. Личные контакты и заблокированных за спам пропускаем.
 */
export const waitingRouter = autoCatch(Router());

/** Старше недели — уже не «ждёт», а забытый разговор: в «Сегодня» не тащим. */
const WINDOW_MS = 7 * 86_400_000;
const LIMIT = 30;
const SCAN = 300;

export type WaitingClient = {
  contactId: string;
  name: string;
  channel: string;
  channelLabel: string;
  /** Куда нажать, чтобы ответить (Instagram по имени). null — ссылки нет, панель покажет переписку. */
  replyUrl: string | null;
  lastText: string;
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
  if (c.channel === "INSTAGRAM" && c.username?.trim())
    return `https://ig.me/m/${encodeURIComponent(c.username.trim())}`;
  return null;
}

export async function waitingClients(now = Date.now()): Promise<{ clients: WaitingClient[]; aiOff: boolean }> {
  const since = new Date(now - WINDOW_MS);
  const [aiSetting, frozen] = await Promise.all([getSetting("aiEnabled"), getSetting("botFrozen")]);
  const aiOff = aiSetting !== "true" || frozen === "true";

  const rows = await prisma.contact.findMany({
    where: {
      personal: false,
      spamBlockedAt: null,
      whatsappSavedContact: false,
      // Есть свободное входящее за неделю — иначе кандидат не нужен вовсе.
      messages: { some: { direction: "IN", payload: null, createdAt: { gte: since } } },
      ...(aiOff ? {} : { OR: [{ humanSilencedUntil: { gte: since } }, { humanTakenOverAt: { not: null } }] }),
    },
    orderBy: { updatedAt: "desc" },
    take: SCAN,
    select: {
      id: true,
      channel: true,
      igUserId: true,
      username: true,
      name: true,
      humanSilencedUntil: true,
      humanTakenOverAt: true,
      messages: {
        where: { direction: "IN", payload: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { text: true, createdAt: true },
      },
    },
  });
  if (rows.length === 0) return { clients: [], aiOff };

  // Последний ответ живого человека по каждому кандидату — одним запросом.
  const humanReplies = await prisma.message.findMany({
    where: { contactId: { in: rows.map((r) => r.id) }, direction: "OUT", byHuman: true, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { contactId: true, createdAt: true },
  });
  const lastHuman = new Map<string, Date>();
  for (const m of humanReplies) if (!lastHuman.has(m.contactId)) lastHuman.set(m.contactId, m.createdAt);

  const out: WaitingClient[] = [];
  for (const row of rows) {
    const last = row.messages[0];
    if (!last || last.createdAt < since) continue;
    const human = lastHuman.get(row.id);
    if (human && human >= last.createdAt) continue; // уже ответили
    if (!aiOff) {
      // Бот молчал именно тогда, когда клиент писал: тишина ещё идёт или была
      // включена до его сообщения; либо разговор перехвачен живым человеком.
      const silentThen = row.humanSilencedUntil != null && row.humanSilencedUntil >= last.createdAt;
      if (!silentThen && !row.humanTakenOverAt) continue;
    }
    out.push({
      contactId: row.id,
      name: waitingName(row),
      channel: row.channel,
      channelLabel: channelLabel(row.channel),
      replyUrl: replyUrlOf(row),
      lastText: (last.text ?? "").trim() || "Прислал(а) фото или файл",
      at: last.createdAt.toISOString(),
    });
  }
  // Кто ждёт дольше всех — первым.
  out.sort((a, b) => a.at.localeCompare(b.at));
  return { clients: out.slice(0, LIMIT), aiOff };
}

waitingRouter.get("/admin/v1/waiting", async (_req, res) => {
  const { clients, aiOff } = await waitingClients();
  res.json({ count: clients.length, aiOff, clients });
});
