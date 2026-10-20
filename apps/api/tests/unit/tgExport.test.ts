import { describe, it, expect } from "vitest";
import {
  flattenText,
  parseLessonNumber,
  parseTelegramExport,
  type TgExport,
  type TgMessage,
} from "../../src/course/tgExport.js";

/**
 * Парсер чистый — фикстура встроенная, без файлов и Prisma. Один день,
 * 2024-01-10, все времена в нём; сообщения в массиве специально перемешаны,
 * чтобы проверить сортировку по дате.
 */
const at = (hhmm: string) => `2024-01-10T${hhmm}:00`;

const msgs: TgMessage[] = [
  // Урок с дублирующимся явным номером, в массиве стоит первым (сортировка).
  { id: 40, type: "message", date: at("14:00"), from: "Школа", text: "Урок 2. Эклеры", file: "video_files/eclair.mp4", media_type: "video_file", mime_type: "video/mp4", duration_seconds: 300 },

  // Служебное и текст до первого видео.
  { id: 1, type: "service", date: at("09:00"), text: "" },
  { id: 5, type: "message", date: at("09:30"), from: "Школа", text: "Привет всем!" },

  // Урок 1: подпись массивом сущностей.
  {
    id: 10,
    type: "message",
    date: at("10:00"),
    from: "Школа",
    text: ["Урок ", { type: "bold", text: "1" }, ". Наполеон\nТесто: мука 500 г"],
    file: "video_files/napoleon.mp4",
    media_type: "video_file",
    mime_type: "video/mp4",
    duration_seconds: 1200,
    width: 1280,
    height: 720,
  },
  // Длинный рецепт после видео (первая строка — «1.» — это шаг, не урок).
  { id: 12, type: "message", date: at("10:10"), from: "Школа", text: "1. Взбить яйца\n2. Добавить муку\n3. Выпекать 20 минут" },
  // Фото 1 в массиве стоит после текста 12, но по дате раньше.
  { id: 11, type: "message", date: at("10:05"), from: "Школа", text: "", photo: "photos/photo_1.jpg", width: 800, height: 600 },
  { id: 13, type: "message", date: at("10:12"), from: "Школа", text: "", file: "stickers/s.webp", media_type: "sticker", sticker_emoji: "🎂" },
  { id: 14, type: "message", date: at("10:20"), from: "Школа", text: "", photo: "photos/photo_2.jpg" },
  { id: 15, type: "message", date: at("10:25"), from: "Школа", text: "", file: "voice_messages/v.ogg", media_type: "voice_message", duration_seconds: 12 },
  // 70 минут после последнего прикреплённого — за окном.
  { id: 16, type: "message", date: at("11:30"), from: "Школа", text: "Всем спасибо за урок" },

  // Урок 2: заголовок отдельным сообщением ПЕРЕД видео без подписи.
  { id: 20, type: "message", date: at("12:00"), from: "Школа", text: "Дарси 2 — Медовик" },
  { id: 21, type: "message", date: at("12:05"), from: "Школа", text: "", file: "video_files/medovik.mp4", media_type: "video_file", mime_type: "video/mp4", duration_seconds: 900 },
  { id: 22, type: "message", date: at("12:07"), from: "Школа", text: "", photo: "photos/photo_3.jpg" },

  // Урок 3: без подписи, без media_type — только mime_type.
  { id: 30, type: "message", date: at("13:00"), from: "Школа", text: "", file: "video_files/unnamed.mov", mime_type: "video/quicktime" },
];

const fixture: TgExport = { id: -1001234567890, name: "Кондитерка 50", type: "private_supergroup", messages: msgs };

describe("flattenText", () => {
  it("строка — как есть, undefined — пусто", () => {
    expect(flattenText("Привет")).toBe("Привет");
    expect(flattenText(undefined)).toBe("");
    expect(flattenText("")).toBe("");
  });

  it("массив сущностей склеивается по порядку", () => {
    expect(flattenText(["Урок ", { type: "bold", text: "1" }, ". ", { type: "link", text: "ссылка" }])).toBe("Урок 1. ссылка");
  });
});

describe("parseLessonNumber", () => {
  it.each([
    ["Урок 3. Наполеон", 3, "Наполеон"],
    ["Дарси 12 — Медовик", 12, "Медовик"],
    ["3) Эклеры", 3, "Эклеры"],
    ["Lesson 1: Cake", 1, "Cake"],
    ["урок №7 Птичье молоко", 7, "Птичье молоко"],
    ["Урок 3", 3, ""],
  ])("%s → номер %i, остаток «%s»", (line, number, rest) => {
    expect(parseLessonNumber(line)).toEqual({ number, rest });
  });

  it.each([["Наполеон"], ["Урок"], ["3 яйца"], [""], ["   "]])("«%s» — не заголовок", (line) => {
    expect(parseLessonNumber(line)).toBeNull();
  });
});

