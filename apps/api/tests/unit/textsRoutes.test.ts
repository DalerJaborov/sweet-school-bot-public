import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

// site/router.ts тянет ai.ts целиком — модель тесту не нужна.
vi.mock("../../src/ai.js", () => ({
  aiReply: vi.fn(),
  rescueImage: vi.fn(),
  rescueIncomingImages: vi.fn(),
  aiReplyToComment: vi.fn(),
  grantCourses: vi.fn(),
  handleReceiptVerdict: vi.fn(),
}));

import { textsRouter } from "../../src/textsRoutes.js";
import { resetPriceCache } from "../../src/services/priceService.js";
import { resetSalesTextsCache } from "../../src/services/salesTextsService.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(textsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type TextsBody = {
  prices: { course50: number; course70: number; bundle: number };
  texts: Record<string, string>;
  offline: { price: number; days: number; hours: string; desserts: number; address: string; startDate: string; infoRu: string; infoTg: string };
  preview: { priceLine: string; offlineCard: { ru: string; tg: string }; payment: { ru: string }; botRules: string };
  defaults: { prices: { course50: number } };
};

describe("/admin/texts", () => {
  let db: PrismaMock;
  const store: Record<string, string> = {};
  beforeEach(() => {
    db = mockPrisma();
    resetPriceCache();
    resetSalesTextsCache();
    for (const k of Object.keys(store)) delete store[k];
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      store[where.key] ? { key: where.key, value: store[where.key] } : null
    );
    db.model("setting").upsert.mockImplementation(async (args: unknown) => {
      const { where, create } = args as { where: { key: string }; create: { value: string } };
      store[where.key] = create.value;
      return {};
    });
    db.model("course").updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(restorePrisma);

  it("GET — умолчания и предпросмотр, собранный теми же функциями, что читает бот", async () => {
    const body = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    expect(body.prices).toEqual({ course50: 50, course70: 70, bundle: 100 });
    expect(body.texts.paymentPhone).toBe("905 355 355");
    expect(body.offline).toMatchObject({ price: 700, days: 8, desserts: 20, startDate: "", infoRu: "" });
    expect(body.preview.priceLine).toBe("Арт-десерты — 50 сомони, 21 рецепт — 70 сомони, оба курса вместе — 100 сомони");
    expect(body.preview.offlineCard.ru).toContain("Стоимость: 700 сомони");
    expect(body.preview.offlineCard.ru).toContain("уточняется");
    expect(body.preview.botRules).toContain("оба курса вместе — 100 сомони");
    expect(body.defaults.prices.course50).toBe(50);
  });

  it("PUT — пишет Settings, синхронизирует Course.price, отдаёт свежий предпросмотр", async () => {
    const current = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    const next = {
      prices: { course50: 60, course70: 90, bundle: 130 },
      texts: { ...current.texts, paymentPhone: "900 111 222" },
      offline: { ...current.offline, price: 800, desserts: 25, address: "Душанбе, Айни 10", startDate: "2099-10-03" },
    };
    const res = await fetch(`${base}/admin/texts`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TextsBody & { ok: boolean };
    expect(body.ok).toBe(true);
    expect(store).toMatchObject({
      priceCourse50: "60",
      priceCourse70: "90",
      priceBundle: "130",
      paymentPhone: "900 111 222",
      offlineCoursePrice: "800",
      offlineCourseDesserts: "25",
      offlineCourseAddress: "Душанбе, Айни 10",
      offlineCourseStartDate: "2099-10-03",
    });
    expect(db.model("course").updateMany).toHaveBeenCalledWith({ where: { code: "COURSE50" }, data: { price: 60 } });
    expect(body.prices).toEqual({ course50: 60, course70: 90, bundle: 130 });
    expect(body.preview.priceLine).toContain("оба курса вместе — 130 сомони");
    expect(body.preview.payment.ru).toContain("900 111 222");
    expect(body.preview.offlineCard.ru).toContain("Стоимость: 800 сомони");
    expect(body.preview.offlineCard.ru).toContain("25 видов");
    expect(body.preview.offlineCard.ru).toContain("Начало: 3 октября");
    expect(body.preview.offlineCard.tg).toContain("Айни 10");
  });

  it("preview — из черновика, ничего не пишет; невалидное тело — 400", async () => {
    const current = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    const draft = { ...current, prices: { course50: 10, course70: 20, bundle: 25 }, offline: { ...current.offline, infoRu: "Свой текст карточки" } };
    const res = await fetch(`${base}/admin/texts/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
    const preview = (await res.json()) as TextsBody["preview"];
    expect(preview.priceLine).toContain("Арт-десерты — 10 сомони");
    expect(preview.offlineCard.ru).toBe("Свой текст карточки");
    expect(db.model("setting").upsert).not.toHaveBeenCalled();

    const bad = await fetch(`${base}/admin/texts/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prices: { course50: -1 } }) });
    expect(bad.status).toBe(400);
  });
});
