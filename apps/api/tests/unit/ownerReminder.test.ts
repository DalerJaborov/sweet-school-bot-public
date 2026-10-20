import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const notifyOwnerDirect = vi.fn(async () => undefined);
vi.mock("../../src/systemAlerts.js", () => ({
  notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...a),
}));

import { runOwnerReminders, REMINDER_EVERY_MS } from "../../src/ownerReminder.js";

let db: PrismaMock;
let settings: Record<string, string>;

/** Момент «сейчас» по душанбинскому часу (UTC+5). */
function atDushanbe(hour: number): Date {
  return new Date(Date.UTC(2026, 8, 5, hour - 5, 0, 0));
}

function pendingReceipt(ageHours: number, now: Date) {
  return {
    id: `r-${ageHours}`,
    createdAt: new Date(now.getTime() - ageHours * 3_600_000),
    ownerDecision: "PENDING",
    contact: { username: "madina", igUserId: "ig-1" },
  };
}

beforeEach(() => {
  db = mockPrisma();
  settings = { timezoneOffsetHours: "5" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] ? { key: where.key, value: settings[where.key] } : null
  );
  db.model("setting").upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    settings[where.key] = update.value;
    return { key: where.key, value: update.value };
  });
  db.model("receiptCheck").findMany.mockResolvedValue([]);
  db.model("courseChatMessage").count.mockResolvedValue(0);
  notifyOwnerDirect.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

/**
 * Напоминание владельцу о чеках и вопросах, которые висят дольше часа — раз в
 * два часа, только в рабочее время, только когда есть о чём.
 */
describe("Напоминание владельцу о зависших чеках и вопросах", () => {
  it("ГЛАВНОЕ: днём чек висит 3 часа и есть вопрос — одно сообщение с ником и счётчиком", async () => {
    const now = atDushanbe(14);
    db.model("receiptCheck").findMany.mockResolvedValue([pendingReceipt(3, now)]);
    db.model("courseChatMessage").count.mockResolvedValue(2);

    await runOwnerReminders(now);

    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    const text = String(notifyOwnerDirect.mock.calls[0][0]);
    expect(text).toContain("1 чек без решения дольше часа");
    expect(text).toContain("@madina — 3 ч");
    expect(text).toContain("2 вопроса учениц без ответа");
    // Спрашиваем только то, что висит дольше часа.
    const where = (db.model("receiptCheck").findMany.mock.calls[0][0] as { where: { createdAt: { lte: Date } } }).where;
    expect(now.getTime() - where.createdAt.lte.getTime()).toBe(3_600_000);
    const qWhere = (db.model("courseChatMessage").count.mock.calls[0][0] as { where: { createdAt: { lte: Date } } }).where;
    expect(now.getTime() - qWhere.createdAt.lte.getTime()).toBe(3_600_000);
  });

  it("повтор не раньше чем через два часа — отметка переживает перезапуск (в базе)", async () => {
    const now = atDushanbe(12);
    db.model("receiptCheck").findMany.mockResolvedValue([pendingReceipt(2, now)]);

    await runOwnerReminders(now);
    await runOwnerReminders(new Date(now.getTime() + REMINDER_EVERY_MS - 60_000));
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    expect(settings.ownerReminderSentAt).toBe(String(now.getTime()));

    await runOwnerReminders(new Date(now.getTime() + REMINDER_EVERY_MS));
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(2);
  });

  it("ночью молчим, даже если чек висит", async () => {
    const now = atDushanbe(2);
    db.model("receiptCheck").findMany.mockResolvedValue([pendingReceipt(5, now)]);
    await runOwnerReminders(now);
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").findMany).not.toHaveBeenCalled();
  });

  it("в 22:00 уже не пишем, в 09:00 — уже пишем", async () => {
    db.model("receiptCheck").findMany.mockResolvedValue([pendingReceipt(5, atDushanbe(22))]);
    await runOwnerReminders(atDushanbe(22));
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
    await runOwnerReminders(atDushanbe(9));
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
  });

  it("нечего напоминать — ни сообщения, ни отметки", async () => {
    await runOwnerReminders(atDushanbe(15));
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
    expect(settings.ownerReminderSentAt).toBeUndefined();
  });
});
