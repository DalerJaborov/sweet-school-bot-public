import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: vi.fn(async () => undefined) }));

import { swapOldestDevice, issuePairToken, pairDevice, describeDevice, MAX_DEVICE_SWAPS_PER_MONTH } from "../../src/course/access.js";
import { courseTokenSecret } from "../../src/course/tokenSecret.js";
import type { Contact, Device } from "@prisma/client";

let db: PrismaMock;
beforeEach(() => {
  db = mockPrisma();
});
afterEach(restorePrisma);

const contact = { id: "c1", igUserId: "ig", username: "u", deviceSwaps: 0, deviceSwapAt: null, accessTokenId: null } as unknown as Contact;
const device = { id: "d1", contactId: "c1", secret: "s-1", blockedAt: null, lastCity: "TJ", lastSeenAt: new Date() } as unknown as Device;

function fakeReq() {
  return { headers: {}, header: () => undefined, ip: "1.1.1.1" } as never;
}
function fakeRes() {
  const h: Record<string, unknown> = {};
  return { setHeader: (k: string, v: unknown) => (h[k] = v), h } as never as { h: Record<string, unknown> };
}

describe("«Это мой новый телефон» — замена самого старого устройства", () => {
  it("удаляет самое давнее незаблокированное и считает замену", async () => {
    db.model("device").findFirst.mockResolvedValue({ id: "old" });
    expect(await swapOldestDevice(contact)).toBe(true);
    expect(db.model("device").delete).toHaveBeenCalledWith({ where: { id: "old" } });
    expect(db.model("device").findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "c1", blockedAt: null }, orderBy: { lastSeenAt: "asc" } })
    );
    expect(db.model("contact").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deviceSwaps: 1, deviceSwapAt: expect.any(Date) } })
    );
  });

  it("ГЛАВНОЕ: больше двух замен в месяц — отказ, дальше решает владелец", async () => {
    const busy = { ...contact, deviceSwaps: MAX_DEVICE_SWAPS_PER_MONTH, deviceSwapAt: new Date() } as Contact;
    expect(await swapOldestDevice(busy)).toBe(false);
    expect(db.model("device").delete).not.toHaveBeenCalled();
  });

  it("старые замены (месяц назад) не считаются", async () => {
    const old = { ...contact, deviceSwaps: 5, deviceSwapAt: new Date(Date.now() - 40 * 86_400_000) } as Contact;
    db.model("device").findFirst.mockResolvedValue({ id: "old" });
    expect(await swapOldestDevice(old)).toBe(true);
    expect(db.model("contact").update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deviceSwaps: 1 }) }));
  });

  it("все устройства заблокированы — заменять нечего", async () => {
    db.model("device").findFirst.mockResolvedValue(null);
    expect(await swapOldestDevice(contact)).toBe(false);
  });

  it("подпись устройства — человеческая", () => {
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7)")).toBe("iPhone");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0)")).toBe("Компьютер");
    expect(describeDevice(null)).toBe("Устройство");
  });
});

describe("Pair-токен — вход установленного приложения без ссылки", () => {
  beforeEach(() => {
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("device").findUnique.mockResolvedValue(device);
    db.model("purchase").findMany.mockResolvedValue([{ id: "p1", contactId: "c1", courseId: "k1", revokedAt: null }]);
    db.model("device").update.mockResolvedValue(device);
  });

  it("обменивает токен на сессию ТОГО ЖЕ устройства — второе место не занимается", async () => {
    const token = issuePairToken("c1", device);
    const res = fakeRes();
    const result = await pairDevice(fakeReq(), res as never, token);
    expect(result.ok).toBe(true);
    expect(db.model("device").create).not.toHaveBeenCalled();
    expect(String(res.h["Set-Cookie"])).toContain("ssb_course=");
  });

  it("ротировали секрет устройства — токен мёртв", async () => {
    const token = issuePairToken("c1", device);
    db.model("device").findUnique.mockResolvedValue({ ...device, secret: "другой" });
    expect(await pairDevice(fakeReq(), fakeRes() as never, token)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("заблокированное устройство — blocked; отозванный доступ — revoked", async () => {
    const token = issuePairToken("c1", device);
    db.model("device").findUnique.mockResolvedValue({ ...device, blockedAt: new Date(), blockedReason: "передали" });
    expect(await pairDevice(fakeReq(), fakeRes() as never, token)).toMatchObject({ ok: false, reason: "blocked" });
    db.model("device").findUnique.mockResolvedValue(device);
    db.model("purchase").findMany.mockResolvedValue([]);
    expect(await pairDevice(fakeReq(), fakeRes() as never, token)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("чужой контакт или не тот вид токена — не пускаем", async () => {
    db.model("device").findUnique.mockResolvedValue({ ...device, contactId: "c2" });
    expect(await pairDevice(fakeReq(), fakeRes() as never, issuePairToken("c1", device))).toMatchObject({ ok: false });
    const session = jwt.sign({ kind: "course-session", contactId: "c1", deviceId: "d1" }, courseTokenSecret());
    expect(await pairDevice(fakeReq(), fakeRes() as never, session)).toMatchObject({ ok: false, reason: "not_found" });
  });
});
