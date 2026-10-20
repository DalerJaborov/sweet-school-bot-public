import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const notifyOwnerDirect = vi.fn(async () => undefined);
vi.mock("../../src/systemAlerts.js", () => ({
  notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...a),
}));

import { recordAiCall, isBudgetExceeded } from "../../src/ai/dailyBudget.js";

let db: PrismaMock;
let settings: Record<string, string>;

beforeEach(() => {
  db = mockPrisma();
  settings = { aiDailyLimitGlobal: "10" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null
  );
  db.model("setting").upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    settings[where.key] = update.value;
    return { key: where.key, value: update.value };
  });
  notifyOwnerDirect.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

/**
 * Квота Gemini кончается — и владелец узнаёт об этом заранее (80%) и по факту
 * (100%), по одному разу в сутки на каждый порог. Счётчики — те же, что в
 * Setting, на живых данных.
 */
describe("Тревога о суточном лимите Gemini", () => {
  it("ГЛАВНОЕ: при лимите 10 — 🟠 на 8-м вызове, 🔴 на 10-м, каждая ровно один раз", async () => {
    for (let i = 1; i <= 7; i++) await recordAiCall("c1");
    expect(notifyOwnerDirect).not.toHaveBeenCalled();

    await recordAiCall("c1");
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("80% суточного лимита — 8 из 10");

    await recordAiCall("c1");
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);

    await recordAiCall("c1");
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(2);
    expect(String(notifyOwnerDirect.mock.calls[1][0])).toContain("лимит исчерпан — 10 из 10");
    expect(await isBudgetExceeded("c1")).toBe(true);

    // Дальше вызовы (другие места учёта) — тревог больше нет.
    await recordAiCall("c2");
    await recordAiCall("c3");
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(2);
  });

  it("отметка о тревоге лежит в суточном счётчике — переживает перезапуск", async () => {
    const day = new Date().toISOString().slice(0, 10);
    settings[`aiBudget:global:${day}`] = JSON.stringify({ calls: 9, alerted80: 1 });
    await recordAiCall("c1");
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("исчерпан");
    expect(JSON.parse(settings[`aiBudget:global:${day}`])).toMatchObject({ calls: 10, alerted80: 1, alerted100: 1 });
  });

  it("лимит по умолчанию (1000): на 800-м вызове — 80%", async () => {
    delete settings.aiDailyLimitGlobal;
    const day = new Date().toISOString().slice(0, 10);
    settings[`aiBudget:global:${day}`] = JSON.stringify({ calls: 799 });
    await recordAiCall("c1");
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("800 из 1000");
  });
});
