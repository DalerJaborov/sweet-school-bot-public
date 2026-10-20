import { Router } from "express";
import { autoCatch } from "./asyncRoute.js";
import { prisma, getSetting } from "./db.js";
import { offsetMs, localDayStart } from "./dailyReport.js";
import { countNotOpened } from "./notOpened.js";
import { deliveryMode } from "./course/delivery.js";
import { unansweredCount } from "./course/chat.js";
import { healthReport } from "./health.js";
import { storageConfig } from "./storage/s3.js";
import { globalAiUsageToday } from "./ai/dailyBudget.js";
import { getPrices } from "./services/priceService.js";
import { COURSE_50, COURSE_70, COURSE_TITLE, type PriceTable } from "./prices.js";
import { completedCoursesSince } from "./metrics.js";

/**
 * ГЛАВНЫЙ ЭКРАН «СЕГОДНЯ» — утренняя записка от помощницы (предложение
 * «Утро Ширин» §1, 2, 3, 4; 05.09.2026).
 *
 * Один запрос отдаёт всё, что Ширин видит за 20 секунд за чаем: три утренних
 * числа (деньги за вчера, чеки в ожидании, вопросы без ответа), спарклайн за
 * 14 дней, очередь «Сделать сейчас» с действием прямо в карточке, «Хорошие
 * новости» и одну строку состояния системы. Старый /admin/dashboard остаётся
 * для «Денег» и листания по дням — этот экран отвечает не на «сколько», а на
 * «что делать».
 *
 * КЭШ 30 С: экран открывают из Telegram по нескольку раз в час, а внутри —
 * десяток запросов к базе. После действия (подтвердила чек) панель просит
 * `?fresh=1`, чтобы карточка исчезла сразу, а не через полминуты.
 */
// autoCatch — СВОЙ, а не унаследованный: adminRouter оборачивается в index.ts,
// но это патчит только его собственные router.get/post; маршруты, объявленные
// на вложенном роутере, Express 4 не защищает — отклонённый промис здесь
// вешал запрос навсегда (финальный аудит 05.09.2026).
export const todayRouter = autoCatch(Router());

const CACHE_TTL_MS = 30_000;
const SPARKLINE_DAYS = 14;
const QUEUE_LIMIT = 30;
/** «Оплатила, но не открыла» — тревожим не раньше, чем через двое суток. */
const NOT_OPENED_AFTER_MS = 2 * 86_400_000;
const GOOD_NEWS_WINDOW_MS = 7 * 86_400_000;
const GEMINI_ALERT_PCT = 80;

let cache: { at: number; data: TodayResponse } | null = null;

type Handle = {
  contactId: string;
  handle: string;
  /** Ссылка «написать» — профиль Instagram по нику; у сайта/Messenger её нет. */
  instagramUrl: string | null;
  channel: string | null;
};

export type QueueItem =
  | {
      kind: "receipt";
      id: string;
      who: Handle;
      imageUrl: string | null;
      amount: number | null;
      /** Какой курс это, судя по сумме — как прочитал ИИ и разложил бы allocate(). */
      courseGuess: string | null;
      reason: string;
      confidence: number;
      createdAt: string;
    }
  | { kind: "question"; id: string; who: Handle; text: string; lesson: string | null; createdAt: string }
  | { kind: "notOpened"; who: Handle; paidAt: string; daysAgo: number }
  | { kind: "transcodeFailed"; lessonId: string; title: string }
  /** Рецепты, прочитанные с карточки и ещё не проверенные глазами (course/adminRoutes.ts). */
  | { kind: "recipesToReview"; count: number }
  | { kind: "gemini"; calls: number; limit: number; percent: number };

export type GoodNewsItem = {
  kind: "finished" | "certificate" | "openedSameDay";
  who: Handle;
  course: string | null;
  at: string;
  /** Заготовка просьбы об отзыве — панель копирует её и открывает профиль. */
  reviewText: string;
};

