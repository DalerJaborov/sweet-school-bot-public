/** Cookie-free HTML representation of the same public catalogue as /courses.
 * Prices and availability come exclusively from that catalogue, never a second
 * price table. Escape every database value, including attribute values. */
// Only dependency: prices.ts (itself dependency-free) — the SSI fixture loads compiled dist directly.
import { COURSE_TITLE_TG } from "../prices.js";

type Lang = "ru" | "tg";
type Course = {
  code: string; title: string; description: string | null; price: number;
  lessonTitles?: string[];
  currency: string; coverUrl: string | null; lessonsCount: number; durationMin: number;
};
type Catalog = {
  courses: Course[];
  bundle: { price: number; fullPrice: number } | null;
  contacts: { whatsapp: string };
};

function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function whatsapp(contact: string, text: string): string {
  let digits = "992905355355";
  try {
    const url = new URL(contact);
    const candidate = url.hostname === "wa.me" ? url.pathname.slice(1) : url.searchParams.get("phone") ?? "";
    if (url.protocol === "https:" && ["wa.me", "api.whatsapp.com"].includes(url.hostname) && /^\d{9,15}$/.test(candidate)) digits = candidate;
  } catch { /* Safe public contact fallback; no arbitrary URL schemes. */ }
  return `https://api.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(text)}`;
}

function coverUrl(course: Course): string | null {
  const raw = course.coverUrl;
  if (raw) {
    if (/^\/(?!\/)/.test(raw) && !/[\\\r\n]/.test(raw)) return raw;
    try { const url = new URL(raw); if (url.protocol === "https:") return url.href; } catch { /* ignore invalid cover */ }
  }
  return ({ COURSE50: "/img/covers/course-course50.webp", COURSE70: "/img/covers/course-course70.webp" } as Record<string, string>)[course.code] ?? null;
}

function title(course: Course, lang: Lang): string {
  if (lang === "tg") {
    const translated = (COURSE_TITLE_TG as Record<string, string>)[course.code];
    if (translated) return translated;
  }
  return course.title.replace(/\s*\(\s*\d[\d\s.,]*\s*[^)]*\)\s*$/u, "").trim() || course.title;
}

function lessonsLabel(n: number, lang: Lang): string {
  if (lang === "tg") return `${n} видеодарс`;
  const lastTwo = n % 100;
  const word = lastTwo >= 11 && lastTwo <= 14 ? "видеоуроков" : n % 10 === 1 ? "видеоурок" : n % 10 >= 2 && n % 10 <= 4 ? "видеоурока" : "видеоуроков";
  return `${n} ${word}`;
}

function durationLabel(min: number, lang: Lang): string {
  if (lang === "tg") return min < 60 ? `${min} дақиқа видео` : `${Math.floor(min / 60)} соат${min % 60 ? ` ${min % 60} дақиқа` : ""} видео`;
  return min < 60 ? `${min} мин видео` : `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ""} видео`;
}

const text = {
  ru: {
    currency: "сомони", buy: "Оформить в WhatsApp", contact: "Спросить в WhatsApp",
    empty: "Курсы сейчас недоступны. Уточните программу и цену в WhatsApp.",
    unavailable: "Не удалось загрузить курсы. Уточните программу и цену в WhatsApp.",
    bundle: "Оба курса вместе", forever: "навсегда", certificate: "сертификат",
    purchase: "Как купить курс",
    steps: ["Выберите курс и напишите Ширин в WhatsApp.", "Уточните сумму и способ оплаты у Ширин перед переводом.", "После ручной проверки оплаты Ширин поможет открыть ваши уроки."],
    note: "Здесь нет автоматического приёма чеков. Заказ и доступ подтверждает человек в WhatsApp; мгновенный ответ не гарантируется.",
    order: (name: string, amount: string) => `Здравствуйте! Хочу купить ${name}. На сайте указана цена ${amount}. Подтвердите, пожалуйста, состав, сумму, способ оплаты и как я получу доступ к урокам.`,
    ask: "Здравствуйте! Хочу уточнить программу и цену онлайн-курса.",
  },
  tg: {
    currency: "сомонӣ", buy: "Фармоиш дар WhatsApp", contact: "Дар WhatsApp пурсидан",
    empty: "Курсҳо ҳоло дастрас нестанд. Барнома ва нархро дар WhatsApp пурсед.",
    unavailable: "Курсҳо бор нашуданд. Барнома ва нархро дар WhatsApp пурсед.",
    bundle: "Ҳар ду курс якҷоя", forever: "барои ҳамеша", certificate: "сертификат",
    purchase: "Курсро чӣ тавр харидан мумкин аст",
    steps: ["Курсро интихоб кунед ва ба Ширин дар WhatsApp нависед.", "Пеш аз интиқол маблағ ва тарзи пардохтро бо Ширин аниқ кунед.", "Пас аз санҷиши пардохт Ширин барои кушодани дарсҳо кӯмак мекунад."],
    note: "Дар ин ҷо чекҳо ба таври автоматӣ қабул намешаванд. Фармоиш ва дастрасиро шахс дар WhatsApp тасдиқ мекунад; ҷавоби фаврӣ кафолат дода намешавад.",
    order: (name: string, amount: string) => `Ассалому алейкум! Мехоҳам ${name}-ро харам. Нарх дар сайт ${amount} аст. Лутфан таркиб, маблағ, тарзи пардохт ва чӣ тавр ба дарсҳо дастрасӣ мегирам, тасдиқ кунед.`,
    ask: "Ассалому алейкум! Мехоҳам барнома ва нархи курси онлайнро аниқ кунам.",
  },
};

