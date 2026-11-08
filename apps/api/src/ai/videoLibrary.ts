import { getSetting, logError, prisma, recordOutgoingMessage } from "../db.js";
import { env } from "../env.js";
import { sendToContact, sendAttachmentToContact } from "../messaging/send.js";
import { detectClientLanguage } from "./clientLanguage.js";
import type { Contact } from "@prisma/client";

/**
 * БИБЛИОТЕКА ВИДЕО ДЛЯ ОТПРАВКИ КЛИЕНТАМ (решение владельца 08.11.2026).
 *
 * Три случая, один список:
 *  - dessert — ролик одного десерта: спросили про конкретный десерт → шлём его;
 *  - howto   — короткая запись экрана «как смотреть онлайн-урок» для тех, кто не понимает,
 *              что такое онлайн-курс;
 *  - просят «покажите видео/примеры» без названия → подборка из 3–6 роликов-десертов.
 *
 * Второго механизма отправки нет: файл уходит тем же sendAttachmentToContact, что и
 * одобренные примеры (mediaReuse.ts), а вызов стоит в ai.ts рядом с ними. Рубильник —
 * videoLibraryEnabled (по умолчанию ВЫКЛЮЧЕН), список — настройка videoLibrary (JSON).
 * Пока владелец не загрузил свои ролики, работают только реально существующие, лежащие на
 * сайте превью уроков (см. DEFAULT_VIDEOS) — ничего выдуманного.
 *
 * Правила: не больше одного показа каждого вида за разговор (ни повторов, ни «ещё»);
 * подпись — без цен, без просьбы об оплате, без смайликов, без слова «школа».
 */
export type VideoKind = "dessert" | "howto";

export interface VideoEntry {
  id: string;
  kind: VideoKind;
  /** Название десерта (для dessert) — как в меню; на таджикском тоже по-русски. */
  dessert?: string;
  /** Подстроки (строчными), по которым узнаём десерт в сообщении клиента. */
  keywords?: string[];
  /** https-ссылка на mp4 или путь на сайте вида /img/... (до 8 МБ — лимит моста WhatsApp). */
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
export const SET_MAX = 6;

const BAD_CAPTION =
  /сомон|\bсом\b|цен[аыуе]|оплат|купит|заплат|школ|нарх|харид|пардохт|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/iu;

/** Запись годна, только если ссылка https/путь на сайте и подпись чистая. Негодные молча отбрасываются. */
export function validEntry(e: unknown): e is VideoEntry {
  const v = e as VideoEntry;
  if (!v || typeof v.id !== "string" || !v.id) return false;
  if (v.kind !== "dessert" && v.kind !== "howto") return false;
  if (typeof v.url !== "string" || !(/^https:\/\//i.test(v.url) || /^\/[^/]/.test(v.url))) return false;
  if (!v.caption || typeof v.caption.ru !== "string" || typeof v.caption.tg !== "string") return false;
  if (!v.caption.ru.trim() || !v.caption.tg.trim()) return false;
  if (BAD_CAPTION.test(v.caption.ru) || BAD_CAPTION.test(v.caption.tg)) return false;
  if (v.kind === "dessert" && !(Array.isArray(v.keywords) && v.keywords.some((k) => typeof k === "string" && k.trim()))) return false;
  return true;
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

const HOWTO =
  /как\s+(смотреть|смотрят|проходит|проходят|устроен|устроено|это\s+работает|учиться)|что\s+такое\s+онлайн|что\s+за\s+онлайн|не\s+понима\w+.{0,30}(онлайн|курс|урок)|онлайн\s+чӣ\s+аст|чӣ\s+гуна\s+(тамошо|дарс|мегузар)|чи\s+тавр\s+(тамошо|дарс)|курси\s+онлайн\s+чист/iu;
const SHOW_WORDS = /видео|ролик|видос|покаж|как\s+выгляд|пример|результат|намоиш|тасвир|нишон\s+дихед/iu;

export type VideoIntent = { kind: "howto" } | { kind: "dessert"; entry: VideoEntry } | { kind: "set" } | null;

/** Что просит клиент. Названный десерт важнее общей просьбы «покажите видео». */
export function detectVideoIntent(text: string, library: VideoEntry[]): VideoIntent {
  const t = text.trim().toLowerCase();
  if (t.length < 3) return null;
  if (HOWTO.test(t) && library.some((e) => e.kind === "howto")) return { kind: "howto" };
  const desserts = library.filter((e) => e.kind === "dessert");
  const hit = desserts.find((e) => e.keywords?.some((k) => k.trim() && t.includes(k.trim().toLowerCase())));
  if (hit) return { kind: "dessert", entry: hit };
  if (SHOW_WORDS.test(t) && desserts.length >= SET_MIN) return { kind: "set" };
  return null;
}

export function pickSet(library: VideoEntry[]): VideoEntry[] {
  return library.filter((e) => e.kind === "dessert").slice(0, SET_MAX);
}

/** Какие виды показа клиенту уже были: смотрим по записанным исходящим подписям. */
async function alreadyShown(contactId: string, library: VideoEntry[]): Promise<{ showcase: boolean; howto: boolean }> {
  const byCaption = new Map<string, VideoKind>();
  for (const e of library) {
    byCaption.set(e.caption.ru, e.kind);
    byCaption.set(e.caption.tg, e.kind);
  }
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", text: { in: [...byCaption.keys()] } },
    select: { text: true },
    take: 50,
  });
  const kinds = new Set(rows.map((r) => byCaption.get(r.text ?? "")));
  return { showcase: kinds.has("dessert"), howto: kinds.has("howto") };
}

async function sendEntry(contact: Contact, e: VideoEntry, lang: "ru" | "tg"): Promise<void> {
  const caption = e.caption[lang];
  const mid = await sendToContact(contact, caption);
  await recordOutgoingMessage(contact.id, caption, mid);
  await sendAttachmentToContact(contact, videoUrl(e.url), "video");
}

/** true — видео отправлено (ход модели не нужен); false — не наш случай или нельзя. */
export async function maybeSendVideos(contact: Contact, text: string): Promise<boolean> {
  try {
    if ((await getSetting("videoLibraryEnabled")) !== "true") return false;
    const library = parseLibrary(await getSetting("videoLibrary"));
    const intent = detectVideoIntent(text, library);
    if (!intent) return false;
    const shown = await alreadyShown(contact.id, library);
    const lang = detectClientLanguage(text) === "tg" ? "tg" : "ru";
    if (intent.kind === "howto") {
      if (shown.howto) return false;
      await sendEntry(contact, library.find((e) => e.kind === "howto") as VideoEntry, lang);
      return true;
    }
    if (shown.showcase) return false;
    const list = intent.kind === "dessert" ? [intent.entry] : pickSet(library);
    for (const e of list) await sendEntry(contact, e, lang);
    return true;
  } catch (err) {
    logError("ai:videoLibrary", err);
    return false;
  }
}
