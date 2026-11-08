import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LinkExpiredScreen, chatUrl } from "../src/course/screens/LinkExpiredScreen";
import type { LinkExpiredState } from "../src/course/hooks/useCourse";
import { dict } from "../src/course/i18n";

/**
 * Просроченная ссылка — не тупик (аудит 08.11.2026): одна главная кнопка
 * «Получить новую ссылку», исход меняет слова и кнопку. Саму ссылку экран не
 * показывает никогда — она уходит в переписку.
 */
const t = dict("ru");
const school = { telegram: null, instagram: "https://instagram.com/shirin", whatsapp: "https://wa.me/992905355355" };

function state(over: Partial<LinkExpiredState> = {}): LinkExpiredState {
  return { token: "Ab3kQ9xZpm", busy: false, failed: false, result: null, school, ...over };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => school })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinkExpiredScreen", () => {
  it("1 заголовок + 1 строка + главная кнопка «Получить новую ссылку»", () => {
    const onRequest = vi.fn();
    render(<LinkExpiredScreen t={t} state={state()} onRequest={onRequest} />);
    expect(screen.getByRole("heading", { name: t.linkExpiredTitle })).toBeTruthy();
    expect(screen.getByText(t.linkExpiredText)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.getNewLink }));
    expect(onRequest).toHaveBeenCalledOnce();
    // Старого «Попробовать снова» здесь нет: оно ничего не меняло.
    expect(screen.queryByRole("button", { name: t.retry })).toBeNull();
  });

  it("пока идёт запрос — кнопка занята; сеть упала — просим нажать ещё раз", () => {
    const { rerender } = render(<LinkExpiredScreen t={t} state={state({ busy: true })} onRequest={() => undefined} />);
    expect((screen.getByRole("button", { name: t.gettingLink }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<LinkExpiredScreen t={t} state={state({ failed: true })} onRequest={() => undefined} />);
    expect(screen.getByText(t.linkRequestFailed)).toBeTruthy();
  });

  it("ссылка ушла в директ — «уже у вас» и кнопка в переписку Instagram", () => {
    render(<LinkExpiredScreen t={t} state={state({ result: { outcome: "sent", channel: "INSTAGRAM" } })} onRequest={() => undefined} />);
    expect(screen.getByRole("heading", { name: t.linkSentTitle })).toBeTruthy();
    expect(screen.getByRole("link", { name: t.openChat }).getAttribute("href")).toBe(school.instagram);
    expect(screen.queryByText(/\/l\//)).toBeNull();
  });

  it("окно закрыто — «напишите нам», для WhatsApp с готовой фразой, по которой бот ответит сам", () => {
    render(<LinkExpiredScreen t={t} state={state({ result: { outcome: "write_first", channel: "WHATSAPP" } })} onRequest={() => undefined} />);
    expect(screen.getByRole("heading", { name: t.linkWriteFirstTitle })).toBeTruthy();
    expect(screen.getByRole("link", { name: t.writeUs }).getAttribute("href")).toBe(
      `https://wa.me/992905355355?text=${encodeURIComponent(t.linkAskText)}`,
    );
  });

  it("передали Ширин / ссылка уже заменена — честные слова и «Написать нам»", () => {
    const { rerender } = render(
      <LinkExpiredScreen t={t} state={state({ result: { outcome: "escalated", channel: "INSTAGRAM" } })} onRequest={() => undefined} />,
    );
    expect(screen.getByRole("heading", { name: t.linkEscalatedTitle })).toBeTruthy();
    rerender(<LinkExpiredScreen t={t} state={state({ result: { outcome: "unknown", channel: null } })} onRequest={() => undefined} />);
    expect(screen.getByRole("heading", { name: t.linkReplacedTitle })).toBeTruthy();
    expect(screen.getByRole("link", { name: t.writeUs })).toBeTruthy();
  });

  it("по-таджикски — все слова свои", () => {
    const tg = dict("tg");
    render(<LinkExpiredScreen t={tg} state={state()} onRequest={() => undefined} />);
    expect(screen.getByRole("button", { name: tg.getNewLink })).toBeTruthy();
    expect(tg.linkExpiredTitle).not.toBe(t.linkExpiredTitle);
  });
});

describe("chatUrl", () => {
  it("купившая на сайте — в чат сайта; WhatsApp — свой канал; иначе Instagram", () => {
    expect(chatUrl(school, "WEB", null)).toBe("/");
    expect(chatUrl(school, "WHATSAPP", null)).toBe(school.whatsapp);
    expect(chatUrl(school, "INSTAGRAM", null)).toBe(school.instagram);
    expect(chatUrl({ ...school, instagram: null }, "INSTAGRAM", null)).toBe(school.whatsapp);
    expect(chatUrl(null, "INSTAGRAM", null)).toBeNull();
  });
});
