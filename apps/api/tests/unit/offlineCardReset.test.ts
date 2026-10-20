import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-1");
vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: () => "instagram",
}));

import { maybeSendOfflineCard } from "../../src/ai/offlineCourse.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { offlineCourseStartDate: "2026-10-03" };

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  sendText.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

/**
 * Карточка очного курса уходила человеку ОДИН РАЗ В ЖИЗНИ: отметка не
 * сбрасывалась никогда. Спросившая про октябрьский набор и не пришедшая в
 * ноябре не получала карточку с новой датой. За несколько наборов это
 * выкашивало весь тёплый список.
 */
describe("Карточка очного курса — раз в НАБОР, а не раз в жизни", () => {
  it("не слали — шлём", async () => {
    const sent = await maybeSendOfflineCard(fakeContact({ offlineInfoSentAt: null }), "хочу записаться");
    expect(sent).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("слали в этом наборе — повторно не шлём", async () => {
    const sent = await maybeSendOfflineCard(
      fakeContact({ offlineInfoSentAt: new Date("2026-09-01") }),
      "а когда курс?"
    );
    expect(sent).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("ГЛАВНОЕ: слали в ПРОШЛОМ наборе — шлём снова с новой датой", async () => {
    const sent = await maybeSendOfflineCard(
      fakeContact({ offlineInfoSentAt: new Date("2026-05-10") }),
      "курс ещё будет?"
    );
    expect(sent).toBe(true);
    // Захват отметки учитывает старую дату — гонка двух сообщений не даст двух карточек.
    const where = (db.model("contact").updateMany.mock.calls[0][0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toHaveLength(2);
  });

  it("дата набора не задана — ведём себя как раньше: один раз", async () => {
    delete SETTINGS.offlineCourseStartDate;
    const sent = await maybeSendOfflineCard(
      fakeContact({ offlineInfoSentAt: new Date("2025-01-01") }),
      "запишите"
    );
    SETTINGS.offlineCourseStartDate = "2026-10-03";
    expect(sent).toBe(false);
  });
});
