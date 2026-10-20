import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, askAssistant, hasToken, logout, setSessionExpiredHandler, setToken, uploadFile } from "../src/api";

/**
 * ПРОТУХШИЙ ТОКЕН (30 дней): 401 на запросе с токеном стирает его и зовёт
 * обработчик «сессия кончилась» (по умолчанию — перезагрузка страницы, тогда
 * App покажет форму входа или заново войдёт по подписи Telegram). 401 БЕЗ
 * токена — неверный пароль на /admin/login — сессию не трогает.
 */
function respond(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

describe("api — 401 при живом токене", () => {
  const expired = vi.fn();
  beforeEach(() => {
    setSessionExpiredHandler(expired);
    expired.mockClear();
  });
  afterEach(() => {
    logout();
    vi.unstubAllGlobals();
  });

  it("стирает токен и зовёт обработчик, ошибку всё равно бросает", async () => {
    setToken("old");
    vi.stubGlobal("fetch", respond(401, { error: "Нужен вход" }));
    await expect(api("/admin/today")).rejects.toMatchObject({ status: 401, message: "Нужен вход" });
    expect(hasToken()).toBe(false);
    expect(localStorage.getItem("ssb_token")).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("неверный пароль на входе (токена нет) — сессию не трогает", async () => {
    vi.stubGlobal("fetch", respond(401, { error: "Неверный пароль" }));
    await expect(api("/admin/login", { method: "POST", body: { password: "x" } })).rejects.toThrow("Неверный пароль");
    expect(expired).not.toHaveBeenCalled();
  });

  it("noAuth-запрос (вход из Telegram) при 401 токен не трогает", async () => {
    setToken("keep");
    vi.stubGlobal("fetch", respond(401, { error: "Подпись Telegram не сошлась" }));
    await expect(api("/admin/telegram-login", { method: "POST", body: { initData: "x" }, noAuth: true })).rejects.toThrow();
    expect(hasToken()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });

  it("другие ошибки (500) сессию не стирают", async () => {
    setToken("old");
    vi.stubGlobal("fetch", respond(500, { error: "Внутренняя ошибка" }));
    await expect(api("/admin/today")).rejects.toThrow("Внутренняя ошибка");
    expect(hasToken()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });

  it("загрузка файла и помощница ведут себя так же", async () => {
    setToken("old");
    vi.stubGlobal("fetch", respond(401, { error: "Нужен вход" }));
    await expect(uploadFile(new File(["x"], "a.png", { type: "image/png" }))).rejects.toThrow();
    expect(hasToken()).toBe(false);
    setToken("old");
    await expect(askAssistant("сколько продали?", [])).rejects.toThrow();
    expect(hasToken()).toBe(false);
    expect(expired).toHaveBeenCalledTimes(2);
  });
});
