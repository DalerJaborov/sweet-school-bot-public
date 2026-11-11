import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/instagram.js", () => ({ sendText: vi.fn(), channelOf: () => "INSTAGRAM" }));

import { offerRouter } from "../../src/offerRoutes.js";
import { onOfferSaved, type Offer } from "../../src/services/offerService.js";
import { resetPriceCache } from "../../src/services/priceService.js";
import { getSalesTexts, resetSalesTextsCache } from "../../src/services/salesTextsService.js";
import { offlineCourseCard, offlineFactsForModel } from "../../src/ai/offlineCourse.js";
import { courseDateLabel } from "../../src/ai/courseDate.js";
import { renderFunnelText } from "../../src/funnelPlaceholders.js";
import { writeSettings } from "../../src/services/settingsService.js";
import { adminTokenSecret } from "../../src/adminLogin.js";

let server: Server;
let base = "";
const catalogReset = vi.fn();
onOfferSaved(() => catalogReset());

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(offerRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Snapshot = {
  offer: Offer;
  defaults: Offer;
  today: string;
  warnings: string[];
  preview: Record<"course50" | "course70" | "bundle", { ru: string; tg: string }> & {
    offline: { ru: string; tg: string; source: string };
  };
  history: { field: string; before: string; after: string; actor: string }[];
  version: string;
};

const FUTURE = "2099-12-01";
const PAST = "2020-01-10";

describe("/admin/v1/offer — «Цены и даты»", () => {
  let db: PrismaMock;
  const store: Record<string, string> = {};
  const journal: { field: string; before: string; after: string; actor: string; createdAt: Date }[] = [];

  beforeEach(() => {
    db = mockPrisma();
    resetPriceCache();
    resetSalesTextsCache();
    catalogReset.mockClear();
    for (const k of Object.keys(store)) delete store[k];
    journal.length = 0;
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      store[where.key] !== undefined ? { key: where.key, value: store[where.key] } : null,
    );
    db.model("setting").upsert.mockImplementation(async (args: unknown) => {
      const { where, create } = args as { where: { key: string }; create: { value: string } };
      store[where.key] = create.value;
      return {};
    });
    db.model("setting").findMany.mockImplementation(async ({ where }: { where: { key: { in: string[] } } }) =>
      where.key.in.filter((k) => store[k] !== undefined).map((key) => ({ key, value: store[key] })),
    );
    db.model("course").updateMany.mockResolvedValue({ count: 1 });
    db.model("offerChange").create.mockImplementation(
      async ({ data }: { data: { field: string; before: string; after: string; actor: string } }) => {
        journal.unshift({ ...data, createdAt: new Date() });
        return data;
      },
    );
    db.model("offerChange").findMany.mockImplementation(async () => journal);
  });
  afterEach(restorePrisma);

  const get = async () => (await (await fetch(`${base}/admin/v1/offer`)).json()) as Snapshot;
  /** Сохранение с версией, как у экрана; без явной версии берём текущую. */
  const put = async (offer: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const version = "version" in extra ? extra.version : (await get()).version;
    return fetch(`${base}/admin/v1/offer`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ offer, ...extra, version }),
    });
  };

  it("GET — подтверждённые умолчания, даты нет и не придумана, бот говорит «уточняется»", async () => {
    const s = await get();
    expect(s.offer.prices).toEqual({ course50: 50, course70: 70, bundle: 100 });
    expect(s.offer.offline).toMatchObject({
      price: 700,
      startDate: "",
      timeFrom: "13:40",
      timeTo: "16:30",
      desserts: 22,
      seats: null,
    });
    expect(s.warnings.join(" ")).toMatch(/дата уточняется/);
    expect(s.preview.course50).toEqual({ ru: "Арт-десерты — 50 сомони", tg: "Арт-десертҳо — 50 сомонӣ" });
    expect(s.preview.bundle.ru).toBe("оба курса вместе — 100 сомони");
    expect(s.preview.offline.ru).toContain("Дата следующего курса пока уточняется");
    expect(s.preview.offline.tg).toContain("хануз маълум нест");
    expect(s.preview.offline.source).toBe("fields");
  });

  it("PUT — пишет, журналит «кто/было→стало», сбрасывает кэш сайта, и БОТ сразу говорит новое", async () => {
    const s = await get();
    const next = {
      ...s.offer,
      prices: { ...s.offer.prices, course50: 55 },
      offline: { ...s.offer.offline, startDate: FUTURE, timeFrom: "10:00", seats: 8 },
    };
    const res = await put(next);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Snapshot & { changes: number };
    expect(body.changes).toBe(4);
    expect(store).toMatchObject({
      priceCourse50: "55",
      offlineCourseStartDate: FUTURE,
      offlineCourseHours: "10:00–16:30",
      offlineCourseSeats: "8",
    });
    expect(db.model("course").updateMany).toHaveBeenCalledWith({ where: { code: "COURSE50" }, data: { price: 55 } });
    expect(journal.find((j) => j.field === "prices.course50")).toMatchObject({
      before: "50",
      after: "55",
      actor: "админ панели",
    });
    expect(journal.find((j) => j.field === "offline.startDate")).toMatchObject({ before: "", after: FUTURE });
    expect(catalogReset).toHaveBeenCalled();

    // Подхват ботом — те же функции, что работают в бою, без ожидания кэша.
    expect((await getSalesTexts()).priceLineRu).toContain("Арт-десерты — 55 сомони");
    const card = await offlineCourseCard("ru");
    expect(card).toContain("Следующий курс начинается 1 декабря");
    expect(card).toContain("каждый день с 10:00 до 16:30");
    expect(card).toContain("В группе всего 8 мест");
    expect(await offlineCourseCard("tg")).toContain("Курси ояндамон 1 декабр сар мешавад");
    expect(await courseDateLabel("ru")).toBe("1 декабря");
    expect(await offlineFactsForModel()).toContain("начало 1 декабря");
    expect(await renderFunnelText("Старт {дата}, в {время}")).toBe("Старт 1 декабря, в 10:00–16:30");
    expect(body.preview.course50.ru).toBe("Арт-десерты — 55 сомони");
  });

  it("кто сохранил: Telegram-вход и Access попадают в журнал", async () => {
    const s = await get();
    const token = jwt.sign({ role: "admin", via: "telegram", tgId: 777 }, adminTokenSecret());
    await put(
      { ...s.offer, offline: { ...s.offer.offline, address: "Душанбе, Айни 10" } },
      {},
      { authorization: `Bearer ${token}` },
    );
    expect(journal[0]).toMatchObject({ field: "offline.address", actor: "Telegram 777" });
    // Вход по паролю (Access не настроен): чужой заголовок Access в журнал не попадает.
    const access = jwt.sign({ email: "owner@example.com" }, "x");
    await put(
      { ...s.offer, offline: { ...s.offer.offline, address: "Душанбе, Айни 12" } },
      {},
      { "cf-access-jwt-assertion": access },
    );
    expect(journal[0]).toMatchObject({ field: "offline.address", actor: "админ панели" });
    // Неподписанный «телеграм»-токен тоже не принимается за имя.
    const forged = jwt.sign({ role: "admin", via: "telegram", tgId: 1 }, "not-the-secret");
    await put({ ...s.offer, offline: { ...s.offer.offline, address: "Душанбе, Айни 14" } }, {}, { authorization: `Bearer ${forged}` });
    expect(journal[0].actor).toBe("админ панели");
  });

  it.each([
    ["пустая цена", (o: Offer) => ({ ...o, prices: { ...o.prices, course50: null } }), "prices.course50"],
    ["ноль", (o: Offer) => ({ ...o, offline: { ...o.offline, price: 0 } }), "offline.price"],
    ["время не ЧЧ:ММ", (o: Offer) => ({ ...o, offline: { ...o.offline, timeFrom: "25:00" } }), "offline.timeFrom"],
    ["конец раньше начала", (o: Offer) => ({ ...o, offline: { ...o.offline, timeFrom: "17:00" } }), "offline.timeTo"],
    ["новая дата в прошлом", (o: Offer) => ({ ...o, offline: { ...o.offline, startDate: PAST } }), "offline.startDate"],
    [
      "несуществующая дата",
      (o: Offer) => ({ ...o, offline: { ...o.offline, startDate: "2099-02-31" } }),
      "offline.startDate",
    ],
    ["комплект дороже двух курсов", (o: Offer) => ({ ...o, prices: { ...o.prices, bundle: 125 } }), "prices.bundle"],
    ["комплект дешевле дорогого курса", (o: Offer) => ({ ...o, prices: { ...o.prices, bundle: 69 } }), "prices.bundle"],
    // Деньги: 72 − 6 = 66 ≤ 70 — оплату «21 рецепт» бот принял бы за комплект.
    ["50/70/72: комплект в допуске дорогого курса", (o: Offer) => ({ ...o, prices: { course50: 50, course70: 70, bundle: 72 } }), "prices.bundle"],
    ["курсы почти одной цены (60/70)", (o: Offer) => ({ ...o, prices: { course50: 60, course70: 70, bundle: 100 } }), "prices.course70"],
  ])("400: %s — ничего не записано", async (_name, mutate, field) => {
    const s = await get();
    const res = await put(mutate(s.offer));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields[field]).toBeTruthy();
    expect(db.model("setting").upsert).not.toHaveBeenCalled();
    expect(journal).toHaveLength(0);
  });

  it("цена меняется больше чем на 30 % — 409 «Точно?», с confirm — сохраняется", async () => {
    const s = await get();
    const next = { ...s.offer, prices: { ...s.offer.prices, course70: 7 } };
    // 7 вместо 70 — классическая опечатка; заодно комплект должен остаться валидным.
    const typo = await put({ ...next, prices: { course50: 50, course70: 7, bundle: 57 } });
    expect(typo.status).toBe(409);
    const body = (await typo.json()) as { confirm: { field: string; percent: number }[] };
    expect(body.confirm.map((c) => c.field)).toEqual(["prices.course70", "prices.bundle"]);
    expect(body.confirm[0].percent).toBe(-90);
    expect(db.model("setting").upsert).not.toHaveBeenCalled();

    const ok = await put({ ...next, prices: { course50: 50, course70: 95, bundle: 120 } }, { confirm: true });
    expect(ok.status).toBe(200);
    expect(store.priceCourse70).toBe("95");
  });

  it("набор уже прошёл и дату не трогали — сохранить другое можно, с предупреждением; бот говорит «уточняется»", async () => {
    store.offlineCourseStartDate = PAST;
    const s = await get();
    expect(s.offer.offline.startDate).toBe(PAST);
    expect(s.warnings.join(" ")).toMatch(/Набор в прошлом — клиентам скажем, что дата уточняется/);
    expect(s.preview.offline.ru).toContain("уточняется");
    const res = await put({ ...s.offer, offline: { ...s.offer.offline, price: 750 } });
    expect(res.status).toBe(200);
    expect(await courseDateLabel("ru")).toBe("дата следующего набора уточняется");
  });

  it("две вкладки: сохранение по устаревшей версии — 409 «обновите страницу», ничего не записано", async () => {
    const tabA = await get();
    const tabB = await get();
    expect((await put({ ...tabA.offer, offline: { ...tabA.offer.offline, price: 750 } }, { version: tabA.version })).status).toBe(200);
    const res = await put({ ...tabB.offer, prices: { ...tabB.offer.prices, course50: 55 } }, { version: tabB.version });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stale: true, error: expect.stringMatching(/обновите страницу/) });
    expect(store.priceCourse50).toBe("50");
    expect(store.offlineCoursePrice).toBe("750");
    expect((await put(tabB.offer, { version: "" })).status).toBe(409);
  });

  it("Course.price (витрина) выравнивается при каждом сохранении, даже если цены не менялись", async () => {
    const s = await get();
    await put({ ...s.offer, offline: { ...s.offer.offline, address: "Душанбе, Айни 10" } });
    expect(db.model("course").updateMany).toHaveBeenCalledWith({ where: { code: "COURSE70" }, data: { price: 70 } });
  });

  it("набор дальше полугода — предупреждение «проверьте год»", async () => {
    const s = await get();
    const res = await fetch(`${base}/admin/v1/offer/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: { ...s.offer, offline: { ...s.offer.offline, startDate: FUTURE } } }),
    });
    const body = (await res.json()) as { check: { warnings: string[] } };
    expect(body.check.warnings.join(" ")).toMatch(/больше чем через полгода.*проверьте год/);
  });

  it("свой текст карточки важнее полей — предпросмотр показывает его и помечает", async () => {
    store.offlineCourseInfo = "Свой текст";
    const s = await get();
    expect(s.preview.offline).toMatchObject({ ru: "Свой текст", source: "custom" });
  });

  it("старые часы текстом «14:00 до 17:00» понимаются; нераспознанные — предупреждение", async () => {
    store.offlineCourseHours = "14:00 до 17:00";
    expect((await get()).offer.offline).toMatchObject({ timeFrom: "14:00", timeTo: "17:00" });
    store.offlineCourseHours = "после обеда";
    const s = await get();
    expect(s.offer.offline.timeFrom).toBe("");
    expect(s.warnings.join(" ")).toMatch(/«после обеда»/);
  });

  it("preview — из черновика, ничего не пишет и возвращает проверку", async () => {
    const s = await get();
    const res = await fetch(`${base}/admin/v1/offer/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: { ...s.offer, prices: { course50: 50, course70: 70, bundle: 110 } } }),
    });
    const body = (await res.json()) as { preview: Snapshot["preview"]; check: { errors: Record<string, string> } };
    expect(body.preview.bundle.tg).toBe("ҳар ду курс якҷоя — 110 сомонӣ");
    expect(body.check.errors).toEqual({});
    expect(db.model("setting").upsert).not.toHaveBeenCalled();
  });

  it("общий путь настроек цены и даты не пишет — дверь одна", async () => {
    const written = await writeSettings({ priceCourse50: "1", offlineCourseStartDate: PAST, sitePhone: "+992000" });
    expect(written).toBe(1);
    expect(store).toEqual({ sitePhone: "+992000" });
  });
});
