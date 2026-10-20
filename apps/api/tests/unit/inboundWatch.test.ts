import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const notifyOwnerDirect = vi.fn(async () => undefined);
vi.mock("../../src/systemAlerts.js", () => ({
  notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...a),
}));

import { checkInboundSilence, inboundSilenceState, resetInboundWatch } from "../../src/inboundWatch.js";

let db: PrismaMock;
/** Душанбе UTC+5: настройка timezoneOffsetHours = 5. */
const SETTINGS: Record<string, string> = { timezoneOffsetHours: "5" };

/** Момент «сейчас» по душанбинскому часу. */
function atDushanbe(hour: number): Date {
  return new Date(Date.UTC(2026, 8, 3, hour - 5, 0, 0));
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  notifyOwnerDirect.mockClear();
  resetInboundWatch();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Сторож входящих — «бот замолчал» становится видимым", () => {
  it("ГЛАВНОЕ: в рабочее время 5 часов без входящих — тревога и 503 в /health", async () => {
    const now = atDushanbe(14);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 5 * 3_600_000) });

    await checkInboundSilence(now);

    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("Входящих сообщений нет");
    expect(inboundSilenceState()).toMatchObject({ alerting: true, silentHours: 5 });
  });

  it("УТРО: последнее входящее вчера вечером — тревоги нет, ночь не считается", async () => {
    const now = atDushanbe(10); // 10:00, рабочий день только начался
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 11.5 * 3_600_000) }); // 22:30 вчера

    await checkInboundSilence(now);

    expect(notifyOwnerDirect).not.toHaveBeenCalled();
    expect(inboundSilenceState()).toMatchObject({ alerting: false, silentHours: 1 });
  });

  it("ночью тишина — норма: ни тревоги, ни 503", async () => {
    const now = atDushanbe(3);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 8 * 3_600_000) });

    await checkInboundSilence(now);

    expect(notifyOwnerDirect).not.toHaveBeenCalled();
    expect(inboundSilenceState().alerting).toBe(false);
  });

  it("час тишины днём — ещё не порог", async () => {
    const now = atDushanbe(11);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 3_600_000) });

    await checkInboundSilence(now);

    expect(notifyOwnerDirect).not.toHaveBeenCalled();
  });

  it("повторная тревога не раньше чем через 6 часов", async () => {
    const now = atDushanbe(12);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 6 * 3_600_000) });

    await checkInboundSilence(now);
    await checkInboundSilence(new Date(now.getTime() + 3_600_000));
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);

    await checkInboundSilence(new Date(now.getTime() + 7 * 3_600_000));
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(2);
  });

  it("пустая база — не поломка", async () => {
    db.model("message").findFirst.mockResolvedValue(null);
    await checkInboundSilence(atDushanbe(15));
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
    expect(inboundSilenceState().alerting).toBe(false);
  });

  it("порог берётся из настройки inboundSilenceHours", async () => {
    SETTINGS.inboundSilenceHours = "8";
    const now = atDushanbe(16);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 5 * 3_600_000) });
    await checkInboundSilence(now);
    delete SETTINGS.inboundSilenceHours;
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
  });
});
