import { Router } from "express";
import { autoCatch } from "./asyncRoute.js";
import { prisma } from "./db.js";

/**
 * «КЛИЕНТЫ ЖДУТ ОТВЕТА» — для экрана «Сегодня» в панели.
 *
 * Человек ждёт живого ответа, когда его последнее сообщение — входящее, а бот
 * молчит: либо клиент сам попросил позвать человека (ai.ts callOwnerToChat
 * ставит humanSilencedUntil), либо хозяйка уже вела разговор из приложения
 * Instagram (humanTakenOverAt) и клиент написал снова. Новых полей в базе не
 * нужно: всё выводится из журнала сообщений. Обычный разговор с ботом сюда не
 * попадает — там последним стоит ответ бота.
 *
 * Личные контакты и заблокированных за спам пропускаем — отвечать им никто не
 * должен.
 */
export const waitingRouter = autoCatch(Router());

/** Старше недели — уже не «ждёт», а забытый разговор: в «Сегодня» не тащим. */
const WINDOW_MS = 7 * 86_400_000;
const LIMIT = 30;

export type WaitingClient = {
  contactId: string;
  name: string;
  channel: string;
  channelLabel: string;
  /** Куда нажать, чтобы ответить: профиль Instagram или чат WhatsApp. null — ссылки нет. */
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

export function replyUrlOf(c: ContactLite): string | null {
  if (c.channel === "INSTAGRAM" && c.username) return `https://www.instagram.com/${encodeURIComponent(c.username)}/`;
  if (c.channel === "WHATSAPP") {
    const phone = c.igUserId.replace(/^wa:/, "").replace(/\D/g, "");
    return phone.length >= 7 ? `https://wa.me/${phone}` : null;
  }
  return null;
}

export async function waitingClients(now = Date.now()): Promise<WaitingClient[]> {
  const since = new Date(now - WINDOW_MS);
  const rows = await prisma.contact.findMany({
    where: {
      personal: false,
      spamBlockedAt: null,
      whatsappSavedContact: false,
      OR: [{ humanSilencedUntil: { gte: since } }, { humanTakenOverAt: { not: null } }],
    },
    select: {
      id: true,
      channel: true,
      igUserId: true,
      username: true,
      name: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { direction: true, text: true, createdAt: true } },
    },
    take: 200,
  });
  const out: WaitingClient[] = [];
  for (const row of rows) {
    const last = row.messages[0];
    if (!last || last.direction !== "IN" || last.createdAt < since) continue;
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
  return out.slice(0, LIMIT);
}

waitingRouter.get("/admin/v1/waiting", async (_req, res) => {
  const clients = await waitingClients();
  res.json({ count: clients.length, clients });
});
