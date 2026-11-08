import { getSetting, logError, prisma, recordOutgoingMessage } from "../db.js";
import { env } from "../env.js";
import { sendVideoWithCaption } from "../messaging/send.js";
import { contactLanguage } from "./contactLanguage.js";
import { comparableBotText } from "./humanText.js";
import type { Contact } from "@prisma/client";

/**
 * БИБЛИОТЕКА ВИДЕО ДЛЯ ОТПРАВКИ КЛИЕНТАМ (решение владельца 08.11.2026).
 *
 * Три случая, один список:
 *  - dessert — ролик одного десерта: упомянули десерт из списка → шлём его;
 *  - howto   — короткая запись экрана «как смотреть онлайн-урок» для тех, кто не понимает,
 *              что такое онлайн-курс;
 *  - просят «покажите видео/примеры» без названия → подборка роликов-десертов (не больше SET_MAX).
 *
 * Отправка — одним сообщением «видео + подпись» (у WhatsApp-моста лимит 8 отправок за 10 минут на
 * чат: два сообщения на ролик съедали бы его вдвое быстрее). Рубильник — videoLibraryEnabled
 * (по умолчанию ВЫКЛЮЧЕН), список — настройка videoLibrary (JSON).
 *
 * ПРАВИЛА (по независимому ревью 08.11.2026):
 *  - слова ищем ЦЕЛЫМИ, а не кусками («например» ≠ «пример»);
 *  - про деньги/оплату/реквизиты/чек/карту — видео не шлём вовсе: человеку нужен ответ, а не ролик;
 *  - вложение в сообщении (чек, фото) — не наш случай;
 *  - купившая курс ученица рекламы не получает;
 *  - явная просьба показать → ролик ВМЕСТО ответа модели; просто упомянули десерт → ролик ВДОБАВОК,
 *    ответ даёт модель (иначе «есть десерт с манго?» остался бы без ответа);
 *  - не больше одного показа каждого вида за разговор; подборка не длиннее остатка лимита моста.
 */
export type VideoKind = "dessert" | "howto";

export interface VideoEntry {
  id: string;
  kind: VideoKind;
  /** Название десерта (для dessert) — как в меню; на таджикском тоже по-русски. */
  dessert?: string;
  /** Начала слов (строчными), по которым узнаём десерт в сообщении клиента. */
  keywords?: string[];
  /** https-ссылка на mp4 нашего сайта или путь вида /img/…/x.mp4, /video/…/x.mp4 (до 8 МБ — лимит моста). */
  url: string;
  caption: { ru: string; tg: string };
}

/** Единственные ролики, которые есть в репозитории: превью уроков с сайта (media.json). */
export const DEFAULT_VIDEOS: VideoEntry[] = [
  {
    id: "whoopie",
    kind: "dessert",
    dessert: "Вупи пай",
    keywords: ["вупи", "whoopie"],
    url: "/img/lessons/whoopie-preview.mp4",
    caption: { ru: "Вот кусочек видеоурока: Вупи пай", tg: "Ин порчаи видеодарс: Вупи пай" },
  },
  {
    id: "mango",
    kind: "dessert",
    dessert: "Лимон и манго",
    keywords: ["манго", "mango"],
    url: "/img/lessons/mango-preview.mp4",
    caption: { ru: "Вот кусочек видеоурока: Лимон и манго", tg: "Ин порчаи видеодарс: Лимон ва манго" },
  },
];

export const SET_MIN = 3;
/** Не больше трёх роликов за раз: у моста 8 отправок за 10 минут на чат, а ответ бота тоже считается. */
export const SET_MAX = 3;
export const BRIDGE_CHAT_LIMIT = 8;
const BRIDGE_WINDOW_MS = 10 * 60_000;

const BAD_CAPTION =
  /сомон|\bсом\b|цен[аыуе]|оплат|купит|заплат|школ|нарх|харид|пардохт|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/iu;

/** Хосты, с которых можно слать ролик: наш сайт (из настроек) и основной домен. */
function allowedHosts(): Set<string> {
  const hosts = new Set(["shirinsweets.online", "www.shirinsweets.online"]);
  try {
    if (env.publicBaseUrl) hosts.add(new URL(env.publicBaseUrl).hostname);
  } catch {
    /* ignore */
  }
  return hosts;
}

/** Только mp4 и только наш сайт; пути /api и прочее — нельзя. */
export function allowedVideoUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (/^\/(img|video)\/[\w\-./]+\.mp4$/i.test(url) && !url.includes("..")) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && allowedHosts().has(u.hostname) && /^\/(img|video)\/[\w\-./]+\.mp4$/i.test(u.pathname) && !u.pathname.includes("..");
  } catch {
    return false;
  }
}

