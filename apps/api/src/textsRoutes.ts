import { Router } from "express";
import { z } from "zod";
import { getSetting } from "./db.js";
import { autoCatch } from "./asyncRoute.js";
import { COURSE_50, COURSE_70, COURSE_TITLE, DEFAULT_PRICES, priceLineRu, priceTable } from "./prices.js";
import { DEFAULT_SALES_TEXTS, buildAlwaysRules, paymentLine, type SalesTexts } from "./ai/prompts.js";
import { DEFAULT_OFFLINE_FACTS, offlineCardDefault, type OfflineFacts } from "./ai/offlineCourse.js";
import { offlineStartDate, toIsoDay, upcomingOfflineStartDate } from "./ai/courseDate.js";
import { getPrices, savePrices } from "./services/priceService.js";
import {
  OFFLINE_FACT_KEYS,
  SALES_TEXT_KEYS,
  getOfflineFacts,
  getSalesTexts,
  resetSalesTextsCache,
} from "./services/salesTextsService.js";
import { writeSettings } from "./services/settingsService.js";
import { resetCatalogCache } from "./site/router.js";

/**
 * РАЗДЕЛ «ТЕКСТЫ И ЦЕНЫ» — одно место для всего, что видит покупательница
 * (предложение «Утро Ширин» §12, 05.09.2026).
 *
 * До этого цены сидели в коде, реквизиты — в правилах бота, условие
 * сертификата — в трёх местах с тремя формулировками, а дата офлайн-курса —
 * 27-м полем в Настройках между ключами R2 и токенами Meta. Здесь всё
 * вместе, RU и TG рядом, и предпросмотр «как увидит покупательница»,
 * собранный ТЕМИ ЖЕ функциями, что читают бот и сайт, — а не копией на
 * клиенте, которая рано или поздно разошлась бы.
 *
 * Монтируется в adminRouter: пароль уже проверен выше.
 */
// autoCatch свой: обёртка adminRouter на вложенные роутеры не распространяется (см. today.ts).
export const textsRouter = autoCatch(Router());

const priceSchema = z.object({
  course50: z.number().int().min(1).max(100_000),
  course70: z.number().int().min(1).max(100_000),
  bundle: z.number().int().min(1).max(100_000),
});

const textsSchema = z.object({
  paymentPhone: z.string().trim().min(5).max(40),
  paymentRecipient: z.string().trim().min(3).max(80),
  paymentBanks: z.string().trim().min(2).max(120),
  paymentNameNoteRu: z.string().trim().min(5).max(300),
  paymentNameNoteTg: z.string().trim().min(5).max(300),
  certificateRuleRu: z.string().trim().min(5).max(400),
  certificateRuleTg: z.string().trim().min(5).max(400),
  lessonLanguageRu: z.string().trim().min(5).max(400),
  lessonLanguageTg: z.string().trim().min(5).max(400),
  afterPaymentRu: z.string().trim().min(5).max(400),
  afterPaymentTg: z.string().trim().min(5).max(400),
});

const offlineSchema = z.object({
  price: z.number().int().min(1).max(100_000),
  days: z.number().int().min(1).max(60),
  hours: z.string().trim().min(3).max(60),
  desserts: z.number().int().min(1).max(200),
  address: z.string().trim().min(3).max(200),
  /** ГГГГ-ММ-ДД или пусто — «дата уточняется». */
  startDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  infoRu: z.string().max(4000),
  infoTg: z.string().max(4000),
});

const bodySchema = z.object({ prices: priceSchema, texts: textsSchema, offline: offlineSchema });

type TextsBody = z.infer<typeof bodySchema>;

/**
 * Предпросмотр «как увидит покупательница» — из черновика, не из базы:
 * панель шлёт сюда несохранённые значения, пока владелец печатает.
 * Карточка офлайн-курса: свой текст дословно, иначе заготовка из фактов.
 */
