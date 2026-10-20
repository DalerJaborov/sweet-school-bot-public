import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  detectParseMode,
  parseTelegramExport,
  readExportJson,
  resolveVideoFiles,
  titleFromFileName,
  type FolderVideo,
  type TgExport,
} from "../../src/course/tgExport.js";

/**
 * Фикстура — обрезанный НАСТОЯЩИЙ экспорт канала школы (04.09.2026): карточка,
 * тизер и урок уходят одной секундой, подписей нет, 31 видео из 37 не
 * выгружено из-за лимита размера (в `file` — заглушка «File exceeds…»),
 * три урока по 742 секунды, один файл в папке оборван (нет moov atom).
 */
const fixture = JSON.parse(
  fs.readFileSync(new URL("../fixtures/tgChannelExport.json", import.meta.url), "utf8")
) as TgExport;

/** Папка video_files/ — то, что показал ffprobe на реальных файлах. */
const folder: FolderVideo[] = [
  vid("video_files/1224.mp4", 12.84, 720, 1280),
  vid("video_files/1224 (1).mp4", 13.0, 720, 1280),
  vid("video_files/1224 (1)(2).mp4", 15.19, 720, 1280),
  vid("video_files/Банан.mp4", 1175.72, 720, 1280),
  vid("video_files/Орео.mp4", 962.07, 720, 1280),
  vid("video_files/Творожный пирог.mp4", 1240.9, 720, 1280),
  vid("video_files/Дубайский чизкейк.mp4", 742.13, 720, 1280),
  vid("video_files/Меренгевый рулет.mp4", 742.25, 720, 1280),
  vid("video_files/Эклеры.mp4", 742.27, 720, 1280),
  vid("video_files/Дубайский чизкейк-копия(1).mp4", 8.64, 1080, 1920),
  vid("video_files/0103.mp4", 10.68, 1080, 1920),
  vid("video_files/0115.mp4", 10.77, 1080, 1920),
  vid("video_files/клубника тизер.mp4", 10.22, 1080, 1920),
  { file: "video_files/клубника в шоколаде.mp4", sizeBytes: 79_167_488, durationSec: null, width: null, height: null, broken: true },
];

function vid(file: string, durationSec: number, width: number, height: number): FolderVideo {
  return { file, sizeBytes: Math.round(durationSec * 330_000), durationSec, width, height, broken: false };
}

describe("titleFromFileName — имя файла → название", () => {
  it.each([
    ["video_files/Творожный пирог.mp4", "Творожный пирог"],
    ["video_files/Пирожное сникерс 5 сек.mp4", "Пирожное сникерс"],
    ["video_files/Дубайский чизкейк-копия(1).mp4", "Дубайский чизкейк"],
    ["video_files/Фисташка1.mp4", "Фисташка"],
    ["video_files/Анна павлова(1).mp4", "Анна павлова"],
    ["video_files/клубника в шоколаде.mp4", "Клубника в шоколаде"],
    ["video_files/Чизкейк_Тортики.MOV", "Чизкейк Тортики"],
  ])("%s → «%s»", (file, title) => {
    expect(titleFromFileName(file)).toBe(title);
  });

  it.each([["video_files/1224 (1).mp4"], ["video_files/0101.mp4"], ["video_files/VID_20250101.mp4"], ["video_files/video.mp4"]])(
    "%s — названия нет",
    (file) => {
      expect(titleFromFileName(file)).toBe("");
    }
  );
});

