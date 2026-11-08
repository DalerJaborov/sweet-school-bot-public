import { Router } from "express";
import { z } from "zod";
import { getSetting } from "./db.js";
import { autoCatch } from "./asyncRoute.js";
import { COURSE_50, COURSE_70, COURSE_TITLE, priceLineRu, type PriceTable } from "./prices.js";
import { DEFAULT_SALES_TEXTS, buildAlwaysRules, paymentLine, type SalesTexts } from "./ai/prompts.js";
import { offlineCardDefault, type OfflineFacts } from "./ai/offlineCourse.js";
import { upcomingOfflineStartDate, type CalendarDay } from "./ai/courseDate.js";
import { getPrices } from "./services/priceService.js";
import { SALES_TEXT_KEYS, getOfflineFacts, getSalesTexts, resetSalesTextsCache } from "./services/salesTextsService.js";
import { writeSettings } from "./services/settingsService.js";
import { readOffer } from "./services/offerService.js";
import { resetCatalogCache } from "./site/router.js";

/**
 * РАЗДЕЛ «ТЕКСТЫ» — реквизиты, сертификат, язык уроков, «что после оплаты» и
 * свой текст карточки очного курса, RU и TG рядом (предложение «Утро Ширин»
 * §12, 05.09.2026).
 *
 * 08.11.2026: цены и даты отсюда ушли в раздел «Цены и даты»
 * (offerRoutes.ts → services/offerService.ts — единственная дверь записи, с
 * проверками и журналом). Здесь они только ЧИТАЮТСЯ для предпросмотра правил
 * бота. Старая панель из кэша телефона может ещё прислать цены в теле PUT:
 * совпали с текущими — молча игнорируем, отличаются — 409 с подсказкой, куда
 * идти (тихо выбросить чужую правку цены нельзя).
 *
 * Монтируется в adminRouter: пароль уже проверен выше.
 */
// autoCatch свой: обёртка adminRouter на вложенные роутеры не распространяется (см. today.ts).
export const textsRouter = autoCatch(Router());

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

/** Старая панель присылала цены и факты офлайна здесь же — принимаем, чтобы сверить. */
const legacyPrices = z.object({ course50: z.number(), course70: z.number(), bundle: z.number() }).partial();
const legacyOffline = z
  .object({
    price: z.number(),
    days: z.number(),
    hours: z.string(),
    desserts: z.number(),
    address: z.string(),
    startDate: z.string(),
  })
  .partial();

const bodySchema = z.object({
  texts: textsSchema,
  offline: legacyOffline.extend({ infoRu: z.string().max(4000), infoTg: z.string().max(4000) }),
  prices: legacyPrices.optional(),
});

type TextsBody = z.infer<typeof bodySchema>;

/**
 * Предпросмотр «как увидит покупательница» — тексты из черновика, цены и
 * факты офлайна — текущие, из тех же функций, что читает бот.
 */
function renderPreview(
  body: Pick<TextsBody, "texts" | "offline">,
  prices: PriceTable,
  facts: OfflineFacts,
  start: CalendarDay | null,
) {
  const texts: SalesTexts = { ...body.texts, priceLineRu: priceLineRu(prices) };
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

async function live() {
  const [prices, facts, start] = await Promise.all([getPrices(), getOfflineFacts(), upcomingOfflineStartDate()]);
  return { prices, facts, start };
}

async function currentBody() {
  const [texts, infoRu, infoTg] = await Promise.all([
    getSalesTexts(),
    getSetting("offlineCourseInfo"),
    getSetting("offlineCourseInfoTg"),
  ]);
  const { priceLineRu: _line, ...plain } = texts;
  return { texts: plain, offline: { infoRu: infoRu ?? "", infoTg: infoTg ?? "" } };
}

textsRouter.get("/admin/texts", async (_req, res) => {
  const body = await currentBody();
  const { prices, facts, start } = await live();
  const { priceLineRu: _line, ...textDefaults } = DEFAULT_SALES_TEXTS;
  res.json({
    ...body,
    defaults: { texts: textDefaults, offline: { infoRu: "", infoTg: "" } },
    preview: renderPreview(body, prices, facts, start),
  });
});

textsRouter.post("/admin/texts/preview", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { prices, facts, start } = await live();
  res.json(renderPreview(parsed.data, prices, facts, start));
});

/** Поля цен/дат из старой панели, которые отличаются от сохранённых. */
async function legacyOfferEdits(body: TextsBody): Promise<string[]> {
  const { offer } = await readOffer();
  const edits: string[] = [];
  const p = body.prices ?? {};
  if (p.course50 !== undefined && p.course50 !== offer.prices.course50) edits.push("цена «Арт-десерты»");
  if (p.course70 !== undefined && p.course70 !== offer.prices.course70) edits.push("цена «21 рецепт»");
  if (p.bundle !== undefined && p.bundle !== offer.prices.bundle) edits.push("цена комплекта");
  const o = body.offline;
  if (o.price !== undefined && o.price !== offer.offline.price) edits.push("цена очного курса");
  if (o.startDate !== undefined && o.startDate !== offer.offline.startDate) edits.push("дата набора");
  if (o.address !== undefined && o.address.trim() !== offer.offline.address) edits.push("адрес");
  if (o.days !== undefined && o.days !== offer.offline.days) edits.push("дни");
  if (o.desserts !== undefined && o.desserts !== offer.offline.desserts) edits.push("десерты");
  return edits;
}

textsRouter.put("/admin/texts", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const edits = await legacyOfferEdits(parsed.data);
  if (edits.length > 0) {
    res
      .status(409)
      .json({
        error: `Цены и даты теперь меняются в разделе «Цены и даты» (${edits.join(", ")}). Обновите страницу панели.`,
      });
    return;
  }
  const { texts, offline } = parsed.data;

  const values: Record<string, string> = {};
  for (const [field, key] of Object.entries(SALES_TEXT_KEYS)) values[key] = texts[field as keyof typeof texts];
  values.offlineCourseInfo = offline.infoRu.trim();
  values.offlineCourseInfoTg = offline.infoTg.trim();
  await writeSettings(values);

  resetSalesTextsCache();
  resetCatalogCache();
  const body = await currentBody();
  const { prices, facts, start } = await live();
  res.json({ ok: true, ...body, preview: renderPreview(body, prices, facts, start) });
});