/** Запись годна, только если адрес разрешён и подпись чистая. Негодные молча отбрасываются. */
export function validEntry(e: unknown): e is VideoEntry {
  const v = e as VideoEntry;
  if (!v || typeof v.id !== "string" || !v.id) return false;
  if (v.kind !== "dessert" && v.kind !== "howto") return false;
  if (!allowedVideoUrl(v.url)) return false;
  if (!v.caption || typeof v.caption.ru !== "string" || typeof v.caption.tg !== "string") return false;
  if (!v.caption.ru.trim() || !v.caption.tg.trim()) return false;
  if (BAD_CAPTION.test(v.caption.ru) || BAD_CAPTION.test(v.caption.tg)) return false;
  if (v.kind === "dessert" && !(Array.isArray(v.keywords) && v.keywords.some((k) => typeof k === "string" && k.trim()))) return false;
  return true;
}

/** Ошибка в сохранённом списке — текстом (для панели), null если всё в порядке или список пуст. */
export function libraryError(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "Список роликов не читается: это не JSON (пропущена запятая или кавычка).";
  }
  if (!Array.isArray(data)) return "Список роликов должен быть массивом [ … ].";
  const bad = data.findIndex((e) => !validEntry(e));
  return bad >= 0 ? `Ролик №${bad + 1} отброшен: проверьте адрес (https нашего сайта, .mp4), подпись (без цен, оплаты, слова «школа», смайликов) и ключевые слова.` : null;
}

export function parseLibrary(raw: string | null | undefined): VideoEntry[] {
  if (!raw?.trim()) return DEFAULT_VIDEOS;
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(validEntry) : DEFAULT_VIDEOS;
  } catch {
    return DEFAULT_VIDEOS;
  }
}

export function videoUrl(url: string): string {
  if (/^https:\/\//i.test(url)) return url;
  const base = (env.publicBaseUrl || "https://shirinsweets.online").replace(/\/+$/, "");
  return `${base}${url}`;
}

/** Начало слова: слева не буква и не цифра (JS \b с кириллицей не работает). */
const START = String.raw`(?<![\p{L}\d])`;
const word = (alts: string) => new RegExp(`${START}(?:${alts})`, "iu");

/** Деньги, оплата, реквизиты, чек, карта, цена — тут нужен ответ, а не ролик. */
const MONEY = word(
  [
    "оплат\\p{L}*", "платит\\p{L}*", "платёж\\p{L}*", "платеж\\p{L}*", "заплат\\p{L}*", "реквизит\\p{L}*", "перевод\\p{L}*", "перевест\\p{L}*", "переведу",
    "чек(?![\\p{L}\\d])", "чеки", "квитанц\\p{L}*", "карт[аыуе]?(?![\\p{L}])", "картой", "картам", "сбер\\p{L}*", "номер\\p{L}*", "счёт\\p{L}*", "счет(?![\\p{L}])",
    "сколько", "цен[аыуе]?(?![\\p{L}])", "стоит", "стоимост\\p{L}*", "сомон\\p{L}*", "дорог\\p{L}*", "скидк\\p{L}*", "рассрочк\\p{L}*", "куп[ил]\\p{L}*", "куплю", "покупк\\p{L}*",
    "нарх\\p{L}*", "чанд(?![\\p{L}])", "пардохт\\p{L}*", "пул(?![\\p{L}])", "харид\\p{L}*", "рақам\\p{L}*", "ракам\\p{L}*", "корт\\p{L}*", "кортро", "ҳисоб\\p{L}*", "хисоб\\p{L}*", "интиқол\\p{L}*",
  ].join("|"),
);
/** Явная просьба показать — целые слова. «например» сюда не попадает: «пример» стоит не в начале слова. */
const SHOW = word(
  String.raw`видео\p{L}*|ролик\p{L}*|видос\p{L}*|покаж\p{L}*|посмотр\p{L}*|пример(?:ы|ов|ам|ами|ах)?(?![\p{L}])|как\s+выгляд\p{L}*|намоиш\p{L}*|тасвир\p{L}*|нишон\s+(?:диҳ|дих)\p{L}*`,
);
const OFFLINE = word("офлайн|оффлайн|offline|очно|душанбе");
/** «Как проходит ОНЛАЙН-курс» / «что такое онлайн» / «как смотреть уроки» — про онлайн, не про офлайн и не про оплату. */
const HOWTO = word(
  String.raw`как\s+(?:смотр\p{L}*|проход\p{L}*\s+(?:онлайн|уроки|занят\p{L}*|обучен\p{L}*)|устроен\p{L}*\s+(?:онлайн|курс)|учит\p{L}*\s+онлайн)|что\s+(?:такое|за)\s+онлайн|не\s+понима\p{L}*[^.?!]{0,30}онлайн|онлайн\s+чӣ\s+аст|чӣ\s+гуна\s+(?:тамошо|дарс)\p{L}*|чи\s+тавр\s+(?:тамошо|дарс)\p{L}*`,
);

export type VideoIntent =
  | { kind: "howto"; replace: true }
  | { kind: "dessert"; entry: VideoEntry; replace: boolean }
  | { kind: "set"; replace: true }
  | null;

export interface IntentContext {
  /** В сообщении есть вложение (чек, фото, голос) — это не просьба про видео. */
  hasAttachments?: boolean;
}

/** Что просит клиент. null — ролик не нужен (в т.ч. любой разговор про деньги). */
export function detectVideoIntent(text: string, library: VideoEntry[], ctx: IntentContext = {}): VideoIntent {
  const t = text.trim();
  if (t.length < 3 || ctx.hasAttachments) return null;
  if (MONEY.test(t)) return null;
  const asked = SHOW.test(t);
  if (HOWTO.test(t) && !OFFLINE.test(t) && library.some((e) => e.kind === "howto")) return { kind: "howto", replace: true };
  const desserts = library.filter((e) => e.kind === "dessert");
  const hit = desserts.find((e) => e.keywords?.some((k) => k.trim() && new RegExp(`${START}${escapeRe(k.trim())}`, "iu").test(t)));
  if (hit) return { kind: "dessert", entry: hit, replace: asked && !t.includes("?") };
  if (asked && desserts.length >= SET_MIN) return { kind: "set", replace: true };
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pickSet(library: VideoEntry[], room = SET_MAX): VideoEntry[] {
  return library.filter((e) => e.kind === "dessert").slice(0, Math.min(SET_MAX, Math.max(0, room)));
}

/** Какие виды показа клиенту уже были: смотрим по записанным исходящим подписям. */
async function alreadyShown(contactId: string, library: VideoEntry[]): Promise<{ showcase: boolean; howto: boolean }> {
  // Сравнение после фильтра отправки: в истории лежит то, что увидел клиент (без
  // тире, особые буквы по его стилю), а в библиотеке — исходная подпись.
  const byCaption = new Map<string, VideoKind>();
  for (const e of library) {
    for (const caption of [e.caption.ru, e.caption.tg]) {
      const key = comparableBotText(caption);
      if (key) byCaption.set(key, e.kind);
    }
  }
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", text: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { text: true },
    take: 300,
  });
  const kinds = new Set(rows.map((r) => byCaption.get(comparableBotText(r.text))));
  return { showcase: kinds.has("dessert"), howto: kinds.has("howto") };
}

