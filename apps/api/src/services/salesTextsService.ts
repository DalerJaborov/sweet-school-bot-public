import { getSetting } from "../db.js";
import { DEFAULT_SALES_TEXTS, buildAlwaysRules, buildDefaultPrompt, type SalesTexts } from "../ai/prompts.js";
import { DEFAULT_OFFLINE_FACTS, type OfflineFacts } from "../ai/offlineCourse.js";
import { priceLineRu } from "../prices.js";
import { getPrices } from "./priceService.js";

/**
 * ТЕКСТЫ ПРОДАЖ ИЗ НАСТРОЕК — то, что владелец правит в разделе «Тексты и цены».
 *
 * Одно место, откуда бот (правила 4, 17–21), карточка офлайн-курса и сайт
 * берут реквизиты, условие сертификата, язык уроков, «что после оплаты» и
 * факты офлайн-курса. Пустая настройка → сегодняшний текст по умолчанию из
 * ai/prompts.ts и ai/offlineCourse.ts, поэтому до первого сохранения ничего
 * не меняется.
 *
 * Кэш 30 с, как у цен: тексты читаются на каждом ходе бота.
 */

/** Ключи Settings ↔ поля SalesTexts (цены — отдельно, через priceService). */
export const SALES_TEXT_KEYS = {
  paymentPhone: "paymentPhone",
  paymentRecipient: "paymentRecipient",
  paymentBanks: "paymentBanks",
  paymentNameNoteRu: "paymentNameNoteRu",
  paymentNameNoteTg: "paymentNameNoteTg",
  certificateRuleRu: "certificateRuleRu",
  certificateRuleTg: "certificateRuleTg",
  lessonLanguageRu: "lessonLanguageRu",
  lessonLanguageTg: "lessonLanguageTg",
  afterPaymentRu: "afterPaymentRu",
  afterPaymentTg: "afterPaymentTg",
} as const satisfies Record<Exclude<keyof SalesTexts, "priceLineRu">, string>;

export const OFFLINE_FACT_KEYS = {
  price: "offlineCoursePrice",
  days: "offlineCourseDays",
  hours: "offlineCourseHours",
  desserts: "offlineCourseDesserts",
  address: "offlineCourseAddress",
} as const satisfies Record<keyof OfflineFacts, string>;

const CACHE_TTL_MS = 30_000;
let textsCache: { at: number; value: SalesTexts } | null = null;
let factsCache: { at: number; value: OfflineFacts } | null = null;

function str(raw: string | null, fallback: string): string {
  const v = (raw ?? "").trim();
  return v || fallback;
}

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resetSalesTextsCache(): void {
  textsCache = null;
  factsCache = null;
}

/** Тексты для правил бота: настройки поверх умолчаний, цены — из priceService. */
export async function getSalesTexts(): Promise<SalesTexts> {
  if (textsCache && Date.now() - textsCache.at < CACHE_TTL_MS) return textsCache.value;
  const prices = await getPrices();
  const entries = await Promise.all(
    (Object.keys(SALES_TEXT_KEYS) as (keyof typeof SALES_TEXT_KEYS)[]).map(
      async (field) => [field, str(await getSetting(SALES_TEXT_KEYS[field]), DEFAULT_SALES_TEXTS[field])] as const
    )
  );
  const value: SalesTexts = { ...DEFAULT_SALES_TEXTS, ...Object.fromEntries(entries), priceLineRu: priceLineRu(prices) };
  textsCache = { at: Date.now(), value };
  return value;
}

/** Факты офлайн-курса для карточки бота и витрины сайта. */
export async function getOfflineFacts(): Promise<OfflineFacts> {
  if (factsCache && Date.now() - factsCache.at < CACHE_TTL_MS) return factsCache.value;
  const [price, days, hours, desserts, address] = await Promise.all([
    getSetting(OFFLINE_FACT_KEYS.price),
    getSetting(OFFLINE_FACT_KEYS.days),
    getSetting(OFFLINE_FACT_KEYS.hours),
    getSetting(OFFLINE_FACT_KEYS.desserts),
    getSetting(OFFLINE_FACT_KEYS.address),
  ]);
  const value: OfflineFacts = {
    price: positiveInt(price, DEFAULT_OFFLINE_FACTS.price),
    days: positiveInt(days, DEFAULT_OFFLINE_FACTS.days),
    hours: str(hours, DEFAULT_OFFLINE_FACTS.hours),
    desserts: positiveInt(desserts, DEFAULT_OFFLINE_FACTS.desserts),
    address: str(address, DEFAULT_OFFLINE_FACTS.address),
  };
  factsCache = { at: Date.now(), value };
  return value;
}

/**
 * Системный промт бота целиком: промт владельца (или заготовка) + незыблемые
 * правила, собранные из текущих текстов и цен. Одна функция на оба вызова в
 * ai.ts (директ и комментарии), чтобы они не разошлись.
 */
export async function buildSystemPrompt(): Promise<string> {
  const texts = await getSalesTexts();
  const own = (await getSetting("aiPrompt"))?.trim();
  return (own || buildDefaultPrompt(texts)) + buildAlwaysRules(texts);
}
