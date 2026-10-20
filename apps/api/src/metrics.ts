import { Router } from "express";
import { prisma } from "./db.js";
import { autoCatch } from "./asyncRoute.js";
import { describeDevice } from "./course/access.js";
import { issueCourseLink } from "./course/delivery.js";

/**
 * ЦИФРЫ ДЛЯ «ДЕНЕГ» И КАРТОЧКА УЧЕНИЦЫ — волна 2 предложения «Утро Ширин»
 * (§7, 9, 10; 05.09.2026).
 *
 *   GET  /admin/metrics/funnel?days=30   — воронка от «написала» до сертификата
 *   GET  /admin/metrics/revenue?days=30  — выручка по курсу и каналу, срок до оплаты
 *   GET  /admin/metrics/student/:id      — карточка ученицы: прогресс, устройства
 *   POST /admin/metrics/student/:id/link — новая ссылка на платформу
 *
 * Всё считается из имеющихся таблиц, без новых колонок. КАНАЛ ПОКУПКИ — не
 * поле, а вывод на лету: `Purchase.source === "MANUAL"` → «вручную», иначе
 * канал контакта (Instagram / Messenger / сайт). Отдельный столбец у покупки
 * пришлось бы заполнять в grantCourses и бэкфиллить миграцией ровно тем же
 * правилом — а правило одно, и контакт у покупки всегда есть.
 *
 * Монтируется внутрь adminRouter (admin.ts), как и today.ts: проверка пароля
 * стоит там, здесь не повторяется.
 */
export const metricsRouter = autoCatch(Router());

export type PurchaseChannel = "INSTAGRAM" | "MESSENGER" | "WEB" | "MANUAL";

export const CHANNEL_TITLE: Record<PurchaseChannel, string> = {
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  WEB: "сайт",
  MANUAL: "вручную",
};

/** Канал покупки — см. шапку файла. Неизвестный канал контакта считаем Instagram:
 *  так заведено у Contact.channel по умолчанию. */
export function purchaseChannel(p: { source: string; contact: { channel: string | null } }): PurchaseChannel {
  if (p.source === "MANUAL") return "MANUAL";
  const c = p.contact.channel;
  return c === "MESSENGER" || c === "WEB" ? c : "INSTAGRAM";
}

/** Период в днях из строки запроса: 7 / 30 / 90 по умолчанию 30, не больше года. */
export function daysParam(raw: unknown, fallback = 30): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), 365);
}

// ---------- «прошла курс»: все READY-уроки покупки завершены ----------

export type CompletedCourse = {
  purchaseId: string;
  contactId: string;
  courseId: string;
  courseTitle: string | null;
  /** Когда закрыт последний урок — это и есть момент «прошла курс». */
  finishedAt: Date;
};

/**
 * Покупки, по которым с `since` завершён хотя бы один урок, и при этом
 * ЗАВЕРШЕНЫ ВСЕ готовые уроки курса. Общая для главного экрана (хорошие
 * новости), вечерней сводки и воронки — одно правило «прошла курс» на всех.
 *
 * Уроки без видео (не READY) не считаются: иначе курс с одним недогруженным
 * уроком нельзя было бы «пройти» никому.
 */
export async function completedCoursesSince(since: Date): Promise<CompletedCourse[]> {
  const recent = await prisma.progress.findMany({
    where: { completedAt: { gte: since }, purchase: { revokedAt: null, courseId: { not: null } } },
    select: {
      purchaseId: true,
      purchase: { select: { contactId: true, courseId: true, courseRef: { select: { title: true } } } },
    },
  });
  if (recent.length === 0) return [];
  const byPurchase = new Map(recent.map((r) => [r.purchaseId, r.purchase]));
  return completedAmong([...byPurchase.entries()].map(([purchaseId, p]) => ({ purchaseId, ...p })));
}

