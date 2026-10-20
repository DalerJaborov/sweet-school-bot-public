import sharp from "sharp";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import {
  courseCompleted,
  formatIssueDate,
  certificateFileName,
  renderCertificate,
  renderCertificatePng,
  certificatePngFileName,
  verificationUrl,
  verifyCertificateNumber,
  CERTIFICATE_PNG_SIZE,
} from "../../src/course/certificate.js";

let db: PrismaMock;
beforeEach(() => {
  db = mockPrisma();
});
afterEach(restorePrisma);

describe("Сертификат", () => {
  it("положен только когда досмотрены ВСЕ готовые уроки курса", async () => {
    db.model("lesson").findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    db.model("progress").count.mockResolvedValue(2);
    expect(await courseCompleted("p1", "c1")).toEqual({ done: 2, total: 3 });
    db.model("progress").count.mockResolvedValue(3);
    expect(await courseCompleted("p1", "c1")).toEqual({ done: 3, total: 3 });
  });

  it("курс без готовых уроков сертификата не даёт — нечего проходить", async () => {
    db.model("lesson").findMany.mockResolvedValue([]);
    expect(await courseCompleted("p1", "c1")).toEqual({ done: 0, total: 0 });
  });

  it("дата на двух языках", () => {
    const d = new Date(2026, 8, 3);
    expect(formatIssueDate(d, "ru")).toBe("3 сентября 2026");
    expect(formatIssueDate(d, "tg")).toBe("3 сентябр 2026");
  });

  it("имя файла — латиница и номер: мессенджеры с кириллицей в имени файла ладят плохо", () => {
    expect(certificateFileName(12, "tg")).toBe("shirin-sweets-certificate-tg-12.pdf");
  });

  it("PDF собирается из шаблона и содержит таджикские буквы имени", async () => {
    const pdf = await renderCertificate({ fullName: "Ҷаборова Малика Абдуллоевна", issuedAt: new Date(2026, 8, 3), lang: "tg" });
    expect(pdf.length).toBeGreaterThan(1_000_000); // шаблон владельца — тяжёлый, это норма
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  }, 30_000);
});

/**
 * PNG ДЛЯ ШАРИНГА (визуальная система 04.09.2026 §6). Рисуется @napi-rs/canvas
 * тем же приёмом, что обложки уроков (см. storage/coverArt.ts) — pdf-lib не
 * умеет отдавать растр, поэтому «тот же путь» здесь означает тот же инструмент
 * и тот же гарантированно таджикский шрифт, а не общий код с PDF.
 */
describe("renderCertificatePng", () => {
  it("рендерит 1080×1350 PNG с таджикским именем", async () => {
    const png = await renderCertificatePng({
      fullName: "Ҷаборова Малика Абдуллоевна",
      courseTitle: "Арт-десерты ӣӯҳқҷғ",
      issuedAt: new Date(2026, 8, 3),
      lang: "tg",
      number: 12,
    });
    expect(png[0]).toBe(0x89); // сигнатура PNG: 89 50 4E 47 ...
    expect(png[1]).toBe(0x50);
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(CERTIFICATE_PNG_SIZE.width);
    expect(meta.height).toBe(CERTIFICATE_PNG_SIZE.height);
  }, 30_000);

  it("рендерит и для длинного русского имени/названия курса, не падая", async () => {
    const png = await renderCertificatePng({
      fullName: "Александра Владимировна Костромина-Заречная",
      courseTitle: "Тути фаранг дар шоколад — чизкейк «Дубайский шоколад» бо фисташка",
      issuedAt: new Date(2026, 0, 15),
      lang: "ru",
      number: 1,
    });
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(CERTIFICATE_PNG_SIZE.width);
    expect(meta.height).toBe(CERTIFICATE_PNG_SIZE.height);
  }, 30_000);

  it("не однотонная картинка — портрет, плашка и текст действительно нарисованы", async () => {
    const png = await renderCertificatePng({
      fullName: "Мадина Рахимова",
      courseTitle: "Наполеон",
      issuedAt: new Date(2026, 8, 3),
      lang: "ru",
      number: 3,
    });
    const stats = await sharp(png).stats();
    expect(stats.channels[0].stdev).toBeGreaterThan(5);
  }, 30_000);

  it("имя файла PNG — латиница, номер и расширение .png", () => {
    expect(certificatePngFileName(12, "tg")).toBe("shirin-sweets-certificate-tg-12.png");
  });

  it("адрес проверки — тот же номер, что в имени файла", () => {
    expect(verificationUrl(12)).toMatch(/\/api\/course\/certificate\/verify\/12$/);
  });
});

describe("verifyCertificateNumber", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("настоящий номер — имя, курс и дата, БЕЗ контактов ученицы", async () => {
    db.model("certificate").findFirst.mockResolvedValue({
      fullName: "Мадина Рахимова",
      lang: "tg",
      issuedAt: new Date(2026, 8, 3),
      course: { title: "Арт-десерты" },
    });
    const result = await verifyCertificateNumber(7);
    expect(result).toEqual({
      found: true,
      fullName: "Мадина Рахимова",
      courseTitle: "Арт-десерты",
      issuedAt: new Date(2026, 8, 3).toISOString(),
      lang: "tg",
    });
    // Контактных полей в ответе нет вовсе — не только не заполнены.
    expect(result).not.toHaveProperty("contactId");
    expect(result).not.toHaveProperty("phone");
  });

  it("несуществующий, но правильно оформленный номер — идёт в базу и получает found: false", async () => {
    db.model("certificate").findFirst.mockResolvedValue(null);
    expect(await verifyCertificateNumber(999)).toEqual({ found: false });
    expect(db.model("certificate").findFirst).toHaveBeenCalledTimes(1);
  });

  it("дробные/отрицательные/NaN — found: false БЕЗ похода в базу (мусорный ввод)", async () => {
    db.model("certificate").findFirst.mockResolvedValue(null);
    expect(await verifyCertificateNumber(0)).toEqual({ found: false });
    expect(await verifyCertificateNumber(-1)).toEqual({ found: false });
    expect(await verifyCertificateNumber(1.5)).toEqual({ found: false });
    expect(await verifyCertificateNumber(NaN)).toEqual({ found: false });
    expect(db.model("certificate").findFirst).not.toHaveBeenCalled();
  });

  it("лишний lang в базе (не ru/tg) — трактуется как ru, а не падает", async () => {
    db.model("certificate").findFirst.mockResolvedValue({
      fullName: "Х",
      lang: "en",
      issuedAt: new Date(2026, 0, 1),
      course: { title: "Y" },
    });
    const result = await verifyCertificateNumber(1);
    expect(result.found && result.lang).toBe("ru");
  });
});