describe("parseTelegramExport", () => {
  const result = parseTelegramExport(fixture);

  it("идентификатор и название чата", () => {
    expect(result.chatId).toBe("-1001234567890");
    expect(result.chatName).toBe("Кондитерка 50");
    expect(parseTelegramExport({ messages: [] }).chatId).toBe("unknown");
  });

  it("четыре урока в порядке по дате, а не по массиву", () => {
    expect(result.lessons.map((l) => l.messageId)).toEqual([10, 21, 30, 40]);
  });

  it("урок 1: подпись-массив, фото и рецепт в окне, стикер/голосовое пропущены", () => {
    const l = result.lessons[0];
    expect(l.number).toBe(1);
    expect(l.title).toBe("Наполеон");
    expect(l.recipeText).toBe("Тесто: мука 500 г\n\n1. Взбить яйца\n2. Добавить муку\n3. Выпекать 20 минут");
    expect(l.videoFile).toBe("video_files/napoleon.mp4");
    expect(l.mimeType).toBe("video/mp4");
    expect(l.durationSec).toBe(1200);
    expect(l.width).toBe(1280);
    expect(l.height).toBe(720);
    expect(l.photoFiles).toEqual(["photos/photo_1.jpg", "photos/photo_2.jpg"]);
    expect(l.attachedMessageIds).toEqual([10, 11, 12, 14]);
    expect(l.warnings).toEqual([]);
    expect(l.chatId).toBe("-1001234567890");
    expect(l.date).toBe(at("10:00"));
  });

  it("урок 2: заголовок «Дарси 2» перед видео без подписи, фото после", () => {
    const l = result.lessons[1];
    expect(l.number).toBe(2);
    expect(l.title).toBe("Медовик");
    expect(l.recipeText).toBe("");
    expect(l.attachedMessageIds).toEqual([21, 20, 22]);
    expect(l.photoFiles).toEqual(["photos/photo_3.jpg"]);
    expect(l.warnings).toEqual([]);
  });

  it("урок 3: видео по mime_type без подписи — порядковый номер, придуманное название, предупреждение", () => {
    const l = result.lessons[2];
    expect(l.number).toBe(3);
    expect(l.title).toBe("Урок 3");
    expect(l.mimeType).toBe("video/quicktime");
    expect(l.durationSec).toBeNull();
    expect(l.width).toBeNull();
    expect(l.attachedMessageIds).toEqual([30]);
    expect(l.warnings).toContain("нет подписи — название придумано");
  });

  it("урок 4: дубликат явного номера — предупреждение, номер сохранён", () => {
    const l = result.lessons[3];
    expect(l.number).toBe(2);
    expect(l.title).toBe("Эклеры");
    expect(l.warnings).toHaveLength(1);
    expect(l.warnings[0]).toMatch(/номер 2/);
    expect(l.warnings[0]).toMatch(/Медовик/);
  });

  it("пропущенные — с причинами", () => {
    const byId = Object.fromEntries(result.skipped.map((s) => [s.messageId, s.reason]));
    expect(byId).toEqual({
      1: "служебное сообщение",
      5: "текст без видео",
      13: "стикер",
      15: "голосовое сообщение",
      16: "текст без видео",
    });
  });

  it("окно настраивается: 120 минут — текст 11:30 прикрепляется к уроку 1", () => {
    const wide = parseTelegramExport(fixture, { attachWindowMin: 120 });
    expect(wide.lessons[0].attachedMessageIds).toEqual([10, 11, 12, 14, 16]);
    expect(wide.lessons[0].recipeText.endsWith("\n\nВсем спасибо за урок")).toBe(true);
    expect(wide.skipped.find((s) => s.messageId === 16)).toBeUndefined();
  });

  it("ответ на сообщение урока прикрепляется даже за окном", () => {
    const r = parseTelegramExport({
      id: 1,
      messages: [
        { id: 1, type: "message", date: at("10:00"), text: "Урок 1. Тарт", file: "v.mp4", media_type: "video_file" },
        { id: 2, type: "message", date: at("18:00"), text: "Добавка к рецепту", reply_to_message_id: 1 },
      ],
    });
    expect(r.lessons[0].attachedMessageIds).toEqual([1, 2]);
    expect(r.lessons[0].recipeText).toBe("Добавка к рецепту");
  });

  it("название обрезается до 200 символов и схлопывает пробелы", () => {
    const r = parseTelegramExport({
      id: 1,
      messages: [{ id: 1, type: "message", date: at("10:00"), text: `Урок 1.   ${"а".repeat(300)}`, file: "v.mp4", media_type: "video_file" }],
    });
    expect(r.lessons[0].title).toHaveLength(200);
    expect(r.lessons[0].title).toBe("а".repeat(200));
  });

  it("у видео своя подпись, а перед ним чужой заголовок — верим подписи, предупреждаем", () => {
    const r = parseTelegramExport({
      id: 1,
      messages: [
        { id: 1, type: "message", date: at("10:00"), text: "Урок 5 — Павлова" },
        { id: 2, type: "message", date: at("10:01"), text: "Урок 6. Брауни", file: "v.mp4", media_type: "video_file" },
      ],
    });
    expect(r.lessons[0].title).toBe("Брауни");
    expect(r.lessons[0].number).toBe(6);
    expect(r.lessons[0].attachedMessageIds).toEqual([2, 1]);
    expect(r.lessons[0].warnings[0]).toMatch(/Павлова/);
  });

  it("заголовок без видео в конце — в пропущенные", () => {
    const r = parseTelegramExport({
      id: 1,
      messages: [
        { id: 1, type: "message", date: at("10:00"), text: "Урок 1. Тарт", file: "v.mp4", media_type: "video_file" },
        { id: 2, type: "message", date: at("10:05"), text: "Урок 2. Обещанный" },
      ],
    });
    expect(r.lessons).toHaveLength(1);
    expect(r.skipped).toEqual([{ messageId: 2, reason: "заголовок без видео" }]);
  });

  it("видео без файла (лимит экспорта) — пропущено с понятной причиной", () => {
    const r = parseTelegramExport({
      id: 1,
      messages: [{ id: 1, type: "message", date: at("10:00"), text: "Урок 1", media_type: "video_file" }],
    });
    expect(r.lessons).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/лимит/);
  });
});