/** Тот же расчёт для заранее известного списка покупок (воронка, карточка). */
export async function completedAmong(
  purchases: { purchaseId: string; contactId: string; courseId: string | null; courseRef: { title: string } | null }[]
): Promise<CompletedCourse[]> {
  const withCourse = purchases.filter((p): p is typeof p & { courseId: string } => Boolean(p.courseId));
  if (withCourse.length === 0) return [];
  const courseIds = [...new Set(withCourse.map((p) => p.courseId))];
  const [lessons, done] = await Promise.all([
    prisma.lesson.findMany({
      where: { status: "READY", deletedAt: null, module: { courseId: { in: courseIds } } },
      select: { id: true, module: { select: { courseId: true } } },
    }),
    prisma.progress.findMany({
      where: { purchaseId: { in: withCourse.map((p) => p.purchaseId) }, completedAt: { not: null } },
      select: { purchaseId: true, lessonId: true, completedAt: true },
    }),
  ]);
  const lessonsByCourse = new Map<string, string[]>();
  for (const l of lessons) {
    const list = lessonsByCourse.get(l.module.courseId) ?? [];
    list.push(l.id);
    lessonsByCourse.set(l.module.courseId, list);
  }
  const doneByPurchase = new Map<string, Map<string, Date>>();
  for (const d of done) {
    if (!d.completedAt) continue;
    const m = doneByPurchase.get(d.purchaseId) ?? new Map<string, Date>();
    m.set(d.lessonId, d.completedAt);
    doneByPurchase.set(d.purchaseId, m);
  }

  const result: CompletedCourse[] = [];
  for (const p of withCourse) {
    const required = lessonsByCourse.get(p.courseId) ?? [];
    const finished = doneByPurchase.get(p.purchaseId);
    if (required.length === 0 || !finished) continue;
    if (!required.every((id) => finished.has(id))) continue;
    const finishedAt = new Date(Math.max(...required.map((id) => finished.get(id)!.getTime())));
    result.push({ purchaseId: p.purchaseId, contactId: p.contactId, courseId: p.courseId, courseTitle: p.courseRef?.title ?? null, finishedAt });
  }
  return result;
}

// ---------- воронка ----------

export type FunnelStep = {
  key: "wrote" | "funnel" | "receipt" | "paid" | "opened" | "finished" | "certificate";
  title: string;
  count: number;
  /** Доля от ПРЕДЫДУЩЕГО шага в процентах; у первого шага и при нуле — null. */
  conversion: number | null;
};

export type FunnelResponse = { days: number; steps: FunnelStep[] };

const STEP_TITLE: Record<FunnelStep["key"], string> = {
  wrote: "написали",
  funnel: "прошли воронку",
  receipt: "прислали чек",
  paid: "оплатили",
  opened: "открыли урок 1",
  finished: "досмотрели всё",
  certificate: "сертификат",
};

/** Проценты между соседними шагами — чистая функция, чтобы тестировать без базы. */
export function withConversions(counts: Record<FunnelStep["key"], number>): FunnelStep[] {
  const order: FunnelStep["key"][] = ["wrote", "funnel", "receipt", "paid", "opened", "finished", "certificate"];
  return order.map((key, i) => {
    const prev = i > 0 ? counts[order[i - 1]] : 0;
    const count = counts[key];
    return {
      key,
      title: STEP_TITLE[key],
      count,
      conversion: i === 0 || prev <= 0 ? null : Math.min(100, Math.round((count / prev) * 100)),
    };
  });
}

/**
 * Каждый шаг — СВОЯ выборка за период (написали — по сообщениям, чек — по
 * ReceiptCheck, оплата — по Purchase...), а не «те же люди, что на прошлом
 * шаге»: человек мог написать в прошлом месяце, а заплатить в этом, и
 * пересечение по датам занизило бы поздние шаги. Проценты — «сколько дошло»
 * в среднем, что владельцу и нужно.
 */