describe("канальный режим: карточка + тизер + урок", () => {
  const parsed = parseTelegramExport(fixture, { mode: "channel" });

  it("режим по типу чата: канал", () => {
    expect(detectParseMode(fixture)).toBe("channel");
    expect(detectParseMode({ type: "private_supergroup" })).toBe("caption");
    expect(parsed.mode).toBe("channel");
    expect(parsed.chatId).toBe("3336347353");
  });

  it("уроки — только полные видео (≥ 60 с), по порядку", () => {
    expect(parsed.lessons.map((l) => l.messageId)).toEqual([29, 32, 35, 47, 50, 71, 89]);
    expect(parsed.lessons.map((l) => l.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("невыгруженное видео — всё равно урок, без файла и без выдуманного предупреждения", () => {
    const l = parsed.lessons[0];
    expect(l.videoFile).toBe("");
    expect(l.durationSec).toBe(1175);
    expect(l.width).toBe(720);
    expect(l.height).toBe(1280);
    expect(l.title).toBe("Урок 1");
    expect(l.titleSource).toBe("generated");
    expect(l.warnings).not.toContain(expect.stringMatching(/придумано/));
  });

  it("две карточки перед видео — обе карточки, тизера нет — предупреждение", () => {
    const l = parsed.lessons[0];
    expect(l.cardPhotos).toEqual(["photos/photo_14@24-12-2025_14-35-05.jpg", "photos/photo_15@24-12-2025_14-35-05.jpg"]);
    expect(l.photoFiles).toEqual(l.cardPhotos);
    expect(l.teaserMessageId).toBeNull();
    expect(l.warnings).toContain("нет тизера");
    expect(l.attachedMessageIds).toEqual([29, 27, 28]);
  });

  it("выгруженный тизер прикрепляется к своему уроку", () => {
    const l = parsed.lessons[1];
    expect(l.teaserMessageId).toBe(31);
    expect(l.teaserFile).toBe("video_files/1224.mp4");
    expect(l.teaserDurationSec).toBe(12);
    expect(l.cardPhotos).toEqual(["photos/photo_16@24-12-2025_17-53-51.jpg"]);
    expect(l.warnings).toEqual([]);
  });

  it("невыгруженный тизер: сообщение есть, файла нет", () => {
    const l = parsed.lessons[5];
    expect(l.messageId).toBe(71);
    expect(l.teaserMessageId).toBe(70);
    expect(l.teaserFile).toBeNull();
  });

  it("вступление: приветствие, инструменты и закреп после последнего урока — не уроки", () => {
    expect(parsed.intro.map((p) => p.messageId)).toEqual([7, 15, 16, 90, 101]);
    expect(parsed.intro[0].kind).toBe("photo");
    expect(parsed.intro[0].text).toMatch(/^👋🏻🥰Салом духтарон!/);
    const byId = Object.fromEntries(parsed.skipped.map((s) => [s.messageId, s.reason]));
    expect(byId[90]).toMatch(/вступление/);
    expect(byId[1]).toBe("служебное сообщение");
    // Закреп «Сабти сертификат» через 8 минут после урока НЕ стал его названием.
    expect(parsed.lessons[6].title).toBe("Урок 7");
    expect(parsed.lessons[6].cardPhotos).toEqual(["photos/photo_39@28-01-2026_03-19-12.jpg"]);
  });

  it("видео между 40 и 60 с — ни тизер, ни урок", () => {
    const odd: TgExport = {
      type: "private_channel",
      messages: [
        { id: 1, type: "message", date: "2026-01-01T10:00:00", file: "video_files/a.mp4", media_type: "video_file", duration_seconds: 50 },
      ],
    };
    const r = parseTelegramExport(odd, { mode: "channel" });
    expect(r.lessons).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/50 с/);
  });

  it("подпись с «Дарси N» даёт номер и название, повтор названия — предупреждение", () => {
    const withText: TgExport = {
      type: "private_channel",
      messages: [
        { id: 1, type: "message", date: "2026-01-01T10:00:00", text: "Дарси 3\nТворожный пирог", photo: "photos/a.jpg" },
        { id: 2, type: "message", date: "2026-01-01T10:00:01", file: "video_files/Творожный пирог.mp4", media_type: "video_file", duration_seconds: 1240 },
        { id: 3, type: "message", date: "2026-01-01T12:00:00", file: "video_files/Творожный пирог(1).mp4", media_type: "video_file", duration_seconds: 900 },
      ],
    };
    const r = parseTelegramExport(withText, { mode: "channel" });
    expect(r.lessons[0].number).toBe(3);
    expect(r.lessons[0].title).toBe("Творожный пирог");
    expect(r.lessons[0].titleSource).toBe("header");
    expect(r.lessons[1].titleSource).toBe("filename");
    expect(r.lessons[1].warnings).toContain("название повторяется — такое же у урока 3");
  });

  it("старый режим по умолчанию: заглушку «File exceeds…» считает невыгруженным видео", () => {
    const r = parseTelegramExport(fixture);
    expect(r.mode).toBe("caption");
    expect(r.lessons.map((l) => l.messageId)).toEqual([31, 34, 46]);
    expect(r.skipped.find((s) => s.messageId === 29)?.reason).toMatch(/не выгружено/);
  });
});

describe("resolveVideoFiles — подбор файлов по длительности", () => {
  const parsed = parseTelegramExport(fixture, { mode: "channel" });
  const resolved = resolveVideoFiles(parsed.lessons, folder);
  const byId = Object.fromEntries(resolved.map((l) => [l.messageId, l]));

  it("однозначные по длительности — подобраны, название из имени файла", () => {
    expect(byId[29].video.status).toBe("resolved");
    expect(byId[29].videoFile).toBe("video_files/Банан.mp4");
    expect(byId[29].title).toBe("Банан");
    expect(byId[29].titleSource).toBe("filename");
    expect(byId[32].videoFile).toBe("video_files/Орео.mp4");
    expect(byId[35].videoFile).toBe("video_files/Творожный пирог.mp4");
    expect(byId[35].video.sizeBytes).toBeGreaterThan(0);
  });

  it("три урока по 742 с: тизер «Дубайский чизкейк-копия(1)» подсказывает свой урок, остальные — на выбор", () => {
    expect(byId[71].teaser?.status).toBe("resolved");
    expect(byId[71].teaserFile).toBe("video_files/Дубайский чизкейк-копия(1).mp4");
    expect(byId[71].videoFile).toBe("video_files/Дубайский чизкейк.mp4");
    expect(byId[71].title).toBe("Дубайский чизкейк");

    for (const id of [47, 50]) {
      expect(byId[id].video.status).toBe("ambiguous");
      expect(byId[id].videoFile).toBe("");
      expect(byId[id].video.candidates).toEqual(["video_files/Меренгевый рулет.mp4", "video_files/Эклеры.mp4"]);
      expect(byId[id].warnings).toContain("название появится, когда выберете файл");
    }
  });

  it("выгруженный файл — «exported», повреждённый в папке не кандидат, без файла — «missing» с подсказкой", () => {
    expect(byId[32].teaser?.status).toBe("exported");
    expect(byId[32].teaser?.file).toBe("video_files/1224.mp4");
    expect(byId[89].video.status).toBe("missing");
    expect(byId[89].video.note).toMatch(/увеличьте лимит размера/);
    expect(byId[89].teaser?.status).toBe("ambiguous");
    expect(byId[89].teaser?.candidates).toHaveLength(3);
  });

  it("выгруженный, но оборванный файл — «broken»", () => {
    const lessons = parseTelegramExport(
      {
        type: "private_channel",
        messages: [
          { id: 1, type: "message", date: "2026-01-01T10:00:00", file: "video_files/клубника в шоколаде.mp4", media_type: "video_file", duration_seconds: 459 },
        ],
      },
      { mode: "channel" }
    ).lessons;
    const [l] = resolveVideoFiles(lessons, folder);
    expect(l.video.status).toBe("broken");
    expect(l.video.note).toMatch(/moov/);
    expect(l.title).toBe("Клубника в шоколаде");
  });
});

describe("resolveVideoFiles — выбор владельца применяется ДО подбора (запуск импорта)", () => {
  const parsed = parseTelegramExport(fixture, { mode: "channel" });

  it("панель не прислала videoFile — урок с заглушкой «File exceeds…» берёт файл, подобранный предпросмотром", () => {
    // Так запуск и зовёт подбор: у всех уроков videoFile null (ничего не выбирали).
    const overrides = new Map(parsed.lessons.map((l) => [l.messageId, { videoFile: null, teaserFile: null }]));
    const byId = Object.fromEntries(resolveVideoFiles(parsed.lessons, folder, overrides).map((l) => [l.messageId, l]));
    expect(parsed.lessons[0].videoFile).toBe("");
    expect(byId[29].videoFile).toBe("video_files/Банан.mp4");
    expect(byId[29].video.status).toBe("resolved");
    expect(byId[71].videoFile).toBe("video_files/Дубайский чизкейк.mp4");
    expect(byId[71].teaserFile).toBe("video_files/Дубайский чизкейк-копия(1).mp4");
    // Без выбора два урока по 742 с так и остаются неоднозначными — файла нет, запуск честно упадёт на них.
    expect(byId[47].videoFile).toBe("");
    expect(byId[50].videoFile).toBe("");
  });

  it("выбор одного из двух неоднозначных снимает файл с соседа — второй подбирается сам", () => {
    const overrides = new Map([[47, { videoFile: "video_files/Меренгевый рулет.mp4", teaserFile: null }]]);
    const byId = Object.fromEntries(resolveVideoFiles(parsed.lessons, folder, overrides).map((l) => [l.messageId, l]));
    expect(byId[47].video.status).toBe("resolved");
    expect(byId[47].videoFile).toBe("video_files/Меренгевый рулет.mp4");
    expect(byId[47].title).toBe("Меренгевый рулет");
    expect(byId[50].video.status).toBe("resolved");
    expect(byId[50].videoFile).toBe("video_files/Эклеры.mp4");
    expect(byId[50].title).toBe("Эклеры");
    // Урок с подсказкой из тизера не пострадал.
    expect(byId[71].videoFile).toBe("video_files/Дубайский чизкейк.mp4");
  });

  it("выбранный тизер тоже занят; выбор файла, которого нет в папке, — как без выбора", () => {
    const overrides = new Map([
      [89, { videoFile: "video_files/нет-такого.mp4", teaserFile: "video_files/0103.mp4" }],
    ]);
    const byId = Object.fromEntries(resolveVideoFiles(parsed.lessons, folder, overrides).map((l) => [l.messageId, l]));
    expect(byId[89].teaser?.status).toBe("resolved");
    expect(byId[89].teaserFile).toBe("video_files/0103.mp4");
    expect(byId[89].video.status).toBe("missing");
    // Повреждённый файл выбрать нельзя — остаётся обычный подбор.
    const broken = new Map([[29, { videoFile: "video_files/клубника в шоколаде.mp4", teaserFile: null }]]);
    expect(resolveVideoFiles(parsed.lessons, folder, broken)[0].videoFile).toBe("video_files/Банан.mp4");
  });
});

describe("readExportJson — оборванный result.json", () => {
  const full = JSON.stringify(fixture, null, 1);

  it("целый файл — как есть", () => {
    const r = readExportJson(full);
    expect(r.truncated).toBe(false);
    expect(r.recovered).toBe(fixture.messages.length);
  });

  it("обрезанный посреди сообщения — целые сообщения до обрыва, имя и тип чата сохранены", () => {
    const cut = full.indexOf('"id": 47');
    const r = readExportJson(full.slice(0, cut + 40));
    expect(r.truncated).toBe(true);
    expect(r.json.name).toBe(fixture.name);
    expect(r.json.type).toBe("private_channel");
    expect(r.json.id).toBe(fixture.id);
    expect(r.recovered).toBeGreaterThan(5);
    expect(r.json.messages.at(-1)?.id).toBe(46);
    expect(parseTelegramExport(r.json, { mode: "channel" }).lessons.map((l) => l.messageId)).toEqual([29, 32, 35]);
  });

  it("не экспорт вовсе — ошибка", () => {
    expect(() => readExportJson("{ \"hello\": ")).toThrow(/messages/);
  });
});
