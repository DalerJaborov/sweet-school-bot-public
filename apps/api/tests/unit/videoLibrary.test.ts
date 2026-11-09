import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  sentOut: [] as string[],
  recentOut: 0,
  purchases: 0,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    message: {
      // Исходящие клиенту (alreadyShown сравнивает их после фильтра); входящие для языка — пусто.
      findMany: vi.fn(async (args: { where: { direction?: string } }) =>
        args.where.direction === "OUT" ? [...state.sentOut].reverse().map((text) => ({ text })) : [],
      ),
      count: vi.fn(async () => state.recentOut),
    },
    purchase: { count: vi.fn(async () => state.purchases) },
  },
  recordOutgoingMessage: vi.fn(async (_id: string, text: string) => {
    state.sentOut.push(text);
  }),
  getSetting: vi.fn(async (k: string) => state.settings.get(k) ?? null),
  logError: vi.fn(),
}));
vi.mock("../../src/env.js", () => ({ env: { publicBaseUrl: "https://shirinsweets.online" } }));
const send = vi.hoisted(() => ({ sendVideoWithCaption: vi.fn(async () => "m1") }));
vi.mock("../../src/messaging/send.js", () => send);

import {
  DEFAULT_VIDEOS,
  allowedVideoUrl,
  detectVideoIntent,
  libraryError,
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
  url: `https://shirinsweets.online/video/${id}.mp4`,
  caption: { ru: `Ролик: ${id}`, tg: `Видео: ${id}` },
});
const howto: VideoEntry = {
  id: "howto",
  kind: "howto",
  url: "/video/how-to-watch.mp4",
  caption: { ru: "Вот как проходит онлайн-урок", tg: "Дарси онлайн ингуна мегузарад" },
};
const lib = [clip("rafaello", "рафаэл"), clip("snickers", "сникерс"), clip("whoopie", "вупи"), howto];

beforeEach(() => {
  state.settings.clear();
  state.sentOut.length = 0;
  state.recentOut = 0;
  state.purchases = 0;
  send.sendVideoWithCaption.mockClear();
});

describe("список роликов", () => {
  it("по умолчанию — только настоящие превью с сайта", () => {
    expect(parseLibrary(null)).toBe(DEFAULT_VIDEOS);
    expect(DEFAULT_VIDEOS.every(validEntry)).toBe(true);
  });
  it("битый JSON и негодные записи отбрасываются, ошибка видна текстом", () => {
    expect(parseLibrary("{oops")).toBe(DEFAULT_VIDEOS);
    expect(libraryError("{oops")).toMatch(/не JSON/);
    expect(libraryError("{}")).toMatch(/массивом/);
    const bad = [{ ...clip("a", "аа"), url: "http://x/a.mp4" }, clip("b", "бб")];
    expect(parseLibrary(JSON.stringify(bad)).map((e) => e.id)).toEqual(["b"]);
    expect(libraryError(JSON.stringify(bad))).toMatch(/№1/);
    expect(libraryError(JSON.stringify([clip("b", "бб")]))).toBeNull();
    expect(libraryError("")).toBeNull();
  });
  it.each(["Курс за 70 сомони", "Оплатите сейчас", "Наша школа", "Вкусно 😍", "Нарх: 70"])("подпись «%s» не пропускается", (ru) => {
    expect(validEntry({ ...clip("a", "аа"), caption: { ru, tg: "Видео" } })).toBe(false);
  });
  it.each([
    ["/img/lessons/x.mp4", true],
    ["/video/a/b.mp4", true],
    ["https://shirinsweets.online/video/x.mp4", true],
    ["/api/v1/free-lesson/content", false],
    ["/api/admin/x.mp4", false],
    ["https://evil.example/video/x.mp4", false],
    ["http://shirinsweets.online/video/x.mp4", false],
    ["/video/../api/x.mp4", false],
    ["/video/x.png", false],
  ])("адрес %s → %s", (url, ok) => {
    expect(allowedVideoUrl(url)).toBe(ok);
  });
  it("ссылка на сайте становится полной", () => {
    expect(videoUrl("/img/lessons/x.mp4")).toBe("https://shirinsweets.online/img/lessons/x.mp4");
  });
});