export function renderCatalogUnavailable(lang: Lang): string {
  const t = text[lang];
  return `<div data-server-catalog="unavailable" lang="${lang}" class="notice"><p>${t.unavailable}</p><a class="btn" href="${esc(whatsapp("", t.ask))}">${t.contact}</a></div>`;
}

export function renderCatalogFragment(catalog: Catalog, lang: Lang, only?: "COURSE50" | "COURSE70"): string {
  const t = text[lang];
  const courses = only ? catalog.courses.filter((c) => c.code === only) : catalog.courses;
  const amount = (price: number, currency = "TJS") => `${price} ${currency === "TJS" ? t.currency : currency}`;
  const button = (name: string, price: number, currency = "TJS") => `<a class="btn" aria-label="${esc(lang === "tg" ? `Курси «${name}»-ро дар WhatsApp харидан` : `Купить курс «${name}» в WhatsApp`)}" href="${esc(whatsapp(catalog.contacts.whatsapp, t.order(name, amount(price, currency))))}">${t.buy}</a>`;
  if (!courses.length) return `<div data-server-catalog="ready" lang="${lang}" class="notice"><p>${t.empty}</p><a class="btn" href="${esc(whatsapp(catalog.contacts.whatsapp, t.ask))}">${t.contact}</a></div>`;
  const bundle = !only && courses.length >= 2 ? catalog.bundle : null;
  const cards = courses.map((c) => {
    const name = title(c, lang);
    const cover = coverUrl(c);
    const description = lang === "tg" && ["COURSE50", "COURSE70"].includes(c.code)
      ? "Видеодарсҳои қаннодии Ширин. Бо суръати худ омӯзед ва дар ошхонаи худ такрор кунед." : c.description;
    const lessons = lessonsLabel(c.lessonsCount, lang);
    const duration = durationLabel(c.durationMin, lang);
    const ownCover = cover && /^\/img\/covers\/course-course(?:50|70)\.webp$/.test(cover);
    const srcset = ownCover ? ` srcset="${esc(cover.replace(/\.webp$/, "-sm.webp"))} 800w, ${esc(cover)} 1600w" sizes="(min-width: 720px) 400px, 100vw"` : "";
    const syllabus = c.lessonTitles?.length ? `<p class="course-preview">${c.lessonTitles.slice(0, 3).map(esc).join(" · ")}</p><details class="course-syllabus"><summary>${esc(lessons)}</summary><ul>${c.lessonTitles.map((name) => `<li>${esc(name)}</li>`).join("")}</ul></details>` : "";
    const alt = lang === "tg" ? `Муқоваи курси «${name}»` : `Обложка курса «${name}»`;
    return `<article class="card course-card"><div class="course-cover">${cover ? `<img src="${esc(cover)}"${srcset} alt="${esc(alt)}" width="640" height="360" loading="lazy" decoding="async">` : '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v16h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3V4Z M12 6v16"/></svg>'}</div><div class="course-body"><h3 class="h3">${esc(name)}</h3>${description ? `<p>${esc(description)}</p>` : ""}${syllabus}<ul class="course-meta"><li class="chip">${esc(lessons)}</li>${c.durationMin > 0 ? `<li class="chip">${esc(duration)}</li>` : ""}<li class="chip">${t.forever}</li><li class="chip chip-ok">${t.certificate}</li></ul><div class="price price-pill">${esc(amount(c.price, c.currency))}</div>${button(name, c.price, c.currency)}</div></article>`;
  }).join("");
  const names = courses.map((c) => title(c, lang)).join(" + ");
  const discounted = bundle && bundle.fullPrice > bundle.price;
  const saving = discounted ? (lang === "tg" ? `${bundle.fullPrice - bundle.price} сомонӣ сарфа мекунед` : `выгода ${bundle.fullPrice - bundle.price} сомони`) : "";
  const insteadOf = bundle ? (lang === "tg" ? `ба ҷои ${amount(bundle.fullPrice)}` : `вместо ${amount(bundle.fullPrice)}`) : "";
  const bundled = bundle ? `<article class="card course-card bundle-card"><div class="course-cover" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v16h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3V4Z M12 6v16"/></svg></div><div class="course-body"><h3 class="h3">${t.bundle}</h3><p>${esc(names)}</p><ul class="course-meta">${discounted ? `<li class="chip">${esc(saving)}</li>` : ""}</ul><div class="price price-pill">${esc(amount(bundle.price))}${discounted ? `<s>${esc(insteadOf)}</s>` : ""}</div>${button(names, bundle.price)}</div></article>` : "";
  return `<div data-server-catalog="ready" lang="${lang}"><div class="grid grid-${courses.length === 1 ? 1 : bundle ? 3 : 2}">${cards}${bundled}</div><section class="purchase-guide" aria-label="${t.purchase}"><h3 class="h3">${t.purchase}</h3><ol>${t.steps.map((step) => `<li>${step}</li>`).join("")}</ol><p class="muted">${t.note}</p></section></div>`;
}
