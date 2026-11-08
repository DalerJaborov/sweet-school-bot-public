import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: async () => 10 }));
import {
  buildPurchaseEvent, enqueuePurchaseConversion, purchaseEventId, referralFromMeta, recordAdReferral,
  runMetaConversions, type ConversionSettings,
} from "../../src/metaConversions.js";

const S: ConversionSettings = {
  enabled: true, datasetId: "DS1", token: "tok", testEventCode: "", igAccountId: "IG1", pageId: "PAGE1", wabaId: "",
};
const row = { eventId: "purchase:a", createdAt: new Date("2026-11-08T10:00:00Z"), channel: "INSTAGRAM" };
const igContact = { igUserId: "IGSID-9", name: null, adCtwaClid: null };

describe("кодирование события Purchase", () => {
  it("Instagram: ig_sid + id аккаунта, деньги в USD, event_id для защиты от дублей", () => {
    const built = buildPurchaseEvent(row, igContact, 7, S);
    expect(built.ok).toBe(true);
    const ev = (built as { body: { data: Record<string, unknown>[] } }).body.data[0];
    expect(ev).toEqual({
      event_name: "Purchase", event_time: Date.parse("2026-11-08T10:00:00Z") / 1000, event_id: "purchase:a",
      action_source: "business_messaging", messaging_channel: "instagram",
      user_data: { instagram_business_account_id: "IG1", ig_sid: "IGSID-9" },
      custom_data: { currency: "USD", value: 7 },
    });
    expect((built as { body: Record<string, unknown> }).body).not.toHaveProperty("test_event_code");
  });

  it("проверочный код уходит в тело — событие видно только в «Тестовых событиях»", () => {
    const built = buildPurchaseEvent(row, igContact, 7, { ...S, testEventCode: "TEST123" });
    expect((built as { body: Record<string, unknown> }).body.test_event_code).toBe("TEST123");
  });

  it("Messenger: page_id + page_scoped_user_id", () => {
    const built = buildPurchaseEvent({ ...row, channel: "MESSENGER" }, { ...igContact, igUserId: "PSID-1" }, 5, S);
    const ev = (built as { body: { data: Record<string, unknown>[] } }).body.data[0];
    expect(ev.messaging_channel).toBe("messenger");
    expect(ev.user_data).toEqual({ page_id: "PAGE1", page_scoped_user_id: "PSID-1" });
  });

  it("WhatsApp без официального API (нет WABA) — пропуск с понятной причиной, а не ошибка", () => {
    const built = buildPurchaseEvent({ ...row, channel: "WHATSAPP" }, { igUserId: "acc:992900000000@c.us", name: null, adCtwaClid: "clid" }, 5, S);
    expect(built).toEqual({ ok: false, skip: expect.stringContaining("WABA") });
  });

  it("WhatsApp с WABA: ctwa_clid, а без него — хеш телефона + страница", () => {
    const withClid = buildPurchaseEvent({ ...row, channel: "WHATSAPP" }, { igUserId: "acc:992900000000@c.us", name: null, adCtwaClid: "CL1" }, 5, { ...S, wabaId: "W1" });
    expect((withClid as { body: { data: { user_data: unknown }[] } }).body.data[0].user_data).toEqual({ whatsapp_business_account_id: "W1", ctwa_clid: "CL1" });
    const noClid = buildPurchaseEvent({ ...row, channel: "WHATSAPP" }, { igUserId: "acc:992900000000@c.us", name: null, adCtwaClid: null }, 5, { ...S, wabaId: "W1" });
    expect((noClid as { body: { data: { user_data: unknown }[] } }).body.data[0].user_data).toEqual({
      page_id: "PAGE1", whatsapp_business_account_id: "W1",
      ph: [createHash("sha256").update("992900000000").digest("hex")],
    });
  });

  it("сайт и ручная запись — не переписка, не отправляем", () => {
    expect(buildPurchaseEvent({ ...row, channel: "WEB" }, igContact, 5, S).ok).toBe(false);
    expect(buildPurchaseEvent({ ...row, channel: "MANUAL" }, igContact, 5, S).ok).toBe(false);
  });

  it("referral Meta: id объявления берётся, пустой referral игнорируется", () => {
    expect(referralFromMeta({ source: "ADS", type: "OPEN_THREAD", ad_id: "123" })).toEqual({ adId: "123", source: "ADS" });
    expect(referralFromMeta({ source: "SHORTLINK", ref: "x" })).toBeNull();
    expect(referralFromMeta(undefined)).toBeNull();
  });
});