describe("что просит клиент: целые слова и стоп-список", () => {
  it.each([
    "покажите реквизиты",
    "покажите куда переводить",
    "рақами кортро нишон диҳед",
    "рақами кортро нишон дихед",
    "например, как оплатить?",
    "например, расскажите про курс",
    "сколько видео в курсе?",
    "как проходит оплата",
    "как проходит офлайн курс",
    "есть десерт вупи пай? сколько стоит",
    "покажите вупи пай, чек отправлю",
    "пришлите видео, переведу сейчас",
  ])("«%s» — ролик не нужен", (text) => {
    expect(detectVideoIntent(text, lib)).toBeNull();
  });
  it("вложение — не просьба про видео", () => {
    expect(detectVideoIntent("покажите видео", lib, { hasAttachments: true })).toBeNull();
  });
  it("явная просьба — ролик вместо ответа; просто упомянули десерт — вдобавок", () => {
    expect(detectVideoIntent("покажите видео вупи пай", lib)).toMatchObject({ kind: "dessert", replace: true });
    expect(detectVideoIntent("есть вупи пай?", lib)).toMatchObject({ kind: "dessert", replace: false });
    expect(detectVideoIntent("а в вупи пай что внутри", lib)).toMatchObject({ kind: "dessert", replace: false });
    expect(detectVideoIntent("покажите видео ваших десертов", lib)).toEqual({ kind: "set", replace: true });
  });
  it("«как смотреть / что такое онлайн» — видео-инструкция", () => {
    expect(detectVideoIntent("а как проходит онлайн курс?", lib)).toMatchObject({ kind: "howto" });
    expect(detectVideoIntent("я не понимаю что такое онлайн курс", lib)).toMatchObject({ kind: "howto" });
    expect(detectVideoIntent("как смотреть уроки", lib)).toMatchObject({ kind: "howto" });
  });
  it("подборки нет, если роликов меньше трёх; обычные вопросы — не наш случай", () => {
    expect(detectVideoIntent("покажите видео", DEFAULT_VIDEOS)).toBeNull();
    expect(detectVideoIntent("здравствуйте, расскажите о курсе", lib)).toBeNull();
  });
});

describe("отправка", () => {
  const on = (list: VideoEntry[] = lib) => {
    state.settings.set("videoLibraryEnabled", "true");
    state.settings.set("videoLibrary", JSON.stringify(list));
  };
  it("выключено — молчит", async () => {
    expect(await maybeSendVideos(contact, "покажите видео вупи пай")).toBe("none");
    expect(send.sendVideoWithCaption).not.toHaveBeenCalled();
  });
  it("видео и подпись — ОДНО сообщение; один показ за разговор", async () => {
    on();
    expect(await maybeSendVideos(contact, "покажите видео вупи пай")).toBe("replace");
    expect(send.sendVideoWithCaption).toHaveBeenCalledTimes(1);
    expect(send.sendVideoWithCaption).toHaveBeenCalledWith(contact, "https://shirinsweets.online/video/whoopie.mp4", "Ролик: whoopie");
    expect(await maybeSendVideos(contact, "а сникерс покажите")).toBe("none");
  });
  it("упомянули десерт вопросом — ролик вдобавок, ответ даёт модель", async () => {
    on();
    expect(await maybeSendVideos(contact, "есть десерт с вупи пай?")).toBe("addon");
  });
  it("подборка — не больше 3 роликов", async () => {
    on(["a", "b", "c", "d", "e", "f"].map((i) => clip(i, `к${i}`)));
    expect(await maybeSendVideos(contact, "покажите примеры")).toBe("replace");
    expect(send.sendVideoWithCaption).toHaveBeenCalledTimes(3);
  });
  it("учитывает остаток лимита моста: 8 за 10 минут, одна отправка — под ответ бота", async () => {
    on(["a", "b", "c", "d"].map((i) => clip(i, `к${i}`)));
    state.recentOut = 5; // остаток 8-5-1 = 2
    expect(await maybeSendVideos(contact, "покажите видео")).toBe("replace");
    expect(send.sendVideoWithCaption).toHaveBeenCalledTimes(2);
    send.sendVideoWithCaption.mockClear();
    state.sentOut.length = 0;
    state.recentOut = 7; // места нет — отвечает модель
    expect(await maybeSendVideos(contact, "покажите видео")).toBe("none");
    expect(send.sendVideoWithCaption).not.toHaveBeenCalled();
  });
  it("купившей курс ролики не шлём", async () => {
    on();
    state.purchases = 1;
    expect(await maybeSendVideos(contact, "покажите видео вупи пай")).toBe("none");
    expect(send.sendVideoWithCaption).not.toHaveBeenCalled();
  });
  it("«как смотреть» не мешает показу десерта и тоже не повторяется", async () => {
    on([clip("a", "аа"), howto]);
    expect(await maybeSendVideos(contact, "как проходит онлайн курс")).toBe("replace");
    expect(await maybeSendVideos(contact, "как проходит онлайн курс")).toBe("none");
    expect(await maybeSendVideos(contact, "покажите аа")).toBe("replace");
  });
});
