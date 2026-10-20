import { prisma } from "./db.js";
import type { Prisma } from "@prisma/client";
import { deliveryMode } from "./course/delivery.js";

/**
 * «ОПЛАТИЛИ, НО НЕ ВОШЛИ» — считается по тому, куда выдаём доступ.
 *
 * Плитка на главной считала вход только по событию Telegram-группы. На
 * платформе это событие не наступает никогда — там своя отметка
 * (Purchase.firstOpenedAt). То есть каждая, кто пошла на платформу вместо
 * группы, навсегда числилась непришедшей, и Ширин каждый вечер видела тревогу,
 * которой нет, а настоящие два-три случая в ней тонули. Плюс у счётчика не
 * было границы по времени — он копил всех с первого дня.
 *
 * Та же развилка, что уже стоит в joinReminder.ts.
 */
async function notOpenedWhere(): Promise<Prisma.ContactWhereInput> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const mode = await deliveryMode();
  return {
    paid: true,
    paidAt: { gte: since },
    accessRevokedAt: null,
    ...(mode === "telegram" ? { joinedGroupAt: null } : { purchases: { some: { revokedAt: null, firstOpenedAt: null } } }),
  };
}

export async function countNotOpened(): Promise<number> {
  return prisma.contact.count({ where: await notOpenedWhere() });
}

export type NotOpenedRow = { contactId: string; handle: string; paidAt: string | null; daysAgo: number | null };

/** Те же люди списком — для помощницы в панели («кто не открыл урок?»). */
export async function listNotOpened(limit = 10): Promise<NotOpenedRow[]> {
  const rows = await prisma.contact.findMany({
    where: await notOpenedWhere(),
    orderBy: { paidAt: "asc" },
    take: limit,
    select: { id: true, username: true, name: true, igUserId: true, paidAt: true },
  });
  const now = Date.now();
  return rows.map((c) => ({
    contactId: c.id,
    handle: c.username ? `@${c.username}` : (c.name ?? `ID ···${c.igUserId.slice(-6)}`),
    paidAt: c.paidAt?.toISOString() ?? null,
    daysAgo: c.paidAt ? Math.floor((now - c.paidAt.getTime()) / 86_400_000) : null,
  }));
}
