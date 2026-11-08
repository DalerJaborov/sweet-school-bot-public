import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ settings: new Map<string, string>(), sentOut: [] as string[] }));

vi.mock("../../src/db.js", () => ({
  prisma: {
    message: {
      findMany: vi.fn(async (args: { where: { text: { in: string[] } } }) =>
        state.sentOut.filter((t) => args.where.text.in.includes(t)).map((text) => ({ text })),
      ),
    },
  },
  recordOutgoingMessage: vi.fn(async (_id: string, text: string) => {
    state.sentOut.push(text);
  }),
  getSetting: vi.fn(async (k: string) => state.settings.get(k) ?? null),
  logError: vi.fn(),
}));
vi.mock("../../src/env.js", () => ({ env: { publicBaseUrl: "https://shirinsweets.online" } }));
const send = vi.hoisted(() => ({ sendToContact: vi.fn(async () => "m1"), sendAttachmentToContact: vi.fn(async () => "m2") }));
vi.mock("../../src/messaging/send.js", () => send);

import {
  DEFAULT_VIDEOS,
  detectVideoIntent,
  maybeSendVideos,
  parseLibrary,
  validEntry,
  videoUrl,
  type VideoEntry,
} from "../../src/ai/videoLibrary.js";

const contact = { id: "c1" } as never;
const clip = (id: string, kw: string): VideoEntry => ({
  id,
  kind: "dessert",
  dessert: id,
  keywords: [kw],
  url: `https://shirinsweets.online/v/${id}.mp4`,
  caption: { ru: `Ролик: ${id}`, tg: `Видео: ${id}` },
});
const howto: VideoEntry = {
  id: "howto",
  kind: "howto",
  url: "/video/how-to-watch.mp4",
  caption: { ru: "Вот как проходит онлайн-урок", tg: "Дарси онлайн ингуна мегузарад" },
};

beforeEach(() => {
  state.settings.clear();
  state.sentOut.length = 0;
  send.sendToContact.mockClear();
  send.sendAttachmentToContact.mockClear();
});

describe("список роликов", () => {
  it("по умолчанию — только настоящие превью с сайта", () => {
    expect(parseLibrary(null)).toBe(DEFAULT_VIDEOS);
    expect(DEFAULT_VIDEOS.map((e) => e.url).every((u) => u.startsWith("/img/lessons/") && u.endsWith(".mp4"))).toBe(true);
    expect(DEFAULT_VIDEOS.every(validEntry)).toBe(true);
  });
  it("битый JSON и негодные записи отбрасываются", () => {
    expect(parseLibrary("{oops")).toBe(DEFAULT_VIDEOS);
    const bad = [{ ...clip("a", "аа"), url: "http://x/a.mp4" }, clip("b", "бб")];
    expect(parseLibrary(JSON.stringify(bad)).map((e) => e.id)).toEqual(["b"]);
  });
  it.each(["Курс за 70 сомони", "Оплатите сейчас", "Наша школа", "Вкусно 😍", "Нарх: 70"])("подпись «%s» не пропускается", (ru) => {
    expect(validEntry({ ...clip("a", "аа"), caption: { ru, tg: "Видео" } })).toBe(false);
  });
  it("ссылка на сайте становится полной", () => {
    expect(videoUrl("/img/lessons/x.mp4")).toBe("https://shirinsweets.online/img/lessons/x.mp4");
    expect(videoUrl("https://cdn.example/x.mp4")).toBe("https://cdn.example/x.mp4");
  });
});

describe("что просит клиент", () => {
  const lib = [clip("Рафаэлло", "рафаэл"), clip("Сникерс", "сникерс"), clip("Вупи пай", "вупи"), howto];
  it("названный десерт — его ролик", () => {
    expect(detectVideoIntent("а как выглядит Рафаэлло?", lib)).toMatchObject({ kind: "dessert" });
  });
  it("общая просьба — подборка", () => {
    expect(detectVideoIntent("покажите видео ваших десертов", lib)).toEqual({ kind: "set" });
  });
  it("непонятно, что такое онлайн — видео «как смотреть»", () => {
    expect(detectVideoIntent("а как проходит онлайн курс?", lib)).toEqual({ kind: "howto" });
    expect(detectVideoIntent("я не понимаю что такое онлайн курс", lib)).toEqual({ kind: "howto" });
  });
  it("обычный вопрос — не наш случай; подборки нет, если роликов меньше трёх", () => {
    expect(detectVideoIntent("сколько стоит курс", lib)).toBeNull();
    expect(detectVideoIntent("покажите видео", DEFAULT_VIDEOS)).toBeNull();
  });
});

describe("отправка", () => {
  it("выключено — молчит", async () => {
    expect(await maybeSendVideos(contact, "покажите видео вупи пай")).toBe(false);
    expect(send.sendAttachmentToContact).not.toHaveBeenCalled();
  });
  it("включено — подпись и видео, один раз за разговор", async () => {
    state.settings.set("videoLibraryEnabled", "true");
    expect(await maybeSendVideos(contact, "а вупи пай какой?")).toBe(true);
    expect(send.sendAttachmentToContact).toHaveBeenCalledWith(contact, "https://shirinsweets.online/img/lessons/whoopie-preview.mp4", "video");
    expect(await maybeSendVideos(contact, "а манго есть?")).toBe(false);
    expect(send.sendAttachmentToContact).toHaveBeenCalledTimes(1);
  });
  it("подборка — 3–6 роликов, одним набором", async () => {
    state.settings.set("videoLibraryEnabled", "true");
    state.settings.set("videoLibrary", JSON.stringify(["a", "b", "c", "d", "e", "f", "g", "h"].map((i) => clip(i, `к${i}`))));
    expect(await maybeSendVideos(contact, "покажите примеры")).toBe(true);
    expect(send.sendAttachmentToContact).toHaveBeenCalledTimes(6);
    expect(await maybeSendVideos(contact, "ещё покажите")).toBe(false);
  });
  it("«как смотреть» не мешает показу десерта и тоже не повторяется", async () => {
    state.settings.set("videoLibraryEnabled", "true");
    state.settings.set("videoLibrary", JSON.stringify([clip("a", "аа"), howto]));
    expect(await maybeSendVideos(contact, "как проходит онлайн курс")).toBe(true);
    expect(await maybeSendVideos(contact, "как проходит онлайн курс")).toBe(false);
    expect(await maybeSendVideos(contact, "аа какой")).toBe(true);
  });
});