export type TodayResponse = {
  generatedAt: string;
  money: {
    yesterday: number;
    dayBefore: number;
    week: number;
    prevWeek: number;
    salesYesterday: number;
    salesWeek: number;
  };
  pendingReceipts: number;
  unansweredQuestions: number;
  notOpened: number;
  sparkline: { day: string; money: number; sales: number }[];
  queue: QueueItem[];
  goodNews: GoodNewsItem[];
  system: {
    bot: boolean;
    instagram: boolean;
    storage: boolean;
    diskFreePct: number | null;
    gemini: { calls: number; limit: number };
    problems: string[];
  };
};

function handleOf(c: { id: string; username?: string | null; igUserId: string; channel?: string | null }): Handle {
  const handle = c.username ? `@${c.username}` : c.igUserId.length > 8 ? `ID ···${c.igUserId.slice(-6)}` : `ID ${c.igUserId}`;
  const instagram = c.username && (c.channel ?? "INSTAGRAM") === "INSTAGRAM" ? `https://www.instagram.com/${c.username}/` : null;
  return { contactId: c.id, handle, instagramUrl: instagram, channel: c.channel ?? null };
}

/** Тот же допуск, что у allocate(): −6 на комиссию, +30 сверху. */
export function guessCourse(amount: number | null, p: PriceTable): string | null {
  if (amount == null) return null;
  if (amount >= p.bundle - 6 && amount <= p.bundleFull + 40) return "оба курса";
  const single = ([COURSE_50, COURSE_70] as const)
    .filter((c) => amount >= p.price[c] - 6 && amount <= p.price[c] + 30)
    .sort((a, b) => Math.abs(amount - p.price[a]) - Math.abs(amount - p.price[b]));
  return single.length > 0 ? COURSE_TITLE[single[0]] : null;
}

function reviewText(course: string | null): string {
  return (
    `Поздравляю с окончанием${course ? ` курса «${course}»` : ""}! 🎉 Если понравилось — напишите пару слов, ` +
    "как прошло: ваш отзыв поможет другим решиться."
  );
}