function renderPreview(body: TextsBody, start: { year: number; month: number; day: number } | null) {
  const prices = priceTable(body.prices.course50, body.prices.course70, body.prices.bundle);
  const texts: SalesTexts = { ...body.texts, priceLineRu: priceLineRu(prices) };
  const facts: OfflineFacts = {
    price: body.offline.price,
    days: body.offline.days,
    hours: body.offline.hours,
    desserts: body.offline.desserts,
    address: body.offline.address,
  };
  const line = paymentLine(texts);
  return {
    priceLine: texts.priceLineRu,
    priceList: [
      { code: COURSE_50, title: COURSE_TITLE[COURSE_50], price: prices.price[COURSE_50] },
      { code: COURSE_70, title: COURSE_TITLE[COURSE_70], price: prices.price[COURSE_70] },
      { code: "BUNDLE", title: "Оба курса вместе", price: prices.bundle, insteadOf: prices.bundleFull },
    ],
    payment: {
      ru: `Реквизиты: ${line}. Если спросят, почему не Ширин: «${texts.paymentNameNoteRu}».`,
      tg: `Реквизитҳо: ${line}. Агар пурсанд, чаро на Ширин: «${texts.paymentNameNoteTg}».`,
    },
    certificate: { ru: texts.certificateRuleRu, tg: texts.certificateRuleTg },
    lessonLanguage: { ru: texts.lessonLanguageRu, tg: texts.lessonLanguageTg },
    afterPayment: { ru: texts.afterPaymentRu, tg: texts.afterPaymentTg },
    offlineCard: {
      ru: body.offline.infoRu.trim() || offlineCardDefault("ru", start, facts),
      tg: body.offline.infoTg.trim() || offlineCardDefault("tg", start, facts),
    },
    /** Правила бота целиком — чтобы владелец видел, что именно уйдёт модели. */
    botRules: buildAlwaysRules(texts),
  };
}

async function currentBody(): Promise<TextsBody> {
  const [prices, texts, facts, start, infoRu, infoTg] = await Promise.all([
    getPrices(),
    getSalesTexts(),
    getOfflineFacts(),
    offlineStartDate(),
    getSetting("offlineCourseInfo"),
    getSetting("offlineCourseInfoTg"),
  ]);
  const { priceLineRu: _line, ...plain } = texts;
  return {
    prices: { course50: prices.price[COURSE_50], course70: prices.price[COURSE_70], bundle: prices.bundle },
    texts: plain,
    offline: {
      ...facts,
      startDate: start ? toIsoDay(start) : "",
      infoRu: infoRu ?? "",
      infoTg: infoTg ?? "",
    },
  };
}

textsRouter.get("/admin/texts", async (_req, res) => {
  const body = await currentBody();
  const upcoming = await upcomingOfflineStartDate();
  const { priceLineRu: _line, ...textDefaults } = DEFAULT_SALES_TEXTS;
  res.json({
    ...body,
    defaults: {
      prices: { course50: DEFAULT_PRICES.price[COURSE_50], course70: DEFAULT_PRICES.price[COURSE_70], bundle: DEFAULT_PRICES.bundle },
      texts: textDefaults,
      offline: DEFAULT_OFFLINE_FACTS,
    },
    preview: renderPreview(body, upcoming),
  });
});

textsRouter.post("/admin/texts/preview", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const start = parseDay(parsed.data.offline.startDate);
  res.json(renderPreview(parsed.data, start));
});

function parseDay(iso: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

textsRouter.put("/admin/texts", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { prices, texts, offline } = parsed.data;

  // Цены — и в Settings, и в Course.price (сайт показывает второе).
  await savePrices(prices);

  const values: Record<string, string> = {};
  for (const [field, key] of Object.entries(SALES_TEXT_KEYS)) values[key] = texts[field as keyof typeof texts];
  values[OFFLINE_FACT_KEYS.price] = String(offline.price);
  values[OFFLINE_FACT_KEYS.days] = String(offline.days);
  values[OFFLINE_FACT_KEYS.hours] = offline.hours;
  values[OFFLINE_FACT_KEYS.desserts] = String(offline.desserts);
  values[OFFLINE_FACT_KEYS.address] = offline.address;
  values.offlineCourseStartDate = offline.startDate;
  values.offlineCourseInfo = offline.infoRu.trim();
  values.offlineCourseInfoTg = offline.infoTg.trim();
  await writeSettings(values);

  resetSalesTextsCache();
  resetCatalogCache();
  const body = await currentBody();
  res.json({ ok: true, ...body, preview: renderPreview(body, await upcomingOfflineStartDate()) });
});
