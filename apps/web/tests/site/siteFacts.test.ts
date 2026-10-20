import { describe, it, expect } from "vitest";
// @ts-expect-error — генератор на чистом ESM без типов; в тесте важен результат, не сигнатуры.
import { loadContent, renderSite } from "../../scripts/build-site-pages.mjs";

/**
 * ФАКТЫ, ПО КОТОРЫМ САЙТ, БОТ И ПРИЛОЖЕНИЕ ОБЯЗАНЫ ГОВОРИТЬ ОДНО (решения
 * владельца 05.09.2026). Ревью нашло три версии условия сертификата. Здесь —
 * только та часть, что живёт в статике сайта; бот проверяется в apps/api
 * (tests/unit/prices.test.ts), приложение — по строкам i18n.
 */
const files: Map<string, string> = renderSite(loadContent(), new Date("2026-09-05T00:00:00Z"));
const pages = [...files.entries()].filter(([f]) => f.endsWith(".html") && f !== "404.html");

describe("Единые факты на страницах сайта", () => {
  it.each(pages)("%s: сертификат — без «фото десертов», без «5 фото»", (_file, body) => {
    expect(body).not.toMatch(/фото\s+5|5\s+фото|акси\s+5|кто действительно готовил|дар ҳақиқат пухтаанд/i);
  });

  it("сертификат: за просмотр всех уроков — на страницах сертификата и онлайн-курса, RU и TG", () => {
    expect(files.get("sertifikat.html")).toContain("все уроки курса просмотрены");
    expect(files.get("online-kurs.html")).toContain("все уроки курса просмотрены");
    expect(files.get("tg/sertifikat.html")).toContain("ҳамаи дарсҳои курс тамошо шуданд");
    expect(files.get("tg/online-kurs.html")).toContain("ҳамаи дарсҳои курс тамошо шуданд");
  });

  it("оплата: банки как у бота (Алиф или Душанбе Сити), имя на карте на сайте не упоминается, RU и TG", () => {
    const ru = files.get("faq.html")!;
    const tg = files.get("tg/faq.html")!;
    expect(ru).toContain("Алиф или Душанбе Сити");
    expect(ru).toContain("905 355 355");
    expect(ru).not.toContain("Фарангис"); // имя на карте — только если спросят у бота (владелец 05.09)
    expect(tg).toContain("Алиф ё Душанбе Сити");
    expect(tg).not.toContain("Фарангис");
    expect(ru).not.toMatch(/сестр/i);
    expect(tg).not.toMatch(/хоҳар/i);
    for (const [, body] of pages) expect(body).not.toMatch(/Эсхата/);
  });

  it("офлайн: дата набора не зашита в статику — только из API через островок формы", () => {
    for (const [, body] of pages) {
      expect(body).not.toMatch(/\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|январ|феврал|апрел|июн|июл|сентябр|октябр|ноябр|декабр)\b/i);
    }
    expect(files.get("site.html")).toContain('id="offline-form-island"');
    expect(files.get("kursy-konditera-dushanbe.html")).toContain('id="offline-form-island"');
  });
});