async function buildToday(): Promise<TodayResponse> {
  const now = Date.now();
  const offset = await offsetMs();
  const sparkStart = localDayStart(SPARKLINE_DAYS - 1, offset);
  const yesterdayStart = localDayStart(1, offset);
  const todayStart = localDayStart(0, offset);
  const dayBeforeStart = localDayStart(2, offset);
  const weekAgo = new Date(now - 7 * 86_400_000);
  const twoWeeksAgo = new Date(now - 14 * 86_400_000);
  const goodNewsSince = new Date(now - GOOD_NEWS_WINDOW_MS);
  const prices = await getPrices();
  const mode = await deliveryMode();

  const [purchases, pendingReceipts, questions, notOpenedContacts, failedLessons, certificates, recentPurchases, gemini, health, storage, aiOn, igToken, unanswered, notOpenedCount, finishedCourses, recipesToReview] =
    await Promise.all([
      prisma.purchase.findMany({
        where: { createdAt: { gte: new Date(Math.min(sparkStart.getTime(), twoWeeksAgo.getTime())) }, revokedAt: null },
        select: { amount: true, createdAt: true },
      }),
      prisma.receiptCheck.findMany({
        where: { ownerDecision: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: QUEUE_LIMIT,
        include: { contact: { select: { id: true, username: true, igUserId: true, channel: true } } },
      }),
      prisma.courseChatMessage.findMany({
        where: { fromStudent: true, readByOwnerAt: null },
        orderBy: { createdAt: "asc" },
        take: QUEUE_LIMIT,
        include: {
          lesson: { select: { title: true } },
          purchase: { include: { contact: { select: { id: true, username: true, igUserId: true, channel: true } } } },
        },
      }),
      prisma.contact.findMany({
        where: {
          paid: true,
          paidAt: { lte: new Date(now - NOT_OPENED_AFTER_MS), gte: new Date(now - 30 * 86_400_000) },
          accessRevokedAt: null,
          ...(mode === "telegram"
            ? { joinedGroupAt: null }
            : { purchases: { some: { revokedAt: null, firstOpenedAt: null } } }),
        },
        orderBy: { paidAt: "asc" },
        take: 10,
        select: { id: true, username: true, igUserId: true, channel: true, paidAt: true },
      }),
      prisma.lesson.findMany({ where: { status: "FAILED", deletedAt: null }, select: { id: true, title: true }, take: 10 }),
      prisma.certificate.findMany({
        where: { issuedAt: { gte: goodNewsSince } },
        orderBy: { issuedAt: "desc" },
        take: 10,
        include: {
          contact: { select: { id: true, username: true, igUserId: true, channel: true } },
          course: { select: { title: true } },
        },
      }),
      prisma.purchase.findMany({
        where: { createdAt: { gte: goodNewsSince }, revokedAt: null, courseId: { not: null } },
        select: {
          id: true,
          createdAt: true,
          firstOpenedAt: true,
          contact: { select: { id: true, username: true, igUserId: true, channel: true } },
          courseRef: { select: { title: true } },
        },
      }),
      globalAiUsageToday(),
      healthReport().catch(() => null),
      storageConfig().catch(() => null),
      getSetting("aiEnabled"),
      getSetting("igToken"),
      unansweredCount(),
      countNotOpened(),
      // «Прошла курс» — все готовые уроки закрыты, последний — за неделю
      // (metrics.ts: то же правило, что в воронке и вечерней сводке).
      completedCoursesSince(goodNewsSince),
      // То же условие, что у GET /admin/recipes/review-count.
      prisma.lesson.count({ where: { recipeSource: "card-ocr", recipeReviewedAt: null, deletedAt: null } }),
    ]);

  // Спарклайн и утренние числа — по дням Душанбе, как в /admin/dashboard.
  const perDay = new Map<string, { money: number; sales: number }>();
  for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
    perDay.set(dayKey(localDayStart(i, offset), offset), { money: 0, sales: 0 });
  }
  const sum = (from: Date, to: Date) => {
    let money = 0;
    let sales = 0;
    for (const p of purchases) {
      if (p.createdAt >= from && p.createdAt < to) {
        money += p.amount;
        sales += 1;
      }
    }
    return { money, sales };
  };
  for (const p of purchases) {
    const key = dayKey(p.createdAt, offset);
    const bucket = perDay.get(key);
    if (bucket) {
      bucket.money += p.amount;
      bucket.sales += 1;
    }
  }
  const yesterday = sum(yesterdayStart, todayStart);
  const dayBefore = sum(dayBeforeStart, yesterdayStart);
  const week = sum(weekAgo, new Date(now + 1));
  const prevWeek = sum(twoWeeksAgo, weekAgo);

  const queue: QueueItem[] = [];
  for (const r of pendingReceipts) {
    queue.push({
      kind: "receipt",
      id: r.id,
      who: handleOf(r.contact),
      imageUrl: r.imageUrl,
      amount: r.amount,
      courseGuess: guessCourse(r.amount, prices),
      reason: r.reason,
      confidence: r.confidence,
      createdAt: r.createdAt.toISOString(),
    });
  }
  for (const q of questions) {
    queue.push({
      kind: "question",
      id: q.id,
      who: handleOf(q.purchase.contact),
      text: q.text ?? "",
      lesson: q.lesson?.title ?? null,
      createdAt: q.createdAt.toISOString(),
    });
  }
  for (const c of notOpenedContacts) {
    if (!c.paidAt) continue;
    queue.push({
      kind: "notOpened",
      who: handleOf(c),
      paidAt: c.paidAt.toISOString(),
      daysAgo: Math.floor((now - c.paidAt.getTime()) / 86_400_000),
    });
  }
  for (const l of failedLessons) queue.push({ kind: "transcodeFailed", lessonId: l.id, title: l.title });
  if (recipesToReview > 0) queue.push({ kind: "recipesToReview", count: recipesToReview });
  const geminiPct = gemini.limit > 0 ? Math.round((gemini.calls / gemini.limit) * 100) : 0;
  if (geminiPct >= GEMINI_ALERT_PCT) queue.push({ kind: "gemini", calls: gemini.calls, limit: gemini.limit, percent: geminiPct });

  // Хорошие новости: сертификат — самый надёжный признак «прошла курс»;
  // открыла урок в день покупки — вовлечена, ей можно написать тепло.
  const goodNews: GoodNewsItem[] = [];
  for (const c of certificates) {
    goodNews.push({
      kind: "certificate",
      who: handleOf(c.contact),
      course: c.course.title,
      at: c.issuedAt.toISOString(),
      reviewText: reviewText(c.course.title),
    });
  }
  const certified = new Set(certificates.map((c) => `${c.contactId}:${c.course.title}`));
  // Прошла курс, но сертификат ещё не скачала — самый тёплый повод написать:
  // и поздравить, и напомнить про сертификат, и попросить отзыв. С сертификатом
  // не дублируем — та карточка уже выше.
  const finishedContactIds = finishedCourses.filter((f) => !certified.has(`${f.contactId}:${f.courseTitle ?? ""}`)).map((f) => f.contactId);
  const finishedContacts =
    finishedContactIds.length > 0
      ? await prisma.contact.findMany({
          where: { id: { in: finishedContactIds } },
          select: { id: true, username: true, igUserId: true, channel: true },
        })
      : [];
  const contactById = new Map(finishedContacts.map((c) => [c.id, c]));
  const finishedKeys = new Set<string>();
  for (const f of finishedCourses) {
    const c = contactById.get(f.contactId);
    if (!c) continue;
    finishedKeys.add(`${f.contactId}:${f.courseTitle ?? ""}`);
    goodNews.push({
      kind: "finished",
      who: handleOf(c),
      course: f.courseTitle,
      at: f.finishedAt.toISOString(),
      reviewText: reviewText(f.courseTitle),
    });
  }
  for (const p of recentPurchases) {
    if (!p.firstOpenedAt) continue;
    if (dayKey(p.firstOpenedAt, offset) !== dayKey(p.createdAt, offset)) continue;
    const key = `${p.contact.id}:${p.courseRef?.title ?? ""}`;
    if (certified.has(key) || finishedKeys.has(key)) continue;
    goodNews.push({
      kind: "openedSameDay",
      who: handleOf(p.contact),
      course: p.courseRef?.title ?? null,
      at: p.firstOpenedAt.toISOString(),
      reviewText: reviewText(p.courseRef?.title ?? null),
    });
  }
  goodNews.sort((a, b) => b.at.localeCompare(a.at));

  return {
    generatedAt: new Date(now).toISOString(),
    money: {
      yesterday: yesterday.money,
      dayBefore: dayBefore.money,
      week: week.money,
      prevWeek: prevWeek.money,
      salesYesterday: yesterday.sales,
      salesWeek: week.sales,
    },
    pendingReceipts: pendingReceipts.length,
    unansweredQuestions: unanswered,
    notOpened: notOpenedCount,
    sparkline: [...perDay.entries()].map(([day, v]) => ({ day, ...v })),
    queue,
    goodNews: goodNews.slice(0, 10),
    system: {
      bot: aiOn === "true",
      instagram: Boolean(igToken?.trim()),
      storage: Boolean(storage),
      diskFreePct: health?.diskFreePct ?? null,
      gemini,
      problems: health?.problems ?? [],
    },
  };
}

/** ГГГГ-ММ-ДД по местному (Душанбе) дню — тот же сдвиг, что у localDayStart. */
function dayKey(at: Date, offset: number): string {
  return new Date(at.getTime() + offset).toISOString().slice(0, 10);
}

/** Сводка «Сегодня» с тем же 30-секундным кэшем, что у маршрута, —
 *  помощница в панели (assistantPanel.ts) берёт числа отсюда же. */
export async function todaySnapshot(fresh = false): Promise<TodayResponse> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await buildToday();
  cache = { at: Date.now(), data };
  return data;
}

todayRouter.get("/admin/today", async (req, res) => {
  res.json(await todaySnapshot(req.query.fresh === "1"));
});

/** Сбросить кэш — после решения по чеку/ответа, чтобы очередь обновилась сразу. */
export function resetTodayCache(): void {
  cache = null;
}
