import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const issueCourseLink = vi.fn(async () => "https://school.tj/course?t=new");
vi.mock("../../src/course/delivery.js", () => ({ issueCourseLink: (...a: unknown[]) => issueCourseLink(...a) }));

import {
  metricsRouter,
  withConversions,
  summarizeHours,
  describeDeviceLong,
  whatsappUrl,
  purchaseChannel,
  buildFunnel,
  buildRevenue,
  buildStudent,
  completedCoursesSince,
  type StudentResponse,
} from "../../src/metrics.js";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(metricsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const H = 3_600_000;
const DAY = 24 * H;

describe("metrics: чистая математика", () => {
  it("withConversions — процент от предыдущего шага, у первого null, деление на ноль → null", () => {
    const steps = withConversions({ wrote: 100, funnel: 40, receipt: 10, paid: 8, opened: 6, finished: 2, certificate: 0 });
    expect(steps.map((s) => s.conversion)).toEqual([null, 40, 25, 80, 75, 33, 0]);
    expect(steps[0].title).toBe("написали");
    const empty = withConversions({ wrote: 0, funnel: 0, receipt: 3, paid: 0, opened: 0, finished: 0, certificate: 0 });
    expect(empty[2].conversion).toBeNull(); // 3 из 0 — не 100%
  });

  it("summarizeHours — медиана чётного/нечётного ряда, среднее, пустой ряд", () => {
    expect(summarizeHours([])).toEqual({ medianHours: null, averageHours: null, sample: 0 });
    expect(summarizeHours([1, 100, 3])).toEqual({ medianHours: 3, averageHours: 34.7, sample: 3 });
    expect(summarizeHours([2, 4])).toEqual({ medianHours: 3, averageHours: 3, sample: 2 });
  });

  it("describeDeviceLong — встроенный браузер важнее марки", () => {
    expect(describeDeviceLong("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Instagram 300.0")).toBe("Instagram на iPhone");
    expect(describeDeviceLong("Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36")).toBe("Chrome на Android");
    expect(describeDeviceLong("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36")).toBe("Chrome на компьютере");
    expect(describeDeviceLong("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Version/17 Safari/605")).toBe("Safari на компьютере");
    expect(describeDeviceLong(null)).toBe("Неизвестное устройство");
  });

  it("whatsappUrl — местный номер получает код 992, короткий мусор → null", () => {
    expect(whatsappUrl("90 123 45 67")).toBe("https://wa.me/992901234567");
    expect(whatsappUrl("+992 90 123 45 67")).toBe("https://wa.me/992901234567");
    expect(whatsappUrl("123")).toBeNull();
    expect(whatsappUrl(null)).toBeNull();
  });

  it("purchaseChannel — MANUAL из source, иначе канал контакта, неизвестный → Instagram", () => {
    expect(purchaseChannel({ source: "MANUAL", contact: { channel: "WEB" } })).toBe("MANUAL");
    expect(purchaseChannel({ source: "RECEIPT", contact: { channel: "WEB" } })).toBe("WEB");
    expect(purchaseChannel({ source: "RECEIPT", contact: { channel: "MESSENGER" } })).toBe("MESSENGER");
    expect(purchaseChannel({ source: "RECEIPT", contact: { channel: null } })).toBe("INSTAGRAM");
  });
});

describe("metrics: воронка и выручка на моке базы", () => {
  let db: PrismaMock;
  const now = new Date("2026-09-05T05:00:00Z");
  beforeEach(() => {
    db = mockPrisma();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    issueCourseLink.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    restorePrisma();
  });

  it("buildFunnel: 7 шагов, «досмотрели» — только если закрыты ВСЕ READY-уроки курса", async () => {
    db.model("message").findMany.mockResolvedValue([{ contactId: "a" }, { contactId: "b" }, { contactId: "c" }, { contactId: "d" }]);
    db.model("delivery").findMany.mockResolvedValue([{ contactId: "a" }, { contactId: "b" }]);
    db.model("receiptCheck").findMany.mockResolvedValue([{ contactId: "a" }, { contactId: "b" }]);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", contactId: "a", courseId: "k1", firstOpenedAt: new Date(), courseRef: { title: "21 рецепт" } },
      { id: "p2", contactId: "b", courseId: "k1", firstOpenedAt: null, courseRef: { title: "21 рецепт" } },
    ]);
    db.model("lesson").findMany.mockResolvedValue([
      { id: "l1", module: { courseId: "k1" } },
      { id: "l2", module: { courseId: "k1" } },
    ]);
    db.model("progress").findMany.mockResolvedValue([
      { purchaseId: "p1", lessonId: "l1", completedAt: new Date(now.getTime() - DAY) },
      { purchaseId: "p1", lessonId: "l2", completedAt: new Date(now.getTime() - H) },
      { purchaseId: "p2", lessonId: "l1", completedAt: new Date() }, // половина — не «досмотрела»
    ]);
    db.model("certificate").findMany.mockResolvedValue([
      { contactId: "a", courseId: "k1" },
      { contactId: "a", courseId: "other" }, // чужой курс — не считается
    ]);

    const f = await buildFunnel(30);
    expect(f.days).toBe(30);
    expect(f.steps.map((s) => [s.key, s.count])).toEqual([
      ["wrote", 4],
      ["funnel", 2],
      ["receipt", 2],
      ["paid", 2],
      ["opened", 1],
      ["finished", 1],
      ["certificate", 1],
    ]);
    expect(f.steps[1].conversion).toBe(50);
    // Период уходит в where каждого шага.
    const where = (db.model("message").findMany.mock.calls[0][0] as { where: { createdAt: { gte: Date } } }).where;
    expect(now.getTime() - where.createdAt.gte.getTime()).toBe(30 * DAY);
  });

  it("buildRevenue: по курсу и каналу, MANUAL отдельно, срок до оплаты по первому входящему", async () => {
    db.model("purchase").findMany.mockResolvedValue([
      { contactId: "a", course: "COURSE70", amount: 70, source: "RECEIPT", createdAt: new Date(now.getTime() - 2 * DAY), contact: { channel: "INSTAGRAM" }, courseRef: { title: "21 рецепт" } },
      { contactId: "a", course: "COURSE50", amount: 50, source: "RECEIPT", createdAt: new Date(now.getTime() - DAY), contact: { channel: "INSTAGRAM" }, courseRef: { title: "Арт-десерты" } },
      { contactId: "b", course: "COURSE70", amount: 70, source: "RECEIPT", createdAt: new Date(now.getTime() - DAY), contact: { channel: "WEB" }, courseRef: null },
      { contactId: "c", course: "COURSE70", amount: 0, source: "MANUAL", createdAt: now, contact: { channel: "INSTAGRAM" }, courseRef: { title: "21 рецепт" } },
    ]);
    db.model("message").findMany.mockResolvedValue([
      { contactId: "a", createdAt: new Date(now.getTime() - 2 * DAY - 10 * H) }, // 10 ч до ПЕРВОЙ покупки
      { contactId: "b", createdAt: new Date(now.getTime() - DAY - 2 * H) }, // 2 ч
      { contactId: "c", createdAt: new Date(now.getTime() + H) }, // оплата раньше сообщения — пропуск
    ]);

    const r = await buildRevenue(7);
    expect(r.total).toBe(190);
    expect(r.count).toBe(4);
    expect(r.byCourse).toEqual([
      { key: "COURSE70", title: "21 рецепт", count: 3, sum: 140 },
      { key: "COURSE50", title: "Арт-десерты", count: 1, sum: 50 },
    ]);
    expect(r.byChannel).toEqual([
      { key: "INSTAGRAM", title: "Instagram", count: 2, sum: 120 },
      { key: "WEB", title: "сайт", count: 1, sum: 70 },
      { key: "MANUAL", title: "вручную", count: 1, sum: 0 },
    ]);
    expect(r.timeToPay).toEqual({ medianHours: 6, averageHours: 6, sample: 2 });
    // Первое сообщение — сортировка по дате + distinct, иначе «первым» был бы случайный.
    const args = db.model("message").findMany.mock.calls[0][0] as { orderBy: unknown; distinct: unknown };
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.distinct).toEqual(["contactId"]);
  });

  it("completedCoursesSince: пусто без свежих завершений — лишних запросов нет", async () => {
    db.model("progress").findMany.mockResolvedValue([]);
    expect(await completedCoursesSince(new Date())).toEqual([]);
    expect(db.model("lesson").findMany).not.toHaveBeenCalled();
  });

  it("GET /admin/metrics/funnel и /revenue — форма ответа и разбор ?days", async () => {
    db.model("message").findMany.mockResolvedValue([]);
    db.model("delivery").findMany.mockResolvedValue([]);
    db.model("receiptCheck").findMany.mockResolvedValue([]);
    db.model("purchase").findMany.mockResolvedValue([]);
    const f = (await (await fetch(`${base}/admin/metrics/funnel?days=90`)).json()) as { days: number; steps: unknown[] };
    expect(f.days).toBe(90);
    expect(f.steps).toHaveLength(7);
    const r = (await (await fetch(`${base}/admin/metrics/revenue?days=abc`)).json()) as { days: number; byChannel: unknown[] };
    expect(r.days).toBe(30);
    expect(r.byChannel).toEqual([]);
  });
});