export async function buildFunnel(days: number): Promise<FunnelResponse> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [wrote, funnel, receipts, purchases] = await Promise.all([
    prisma.message.findMany({
      where: { direction: "IN", createdAt: { gte: since }, contact: { personal: false } },
      select: { contactId: true },
      distinct: ["contactId"],
    }),
    prisma.delivery.findMany({ where: { createdAt: { gte: since } }, select: { contactId: true }, distinct: ["contactId"] }),
    prisma.receiptCheck.findMany({ where: { createdAt: { gte: since } }, select: { contactId: true }, distinct: ["contactId"] }),
    prisma.purchase.findMany({
      where: { createdAt: { gte: since }, revokedAt: null },
      select: { id: true, contactId: true, courseId: true, firstOpenedAt: true, courseRef: { select: { title: true } } },
    }),
  ]);

  const finished = await completedAmong(
    purchases.map((p) => ({ purchaseId: p.id, contactId: p.contactId, courseId: p.courseId, courseRef: p.courseRef }))
  );
  const paidContacts = new Set(purchases.map((p) => p.contactId));
  const certificates =
    purchases.length > 0
      ? await prisma.certificate.findMany({
          where: { contactId: { in: [...paidContacts] } },
          select: { contactId: true, courseId: true },
        })
      : [];
  const bought = new Set(purchases.map((p) => `${p.contactId}:${p.courseId ?? ""}`));
  const certified = certificates.filter((c) => bought.has(`${c.contactId}:${c.courseId}`));

  return {
    days,
    steps: withConversions({
      wrote: wrote.length,
      funnel: funnel.length,
      receipt: receipts.length,
      paid: paidContacts.size,
      opened: new Set(purchases.filter((p) => p.firstOpenedAt).map((p) => p.contactId)).size,
      finished: new Set(finished.map((f) => f.contactId)).size,
      certificate: new Set(certified.map((c) => c.contactId)).size,
    }),
  };
}

metricsRouter.get("/admin/metrics/funnel", async (req, res) => {
  res.json(await buildFunnel(daysParam(req.query.days)));
});

// ---------- выручка ----------

export type RevenueBucket = { key: string; title: string; count: number; sum: number };

export type RevenueResponse = {
  days: number;
  total: number;
  count: number;
  byCourse: RevenueBucket[];
  byChannel: RevenueBucket[];
  /** Часы от первого входящего сообщения до первой покупки; null — нечего считать. */
  timeToPay: { medianHours: number | null; averageHours: number | null; sample: number };
};

/** Медиана и среднее по часам — отдельно, чтобы проверить математику без базы. */
export function summarizeHours(hours: number[]): RevenueResponse["timeToPay"] {
  if (hours.length === 0) return { medianHours: null, averageHours: null, sample: 0 };
  const sorted = [...hours].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const average = sorted.reduce((s, h) => s + h, 0) / sorted.length;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { medianHours: round(median), averageHours: round(average), sample: sorted.length };
}

export async function buildRevenue(days: number): Promise<RevenueResponse> {
  const since = new Date(Date.now() - days * 86_400_000);
  const purchases = await prisma.purchase.findMany({
    where: { createdAt: { gte: since }, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      contactId: true,
      course: true,
      amount: true,
      source: true,
      createdAt: true,
      contact: { select: { channel: true } },
      courseRef: { select: { title: true } },
    },
  });

  const byCourse = new Map<string, RevenueBucket>();
  const byChannel = new Map<string, RevenueBucket>();
  const add = (map: Map<string, RevenueBucket>, key: string, title: string, amount: number) => {
    const b = map.get(key) ?? { key, title, count: 0, sum: 0 };
    b.count += 1;
    b.sum += amount;
    map.set(key, b);
  };
  let total = 0;
  const firstPurchaseAt = new Map<string, Date>();
  for (const p of purchases) {
    total += p.amount;
    add(byCourse, p.course, p.courseRef?.title ?? p.course, p.amount);
    const ch = purchaseChannel(p);
    add(byChannel, ch, CHANNEL_TITLE[ch], p.amount);
    if (!firstPurchaseAt.has(p.contactId)) firstPurchaseAt.set(p.contactId, p.createdAt);
  }

  // «Первое сообщение → оплата»: первый входящий у каждого купившего. Prisma
  // отдаёт distinct по первой встреченной строке, поэтому сортировка по дате
  // обязательна — иначе «первым» окажется случайное сообщение.
  const contactIds = [...firstPurchaseAt.keys()];
  const firstMessages =
    contactIds.length > 0
      ? await prisma.message.findMany({
          where: { contactId: { in: contactIds }, direction: "IN" },
          orderBy: { createdAt: "asc" },
          distinct: ["contactId"],
          select: { contactId: true, createdAt: true },
        })
      : [];
  const hours: number[] = [];
  for (const m of firstMessages) {
    const paidAt = firstPurchaseAt.get(m.contactId);
    if (!paidAt) continue;
    const h = (paidAt.getTime() - m.createdAt.getTime()) / 3_600_000;
    // Оплата раньше первого сообщения — доступ выдан руками до переписки; в
    // «срок до оплаты» такой случай ничего не говорит.
    if (h >= 0) hours.push(h);
  }

  const desc = (a: RevenueBucket, b: RevenueBucket) => b.sum - a.sum;
  return {
    days,
    total,
    count: purchases.length,
    byCourse: [...byCourse.values()].sort(desc),
    byChannel: [...byChannel.values()].sort(desc),
    timeToPay: summarizeHours(hours),
  };
}