/** Сколько отправок ещё влезает в лимит моста на этот чат: 8 за 10 минут, одну оставляем под ответ бота. */
async function bridgeRoom(contactId: string): Promise<number> {
  const used = await prisma.message.count({
    where: { contactId, direction: "OUT", createdAt: { gte: new Date(Date.now() - BRIDGE_WINDOW_MS) } },
  });
  return BRIDGE_CHAT_LIMIT - used - 1;
}

async function sendEntry(contact: Contact, e: VideoEntry, lang: "ru" | "tg"): Promise<void> {
  const caption = e.caption[lang];
  const mid = await sendVideoWithCaption(contact, videoUrl(e.url), caption);
  await recordOutgoingMessage(contact.id, caption, mid);
}

/** Результат: "replace" — ролик ушёл вместо ответа модели; "addon" — ушёл вдобавок, модель отвечает как обычно;
 *  "none" — ничего не отправлено. */
export type VideoResult = "replace" | "addon" | "none";

export async function maybeSendVideos(contact: Contact, text: string, ctx: IntentContext = {}): Promise<VideoResult> {
  try {
    if ((await getSetting("videoLibraryEnabled")) !== "true") return "none";
    const library = parseLibrary(await getSetting("videoLibrary"));
    const intent = detectVideoIntent(text, library, ctx);
    if (!intent) return "none";
    // Купившая курс — ученица, реклама ей не нужна.
    if ((await prisma.purchase.count({ where: { contactId: contact.id, revokedAt: null } })) > 0) return "none";
    const shown = await alreadyShown(contact.id, library);
    const lang = (await contactLanguage(contact.id, text)) === "tg" ? "tg" : "ru";
    const room = await bridgeRoom(contact.id);
    let list: VideoEntry[];
    if (intent.kind === "howto") {
      if (shown.howto) return "none";
      list = [library.find((e) => e.kind === "howto") as VideoEntry];
    } else {
      if (shown.showcase) return "none";
      list = intent.kind === "dessert" ? [intent.entry] : pickSet(library, room);
    }
    list = list.slice(0, Math.max(0, room));
    if (!list.length) return "none";
    for (const e of list) await sendEntry(contact, e, lang);
    return intent.replace ? "replace" : "addon";
  } catch (err) {
    logError("ai:videoLibrary", err);
    return "none";
  }
}
