import { describe, it, expect } from "vitest";
import { decideTakeover, isSafeIntent, TAKEOVER_DEFAULTS } from "../../src/ai/ownerTakeover.js";

const config = { enabled: true, ...TAKEOVER_DEFAULTS };
const t0 = new Date("2026-11-08T10:00:00Z");
const min = (m: number) => new Date(t0.getTime() + m * 60_000);

describe("умный перехват хозяйки", () => {
  it("пока хозяйка живо ведёт разговор — молчим до 12 минут терпения", () => {
    const d = decideTakeover({ config, anchor: t0, incomingAt: min(3), safeIntent: false, now: min(4) });
    expect(d).toEqual({ action: "hold", until: min(15) });
  });
  it("хозяйка молчит дольше 12 минут — бот отвечает сам", () => {
    expect(decideTakeover({ config, anchor: t0, incomingAt: min(3), safeIntent: false, now: min(15) })).toEqual({ action: "answer", why: "idle" });
  });
  it("окно 25 минут кончилось — разговор остыл, бот отвечает сразу", () => {
    expect(decideTakeover({ config, anchor: t0, incomingAt: min(60), safeIntent: false, now: min(60) })).toEqual({ action: "answer", why: "cold" });
  });
  it("безопасный запрос обслуживается сразу", () => {
    expect(decideTakeover({ config, anchor: t0, incomingAt: min(1), safeIntent: true, now: min(1) })).toEqual({ action: "answer", why: "safe_intent" });
  });
  it("через сутки без ручных реплик перехват снят", () => {
    expect(decideTakeover({ config, anchor: t0, incomingAt: min(1500), safeIntent: false, now: min(1500) })).toEqual({ action: "answer", why: "expired" });
  });
  it("рубильник выключен — старое поведение, молчим без срока", () => {
    expect(decideTakeover({ config: { ...config, enabled: false }, anchor: t0, incomingAt: min(900), safeIntent: false, now: min(900) })).toEqual({ action: "hold", until: null });
  });
  it("безопасные намерения: спасибо и доступ купившей", () => {
    expect(isSafeIntent("Рахмат", false)).toBe(true);
    expect(isSafeIntent("курс не открывается, дайте ссылку заново", true)).toBe(true);
    expect(isSafeIntent("курс не открывается, дайте ссылку заново", false)).toBe(false);
    expect(isSafeIntent("Сколько стоит?", true)).toBe(false);
  });
});

describe("хозяйка уже ответила после сообщения", () => {
  it("бот не отвечает поверх неё", () => {
    expect(decideTakeover({ config, anchor: min(5), incomingAt: min(0), safeIntent: false, now: min(13) })).toEqual({ action: "hold", until: null });
  });
});
