import { prisma } from "./db.js";
import { localDayStart, offsetMs } from "./dailyReport.js";
import { COURSE_50, COURSE_70, COURSE_TITLE } from "./courses.js";
import { getBotState, type BotState } from "./botControl.js";

/**
 * «ГЛАВНОЕ СЕГОДНЯ» — деньги, оплаты, записи на офлайн и состояние бота (11.11.2026).
 *
 * Один источник и для верха экрана «Сегодня» в панели (GET /admin/today), и для
 * кнопки «📊 Сегодня» в Telegram. Считаем по покупкам (Purchase), как экраны
 * «Деньги» и вечерняя сводка: деньги получены, когда покупка создана, — неважно,
 * кто нажал кнопку (бот, владелец или Ширин руками).
 */
const COURSE_SHORT: Record<string, string> = {
  [COURSE_50]: COURSE_TITLE[COURSE_50],
  [COURSE_70]: COURSE_TITLE[COURSE_70],
};

export type MainEvent = {
  kind: "payment" | "offline";
  /** Ник или имя. */
  who: string;
  /** «21 рецепт, 70 с.» или «+992 …». */
  what: string;
  at: string;
};

export type MainSummary = {
  money: { today: number; salesToday: number; week: number; salesWeek: number };
  offline: { today: number; week: number };
  /** Чеки, которые бот не смог проверить сам (нужно решение владельца). */
  pendingReceipts: number;
  /** Последние события: оплаты и записи на офлайн, свежие сверху. */
  recent: MainEvent[];
  bot: BotState;
};

function handle(c: { username: string | null; igUserId: string }): string {
  return c.username ? `@${c.username}` : `ID ···${c.igUserId.slice(-6)}`;
}

export async function buildMainSummary(now = Date.now()): Promise<MainSummary> {
  const offset = await offsetMs();
  const dayStart = localDayStart(0, offset);
  const weekAgo = new Date(now - 7 * 86_400_000);

  const [purchases, signups, pendingReceipts, bot] = await Promise.all([
    prisma.purchase.findMany({
      where: { createdAt: { gte: weekAgo }, revokedAt: null, amount: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      include: { contact: { select: { username: true, igUserId: true } } },
      take: 300,
    }),
    prisma.offlineSignup.findMany({
      where: { createdAt: { gte: weekAgo } },
      orderBy: { createdAt: "desc" },
      include: { contact: { select: { username: true, igUserId: true } } },
      take: 100,
    }),
    prisma.receiptCheck.count({ where: { ownerDecision: "PENDING" } }),
    getBotState(),
  ]);

  const todayPurchases = purchases.filter((p) => p.createdAt >= dayStart);
  const recent: MainEvent[] = [];
  // Комплект из двух курсов — одной строкой.
  const grouped = new Map<string, typeof purchases>();
  for (const p of purchases.slice(0, 40)) {
    const key = `${p.contactId}:${Math.floor(p.createdAt.getTime() / 120_000)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), p]);
  }
  for (const list of grouped.values()) {
    const first = list[0];
    const sum = list.reduce((t, p) => t + p.amount, 0);
    const courses = [...new Set(list.map((p) => COURSE_SHORT[p.course] ?? p.course))].join(" + ");
    recent.push({
      kind: "payment",
      who: handle(first.contact),
      what: `${courses}, ${sum} с.`,
      at: first.createdAt.toISOString(),
    });
  }
  for (const s of signups.slice(0, 20)) {
    recent.push({
      kind: "offline",
      who: s.name || handle(s.contact),
      what: `офлайн, ${s.phone}`,
      at: s.createdAt.toISOString(),
    });
  }
  recent.sort((a, b) => b.at.localeCompare(a.at));

  const sum = (rows: { amount: number }[]) => rows.reduce((t, r) => t + r.amount, 0);
  return {
    money: {
      today: sum(todayPurchases),
      salesToday: todayPurchases.length,
      week: sum(purchases),
      salesWeek: purchases.length,
    },
    offline: { today: signups.filter((s) => s.createdAt >= dayStart).length, week: signups.length },
    pendingReceipts,
    recent: recent.slice(0, 6),
    bot,
  };
}