describe("metrics: карточка ученицы", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    issueCourseLink.mockClear();
  });
  afterEach(restorePrisma);

  const contact = {
    id: "c1",
    igUserId: "ig-1",
    username: "madina",
    channel: "INSTAGRAM",
    name: "Мадина",
    studentFirstName: "Мадина",
    studentLastName: "Р.",
    paidAt: new Date("2026-09-01T10:00:00Z"),
    accessRevokedAt: null,
    accessIssuedAt: new Date("2026-09-01T10:01:00Z"),
    personal: false,
    offlineSignup: { phone: "90 123 45 67" },
    certificates: [{ courseId: "k1", number: 7, issuedAt: new Date("2026-09-04T10:00:00Z") }],
    devices: [
      { id: "d1", userAgent: "Mozilla (Linux; Android 13) Chrome/120 Mobile", lastCity: "Душанбе", lastSeenAt: new Date("2026-09-04T09:00:00Z"), blockedAt: null, blockedReason: null },
      { id: "d2", userAgent: "Mozilla (iPhone) Instagram 300", lastCity: null, lastSeenAt: new Date("2026-09-02T09:00:00Z"), blockedAt: new Date(), blockedReason: "Заблокировано владельцем" },
    ],
    purchases: [
      {
        id: "p1",
        course: "COURSE70",
        amount: 70,
        source: "RECEIPT",
        createdAt: new Date("2026-09-01T10:00:00Z"),
        revokedAt: null,
        firstOpenedAt: new Date("2026-09-01T12:00:00Z"),
        courseId: "k1",
        courseRef: {
          id: "k1",
          code: "COURSE70",
          title: "21 рецепт",
          modules: [
            {
              order: 1,
              lessons: [
                { id: "l1", title: "Урок 1", order: 1, status: "READY", durationSec: 600 },
                { id: "l2", title: "Урок 2", order: 2, status: "READY", durationSec: 900 },
                { id: "l3", title: "Урок 3", order: 3, status: "UPLOADED", durationSec: null },
              ],
            },
          ],
        },
        progress: [
          { lessonId: "l1", percent: 100, positionSec: 600, completedAt: new Date("2026-09-02T10:00:00Z") },
          { lessonId: "l2", percent: 100, positionSec: 900, completedAt: new Date("2026-09-03T10:00:00Z") },
        ],
      },
    ],
  };

  it("buildStudent: кольцо по READY-урокам, устройства с подписью, ссылки «написать»", async () => {
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("courseChatMessage").count.mockResolvedValue(2);

    const s = (await buildStudent("c1")) as StudentResponse;
    expect(s.contact).toMatchObject({
      handle: "@madina",
      studentName: "Мадина Р.",
      instagramUrl: "https://www.instagram.com/madina/",
      whatsappUrl: "https://wa.me/992901234567",
    });
    expect(s.unansweredQuestions).toBe(2);
    expect(s.courses).toHaveLength(1);
    const k = s.courses[0];
    expect(k).toMatchObject({
      title: "21 рецепт",
      channel: "INSTAGRAM",
      percent: 100,
      lessonsTotal: 2, // третий не READY — не в знаменателе
      lessonsDone: 2,
      finishedAt: "2026-09-03T10:00:00.000Z",
      certificate: { number: 7, issuedAt: "2026-09-04T10:00:00.000Z" },
    });
    expect(k.lessons.map((l) => [l.title, l.done, l.ready])).toEqual([
      ["Урок 1", true, true],
      ["Урок 2", true, true],
      ["Урок 3", false, false],
    ]);
    expect(s.devices).toEqual([
      { id: "d1", label: "Chrome на Android", city: "Душанбе", lastSeenAt: "2026-09-04T09:00:00.000Z", blocked: false, blockedReason: null },
      { id: "d2", label: "Instagram на iPhone", city: null, lastSeenAt: "2026-09-02T09:00:00.000Z", blocked: true, blockedReason: "Заблокировано владельцем" },
    ]);
  });

  it("GET /admin/metrics/student/:id — 404 для чужого id", async () => {
    db.model("contact").findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/admin/metrics/student/nope`);
    expect(res.status).toBe(404);
  });

  it("POST .../link — новая ссылка через issueCourseLink; без действующих покупок 409", async () => {
    db.model("purchase").count.mockResolvedValue(1);
    const ok = await fetch(`${base}/admin/metrics/student/c1/link`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ url: "https://school.tj/course?t=new" });
    expect(issueCourseLink).toHaveBeenCalledWith("c1");

    db.model("purchase").count.mockResolvedValue(0);
    const no = await fetch(`${base}/admin/metrics/student/c1/link`, { method: "POST" });
    expect(no.status).toBe(409);
    expect(issueCourseLink).toHaveBeenCalledTimes(1);
  });
});
