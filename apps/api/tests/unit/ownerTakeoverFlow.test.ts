import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { resolveTakeover, releaseExpiredTakeovers, scheduleHeldReply } from "../../src/ai/ownerTakeover.js";

let db: PrismaMock;
const now = new Date("2026-11-08T12:00:00Z");
const ago = (m: number) => new Date(now.getTime() - m * 60_000);
const contact = { id: "c1", humanTakenOverAt: ago(5) };
beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockResolvedValue(null);
});
afterEach(restorePrisma);

describe("resolveTakeover (с базой)", () => {
  it("хозяйка писала 5 минут назад: молчим и ждём до окна терпения", async () => {
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(5) });
    const d = await resolveTakeover(contact, { text: "Сколько стоит?", at: ago(1) }, now);
    expect(d).toEqual({ action: "hold", until: new Date(ago(1).getTime() + 12 * 60_000) });
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
  it("хозяйка молчит 30 минут: бот отвечает и перехват снимается", async () => {
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(30) });
    const d = await resolveTakeover(contact, { text: "Алло?", at: ago(0) }, now);
    expect(d).toMatchObject({ action: "answer", why: "cold" });
    expect(db.model("contact").update).toHaveBeenCalledWith(expect.objectContaining({ data: { humanTakenOverAt: null, humanTakeoverMid: null } }));
  });
  it("сутки без реплик: перехват снят совсем", async () => {
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(25 * 60) });
    expect(await resolveTakeover(contact, { text: "Привет", at: ago(0) }, now)).toMatchObject({ why: "expired" });
  });
  it("купившая просит ссылку заново: отвечаем сразу, перехват остаётся", async () => {
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(2) });
    db.model("purchase").count.mockResolvedValue(1);
    const d = await resolveTakeover(contact, { text: "курс не открывается, дайте ссылку заново", at: ago(0) }, now);
    expect(d).toEqual({ action: "answer", why: "safe_intent" });
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
  it("рубильник выключен: молчим без срока", async () => {
    db.model("setting").findUnique.mockImplementation(async (a: { where: { key: string } }) => (a.where.key === "smartTakeoverEnabled" ? { value: "false" } : null));
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(900) });
    expect(await resolveTakeover(contact, { text: "Привет", at: ago(0) }, now)).toEqual({ action: "hold", until: null });
  });
  it("отложенный ответ ставится в очередь на нужное время, дубль не создаётся", async () => {
    await scheduleHeldReply("c1", "Привет", ago(-5), ago(1));
    expect(db.model("pendingAiReply").create).toHaveBeenCalledWith({ data: { contactId: "c1", text: "Привет", snapshotAt: ago(1), nextAttemptAt: ago(-5) } });
    db.model("pendingAiReply").findFirst.mockResolvedValue({ id: "x" });
    db.model("pendingAiReply").create.mockClear();
    await scheduleHeldReply("c1", "Привет", ago(-5), ago(1));
    expect(db.model("pendingAiReply").create).not.toHaveBeenCalled();
  });
  it("тик снимает старые перехваты и не трогает свежие", async () => {
    db.model("contact").findMany.mockResolvedValue([{ id: "old" }, { id: "fresh" }]);
    db.model("message").findFirst.mockImplementation(async (a: { where: { contactId: string } }) => (a.where.contactId === "fresh" ? { id: 1 } : null));
    expect(await releaseExpiredTakeovers(now)).toBe(1);
  });
});