metricsRouter.get("/admin/metrics/revenue", async (req, res) => {
  res.json(await buildRevenue(daysParam(req.query.days)));
});

// ---------- карточка ученицы ----------

export type StudentResponse = {
  contact: {
    id: string;
    handle: string;
    name: string | null;
    studentName: string | null;
    channel: string;
    instagramUrl: string | null;
    whatsappUrl: string | null;
    paidAt: string | null;
    accessRevokedAt: string | null;
    accessIssuedAt: string | null;
    personal: boolean;
  };
  courses: {
    purchaseId: string;
    code: string;
    title: string;
    amount: number;
    channel: PurchaseChannel;
    boughtAt: string;
    revoked: boolean;
    firstOpenedAt: string | null;
    percent: number;
    lessonsTotal: number;
    lessonsDone: number;
    finishedAt: string | null;
    certificate: { number: number; issuedAt: string } | null;
    lessons: { id: string; title: string; order: number; ready: boolean; done: boolean; percent: number; positionSec: number; durationSec: number | null }[];
  }[];
  devices: { id: string; label: string; city: string | null; lastSeenAt: string; blocked: boolean; blockedReason: string | null }[];
  unansweredQuestions: number;
};

/**
 * «Chrome на Android», «Instagram на iPhone», «Safari на компьютере» —
 * человеческая подпись устройства. Встроенный браузер Instagram/Telegram
 * важнее марки: именно с него «не открывается», и владелец должен это видеть.
 */
export function describeDeviceLong(ua: string | null): string {
  const kind = describeDevice(ua);
  const where = kind === "Компьютер" ? "на компьютере" : kind === "Устройство" ? "" : `на ${kind}`;
  if (!ua) return "Неизвестное устройство";
  const browser = /instagram/i.test(ua)
    ? "Instagram"
    : /telegram/i.test(ua)
      ? "Telegram"
      : /fbav|fban|messenger/i.test(ua)
        ? "Messenger"
        : /yabrowser/i.test(ua)
          ? "Яндекс Браузер"
          : /edg\//i.test(ua)
            ? "Edge"
            : /opr\/|opera/i.test(ua)
              ? "Opera"
              : /samsungbrowser/i.test(ua)
                ? "Samsung Browser"
                : /firefox|fxios/i.test(ua)
                  ? "Firefox"
                  : /chrome|crios/i.test(ua)
                    ? "Chrome"
                    : /safari/i.test(ua)
                      ? "Safari"
                      : "Браузер";
  return where ? `${browser} ${where}` : browser;
}

function instagramUrlOf(c: { channel: string; username: string | null }): string | null {
  return c.username && c.channel === "INSTAGRAM" ? `https://www.instagram.com/${c.username}/` : null;
}

/** Ссылка WhatsApp по номеру, если он известен (запись на офлайн-курс). */
export function whatsappUrl(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  // Местные номера пишут как 90 123 45 67 — без кода страны; WhatsApp хочет 992.
  const full = digits.length === 9 ? `992${digits}` : digits;
  return `https://wa.me/${full}`;
}