describe("одна оплата = одно событие", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("setting").findUnique.mockImplementation(async (a) =>
      ((a as { where: { key: string } }).where.key === "metaCapiEnabled" ? { value: "true" } : null));
    db.model("contact").findUnique.mockResolvedValue({ channel: "INSTAGRAM" });
  });
  afterEach(restorePrisma);

  it("eventId не зависит от порядка покупок", () => {
    expect(purchaseEventId(["b", "a"])).toBe(purchaseEventId(["a", "b"]));
  });

  it("повторная постановка той же оплаты — upsert по eventId без изменений", async () => {
    db.model("purchase").findMany.mockResolvedValue([{ id: "p1", amount: 30 }, { id: "p2", amount: 40 }]);
    await enqueuePurchaseConversion("c1", ["p2", "p1"]);
    await enqueuePurchaseConversion("c1", ["p1", "p2"]);
    const calls = db.model("metaConversion").upsert.mock.calls.map((c) => c[0] as { where: { eventId: string }; update: object; create: { valueTjs: number } });
    expect(calls).toHaveLength(2);
    expect(calls[0].where.eventId).toBe(calls[1].where.eventId);
    expect(calls[0].update).toEqual({});
    expect(calls[0].create.valueTjs).toBe(70);
  });

  it("рубильник выключен — в очередь ничего", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);
    await enqueuePurchaseConversion("c1", ["p1"]);
    expect(db.model("metaConversion").upsert).not.toHaveBeenCalled();
  });

  it("откаченные или отозванные покупки — не покупка", async () => {
    db.model("purchase").findMany.mockResolvedValue([]);
    await enqueuePurchaseConversion("c1", ["gone"]);
    expect(db.model("metaConversion").upsert).not.toHaveBeenCalled();
  });

  it("сбой базы не ломает выдачу доступа", async () => {
    db.model("purchase").findMany.mockRejectedValue(new Error("db down"));
    await expect(enqueuePurchaseConversion("c1", ["p1"])).resolves.toBeUndefined();
  });

  it("первое касание рекламы не перезаписывается", async () => {
    await recordAdReferral("c1", { adId: "AD1", source: "ADS" });
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", adReferralAt: null } }));
  });
});

describe("разносчик очереди", () => {
  let db: PrismaMock;
  const fetchMock = vi.fn();
  const now = new Date("2026-11-08T12:00:00Z");
  const pending = { id: "m1", eventId: "purchase:p1", createdAt: new Date("2026-11-08T11:00:00Z"), channel: "INSTAGRAM", valueTjs: 70, attempts: 0, contact: igContact };
  beforeEach(() => {
    db = mockPrisma();
    db.model("setting").findUnique.mockImplementation(async (a) => {
      const key = (a as { where: { key: string } }).where.key;
      const v: Record<string, string> = { metaCapiEnabled: "true", metaCapiDatasetId: "DS1", metaCapiToken: "secret-token", igBusinessId: "IG1" };
      return v[key] ? { value: v[key] } : null;
    });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => { restorePrisma(); vi.unstubAllGlobals(); });

  it("успех: маркер в теле (не в адресе), строка помечается sent", async () => {
    db.model("metaConversion").findMany.mockResolvedValue([pending]);
    fetchMock.mockResolvedValue(new Response('{"events_received":1}', { status: 200 }));
    await runMetaConversions(now);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v27.0/DS1/events");
    expect(url).not.toContain("secret-token");
    expect(JSON.parse(String(init.body))).toMatchObject({ access_token: "secret-token", data: [{ custom_data: { currency: "USD", value: 7 } }] });
    expect(db.model("metaConversion").update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }));
  });

  it("сбой сети — повтор позже, не потеря", async () => {
    db.model("metaConversion").findMany.mockResolvedValue([pending]);
    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
    await runMetaConversions(now);
    const data = (db.model("metaConversion").update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBeUndefined();
    expect(data.attempts).toBe(1);
    expect((data.nextAttemptAt as Date).getTime()).toBeGreaterThan(now.getTime());
  });

  it("отказ Meta 400 — окончательно failed, без бесконечных повторов", async () => {
    db.model("metaConversion").findMany.mockResolvedValue([pending]);
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"bad"}}', { status: 400 }));
    await runMetaConversions(now);
    expect(db.model("metaConversion").update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });

  it("старше 7 дней — expired, в Meta не идёт", async () => {
    db.model("metaConversion").findMany.mockResolvedValue([{ ...pending, createdAt: new Date("2026-10-30T00:00:00Z") }]);
    await runMetaConversions(now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.model("metaConversion").update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "expired" }) }));
  });
});

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ: каждый файл, который создаёт покупку, обязан либо
 * передать её в enqueuePurchaseConversion, либо стоять в списке исключений с
 * причиной. Новый путь оплаты мимо рекламной статистики падает здесь.
 */
describe("сторож: новая покупка не проходит мимо metaConversions", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const EXEMPT: Record<string, string> = {
    "course/manualEnrollment.ts": "ручная запись владельцем — оплата не в переписке, Meta её не сопоставит",
  };
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
  it("purchase.create только рядом с enqueuePurchaseConversion", () => {
    const offenders = walk(SRC)
      .map((f) => ({ rel: path.relative(SRC, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }))
      .filter(({ text }) => /purchase\.create(Many)?\s*\(/.test(text))
      .filter(({ rel, text }) => !EXEMPT[rel] && !text.includes("enqueuePurchaseConversion("))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
