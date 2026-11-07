import { describe, expect, it } from "vitest";
import { renderCatalogFragment, renderCatalogUnavailable } from "../../src/site/catalogFragment.js";

const catalog = () => ({
  courses: [
    { code: "COURSE50", title: "Арт-десерты (81 сомони)", description: "Практика", price: 81, currency: "TJS", coverUrl: null, lessonsCount: 10, durationMin: 90 },
    { code: "COURSE70", title: "21 рецепт", description: null, price: 113, currency: "TJS", coverUrl: null, lessonsCount: 21, durationMin: 180 },
  ],
  bundle: { price: 177, fullPrice: 194 },
  contacts: { whatsapp: "https://wa.me/992905355355" },
});

describe("server catalogue HTML", () => {
  it("uses actual catalogue prices, normalises titles and keeps manual purchase instructions", () => {
    const html = renderCatalogFragment(catalog(), "ru");
    expect(html).toContain('data-server-catalog="ready"');
    for (const price of [81, 113, 177, 194]) expect(html).toContain(`${price} сомони`);
    expect(html).not.toContain("Арт-десерты (81 сомони)");
    expect(html).toContain("После ручной проверки оплаты");
    expect(html).not.toContain("<script");
    expect(html).toContain("21 видеоурок");
    expect(html).toContain("1 ч 30 мин видео");
    expect(html).toContain("выгода 17 сомони");
    expect(html).toContain("course-course50-sm.webp 800w");
    expect(html).toContain('aria-label="Купить курс «21 рецепт» в WhatsApp"');
  });

  it("localises Tajik and filters a course without advertising the bundle", () => {
    const html = renderCatalogFragment(catalog(), "tg", "COURSE70");
    expect(html).toContain('lang="tg"');
    expect(html).toContain("21 навъи ширинӣ");
    expect(html).toContain("113 сомонӣ");
    expect(html).not.toContain("81 сомонӣ");
    expect(html).not.toContain("177 сомонӣ");
    expect(html).not.toContain("Оба курса");
  });

  it("escapes database HTML, attributes and SSI directives, rejects unsafe URL schemes", () => {
    const data = catalog();
    data.courses[0].title = '<img src=x onerror="alert(1)">';
    data.courses[0].description = '<!--# include virtual="/admin" -->';
    const withCover = { ...data, courses: data.courses.map((c) => ({ ...c, coverUrl: 'javascript:alert(1)' })) };
    withCover.contacts.whatsapp = 'javascript:alert(1)';
    const html = renderCatalogFragment(withCover, "ru");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;!--# include");
    expect(html).not.toContain("<!--#");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("https://api.whatsapp.com/send?phone=992905355355&amp;text=");
  });

  it("does not resurrect missing courses or show a bundle for one available course", () => {
    const data = catalog();
    data.courses = data.courses.slice(0, 1);
    expect(renderCatalogFragment(data, "ru")).not.toContain("177 сомони");
    const missing = renderCatalogFragment(data, "ru", "COURSE70");
    expect(missing).toContain("Курсы сейчас недоступны");
    expect(missing).not.toContain('class="price');
  });

  it("renders lesson names in crawlable cards and escapes them", () => {
    const data = catalog();
    const withLessons = { ...data, courses: data.courses.map(c => ({ ...c, lessonTitles: ["Эклер", "<script>bad</script>"] })) };
    const html = renderCatalogFragment(withLessons, "ru");
    expect(html).toContain("Эклер");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("<script>bad");
    expect(html).toContain('class="course-syllabus"');
  });

  it.each(["ru", "tg"] as const)("failure fallback has a safe contact but no price: %s", (lang) => {
    const html = renderCatalogUnavailable(lang);
    expect(html).toContain('data-server-catalog="unavailable"');
    expect(html).toContain("api.whatsapp.com");
    expect(html).not.toContain('class="price');
  });
});