export async function buildStudent(contactId: string): Promise<StudentResponse | null> {
  const c = await prisma.contact.findUnique({
    where: { id: contactId },
    include: {
      purchases: {
        orderBy: { createdAt: "asc" },
        include: {
          courseRef: {
            select: {
              id: true,
              code: true,
              title: true,
              modules: { orderBy: { order: "asc" }, select: { order: true, lessons: { where: { deletedAt: null }, orderBy: { order: "asc" }, select: { id: true, title: true, order: true, status: true, durationSec: true } } } },
            },
          },
          progress: { select: { lessonId: true, percent: true, positionSec: true, completedAt: true } },
        },
      },
      devices: { orderBy: { lastSeenAt: "desc" } },
      certificates: { select: { courseId: true, number: true, issuedAt: true } },
      offlineSignup: { select: { phone: true } },
    },
  });
  if (!c) return null;

  const unanswered =
    c.purchases.length > 0
      ? await prisma.courseChatMessage.count({
          where: { purchaseId: { in: c.purchases.map((p) => p.id) }, fromStudent: true, readByOwnerAt: null },
        })
      : 0;
  const certByCourse = new Map(c.certificates.map((x) => [x.courseId, x]));

  return {
    contact: {
      id: c.id,
      handle: c.username ? `@${c.username}` : c.igUserId.length > 8 ? `ID ···${c.igUserId.slice(-6)}` : `ID ${c.igUserId}`,
      name: c.name,
      studentName: [c.studentFirstName, c.studentLastName].filter(Boolean).join(" ") || null,
      channel: c.channel,
      instagramUrl: instagramUrlOf(c),
      whatsappUrl: whatsappUrl(c.offlineSignup?.phone),
      paidAt: c.paidAt?.toISOString() ?? null,
      accessRevokedAt: c.accessRevokedAt?.toISOString() ?? null,
      accessIssuedAt: c.accessIssuedAt?.toISOString() ?? null,
      personal: c.personal,
    },
    courses: c.purchases.map((p) => {
      const lessons = (p.courseRef?.modules ?? []).flatMap((m) => m.lessons);
      const progress = new Map(p.progress.map((x) => [x.lessonId, x]));
      const ready = lessons.filter((l) => l.status === "READY");
      const doneReady = ready.filter((l) => progress.get(l.id)?.completedAt);
      const finishedAt =
        ready.length > 0 && doneReady.length === ready.length
          ? new Date(Math.max(...doneReady.map((l) => progress.get(l.id)!.completedAt!.getTime())))
          : null;
      const cert = p.courseId ? certByCourse.get(p.courseId) : undefined;
      return {
        purchaseId: p.id,
        code: p.courseRef?.code ?? p.course,
        title: p.courseRef?.title ?? p.course,
        amount: p.amount,
        channel: purchaseChannel({ source: p.source, contact: c }),
        boughtAt: p.createdAt.toISOString(),
        revoked: Boolean(p.revokedAt),
        firstOpenedAt: p.firstOpenedAt?.toISOString() ?? null,
        percent: ready.length > 0 ? Math.round((doneReady.length / ready.length) * 100) : 0,
        lessonsTotal: ready.length,
        lessonsDone: doneReady.length,
        finishedAt: finishedAt?.toISOString() ?? null,
        certificate: cert ? { number: cert.number, issuedAt: cert.issuedAt.toISOString() } : null,
        lessons: lessons.map((l) => {
          const pr = progress.get(l.id);
          return {
            id: l.id,
            title: l.title,
            order: l.order,
            ready: l.status === "READY",
            done: Boolean(pr?.completedAt),
            percent: pr?.percent ?? 0,
            positionSec: pr?.positionSec ?? 0,
            durationSec: l.durationSec,
          };
        }),
      };
    }),
    devices: c.devices.map((d) => ({
      id: d.id,
      label: describeDeviceLong(d.userAgent),
      city: d.lastCity,
      lastSeenAt: d.lastSeenAt.toISOString(),
      blocked: Boolean(d.blockedAt),
      blockedReason: d.blockedReason,
    })),
    unansweredQuestions: unanswered,
  };
}

metricsRouter.get("/admin/metrics/student/:contactId", async (req, res) => {
  const student = await buildStudent(req.params.contactId);
  if (!student) {
    res.status(404).json({ error: "Ученица не найдена" });
    return;
  }
  res.json(student);
});

/**
 * НОВАЯ ССЫЛКА ИЗ ПАНЕЛИ — то же, что команда /ссылка в Telegram
 * (course/manualLink.ts): issueCourseLink выпускает свежую ссылку, прошлая
 * с этой минуты не работает. Только для действующих покупок: отозванный
 * доступ так не оживить — для этого есть «Вернуть доступ».
 */
metricsRouter.post("/admin/metrics/student/:contactId/link", async (req, res) => {
  const active = await prisma.purchase.count({ where: { contactId: req.params.contactId, revokedAt: null } });
  if (active === 0) {
    res.status(409).json({ error: "У неё нет действующего курса — ссылку выдавать не за что" });
    return;
  }
  const url = await issueCourseLink(req.params.contactId);
  if (!url) {
    res.status(409).json({ error: "Адрес платформы не задан в настройках — ссылку собрать не из чего" });
    return;
  }
  res.json({ url });
});
