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
  texts: Record<string, string>;
  offline: { infoRu: string; infoTg: string };
  preview: { priceLine: string; offlineCard: { ru: string; tg: string }; payment: { ru: string }; botRules: string };
};

const put = (body: unknown) =>
  fetch(`${base}/admin/texts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("/admin/texts — только тексты; цены и даты живут в «Цены и даты»", () => {
  let db: PrismaMock;
  const store: Record<string, string> = {};
  beforeEach(() => {
    db = mockPrisma();
    resetPriceCache();
    resetSalesTextsCache();
    for (const k of Object.keys(store)) delete store[k];
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      store[where.key] ? { key: where.key, value: store[where.key] } : null,
    );
    db.model("setting").upsert.mockImplementation(async (args: unknown) => {
      const { where, create } = args as { where: { key: string }; create: { value: string } };
      store[where.key] = create.value;
      return {};
    });
  });
  afterEach(restorePrisma);

  it("GET — тексты и предпросмотр с текущими ценами, собранный теми же функциями, что читает бот", async () => {
    const body = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody & { prices?: unknown };
    expect(body.texts.paymentPhone).toBe("905 355 355");
    expect(body.offline).toEqual({ infoRu: "", infoTg: "" });
    expect(body.prices).toBeUndefined();
    expect(body.preview.priceLine).toBe(
      "Арт-десерты — 50 сомони, 21 рецепт — 70 сомони, оба курса вместе — 100 сомони",
    );
    expect(body.preview.offlineCard.ru).toContain("Стоимость 700 сомони");
    expect(body.preview.offlineCard.ru).toContain("уточняется");
    expect(body.preview.botRules).toContain("оба курса вместе — 100 сомони");
  });

  it("PUT — пишет тексты и свою карточку; ключи цен и дат не трогает", async () => {
    const current = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    const res = await put({
      texts: { ...current.texts, paymentPhone: "900 111 222" },
      offline: { infoRu: "Свой текст", infoTg: "" },
    });
    expect(res.status).toBe(200);
    expect(store).toMatchObject({ paymentPhone: "900 111 222", offlineCourseInfo: "Свой текст" });
    expect(
      Object.keys(store).some((k) =>
        /^price|offlineCourse(Price|StartDate|Hours|Address|Days|Desserts|Seats)$/.test(k),
      ),
    ).toBe(false);
    const body = (await res.json()) as TextsBody;
    expect(body.preview.payment.ru).toContain("900 111 222");
    expect(body.preview.offlineCard.ru).toBe("Свой текст");
  });

  it("старая панель прислала другую цену — 409 с подсказкой, ничего не записано", async () => {
    const current = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    const res = await put({
      texts: current.texts,
      prices: { course50: 60, course70: 70, bundle: 100 },
      offline: { infoRu: "", infoTg: "", price: 700, startDate: "", address: "Душанбе, ориентир Воданасос, Рудаки 177" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Цены и даты.*Арт-десерты/);
    expect(db.model("setting").upsert).not.toHaveBeenCalled();
  });

  it("старая панель прислала те же цены — молча сохраняем тексты", async () => {
    const current = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    const res = await put({
      texts: current.texts,
      prices: { course50: 50, course70: 70, bundle: 100 },
      offline: { infoRu: "", infoTg: "", price: 700 },
    });
    expect(res.status).toBe(200);
  });

  it("preview — из черновика, ничего не пишет; невалидное тело — 400", async () => {
    const current = (await (await fetch(`${base}/admin/texts`)).json()) as TextsBody;
    const draft = { texts: current.texts, offline: { infoRu: "Свой текст карточки", infoTg: "" } };
    const res = await fetch(`${base}/admin/texts/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const preview = (await res.json()) as TextsBody["preview"];
    expect(preview.offlineCard.ru).toBe("Свой текст карточки");
    expect(db.model("setting").upsert).not.toHaveBeenCalled();

    const bad = await fetch(`${base}/admin/texts/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: {} }),
    });
    expect(bad.status).toBe(400);
  });
});
