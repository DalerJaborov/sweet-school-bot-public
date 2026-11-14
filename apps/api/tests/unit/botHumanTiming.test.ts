import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { debounceMessage, flushAllPending, WINDOW_MS, MAX_WAIT_MS } from "../../src/debounce.js";
import { processWebhookInbox, type InboxEvent } from "../../src/webhookInbox.js";
import * as database from "../../src/db.js";

/**
 * п.8 (владелец 11.11.2026): «быстро, но дождаться пачки» — один ответ на 2–4
 * пузыря подряд. Класс ошибки два: короткое окно дебаунса и очередь вебхуков,
 * которая не брала второе сообщение, пока бот отвечал на первое.
 */
describe("окно ожидания пачки", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(database, "logError").mockImplementation(() => {});
  });
  afterEach(async () => {
    await flushAllPending();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("6–10 секунд тишины: три пузыря с паузами 3 с — один ответ на все", async () => {
    expect(WINDOW_MS).toBeGreaterThanOrEqual(6_000);
    expect(WINDOW_MS).toBeLessThanOrEqual(10_000);
    const reply = vi.fn(async () => undefined);
    void debounceMessage("p", "Салом", [], [], reply);
    await vi.advanceTimersByTimeAsync(3_000);
    void debounceMessage("p", "курси онлайн", [], [], reply);
    await vi.advanceTimersByTimeAsync(3_000);
    void debounceMessage("p", "нархаш чанд?", [], [], reply);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(reply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("Салом\nкурси онлайн\nнархаш чанд?", [], []);
  });

  it("человек пишет без остановки — ответ всё равно не позже потолка от первого сообщения", async () => {
    const reply = vi.fn(async () => undefined);
    for (let t = 0; t < MAX_WAIT_MS + 10_000; t += 4_000) {
      void debounceMessage("q", `пузырь ${t}`, [], [], reply);
      await vi.advanceTimersByTimeAsync(4_000);
      if (reply.mock.calls.length > 0) break;
    }
    expect(reply).toHaveBeenCalled();
  });
});

describe("очередь вебхуков не держит второе сообщение, пока бот отвечает на первое", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    vi.spyOn(database, "logError").mockImplementation(() => {});
    db.model("webhookInbox").updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(() => {
    restorePrisma();
    vi.restoreAllMocks();
  });

  it("второе событие берётся в работу, пока первое ещё обрабатывается", async () => {
    const ev = (mid: string): InboxEvent => ({ channel: "INSTAGRAM", selfId: "page", kind: "message", event: { sender: { id: "c" }, message: { mid, text: mid } } });
    db.model("webhookInbox").findMany
      .mockResolvedValueOnce([{ id: "r1", payload: JSON.stringify(ev("one")), attempts: 0 }])
      .mockResolvedValueOnce([{ id: "r2", payload: JSON.stringify(ev("two")), attempts: 0 }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    const handle = async (e: InboxEvent) => {
      const mid = (e.event.message as { mid: string }).mid;
      seen.push(mid);
      if (mid === "one") await gate; // бот «думает» над первым
    };
    const first = processWebhookInbox(handle);
    await new Promise((r) => setTimeout(r, 0));
    const second = processWebhookInbox(handle); // новый вебхук пришёл, пока первый в работе
    await second;
    expect(seen).toEqual(["one", "two"]);
    release();
    await first;
  });
});
