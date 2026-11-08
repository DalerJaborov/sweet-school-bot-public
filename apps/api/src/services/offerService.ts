import { z } from "zod";
import { prisma, getSetting, logError } from "../db.js";
import { COURSE_50, COURSE_70, DEFAULT_PRICES, offerPricePhrase, priceTable, type OfferItem } from "../prices.js";
import { DEFAULT_OFFLINE_FACTS, HHMM, hoursValue, parseHours, type OfflineFacts } from "../ai/offlineFacts.js";
import { offlineCardDefault } from "../ai/offlineCourse.js";
import { localTodayIso, offlineStartDate, parseIsoDay, toIsoDay } from "../ai/courseDate.js";
import {
  DEFAULT_PAYMENT_TOLERANCE,
  getPaymentTolerance,
  getPrices,
  MAX_TOLERANCE_DOWN,
  MAX_TOLERANCE_UP,
  resetPriceCache,
} from "./priceService.js";
import { getOfflineFacts, OFFLINE_FACT_KEYS, resetSalesTextsCache } from "./salesTextsService.js";
import { OFFER_SETTING_KEYS } from "./settingsService.js";
import { createHash } from "node:crypto";

/**
 * «ЦЕНЫ И ДАТЫ» — ЕДИНСТВЕННАЯ ДВЕРЬ ЗАПИСИ ТОГО, ЧТО БОТ И САЙТ НАЗЫВАЮТ
 * КЛИЕНТАМ (08.11.2026).
 *
 * До этого цену и дату набора можно было поменять в трёх местах панели
 * («Тексты и цены», «Настройки», ручная надпись даты) с тремя разными
 * проверками и без следа, кто что поменял. Теперь:
 *   • пишет только saveOffer() — Settings + Course.price (витрина) + журнал
 *     OfferChange одной транзакцией;
 *   • общий путь настроек эти ключи пропускает (settingsService.OFFER_SETTING_KEYS);
 *   • читают все по-прежнему через priceService / salesTextsService / courseDate,
 *     поэтому бот, проверка чека, воронка и сайт видят одно и то же;
 *   • сторож tests/unit/offerSingleSource.test.ts ловит обход и зашитые цены.
 *
 * Проверки: сумма > 0, комплект не дороже двух курсов и не дешевле самого
 * дорогого (иначе allocate() выдаст не тот доступ за чек), новая дата набора
 * не в прошлом, время ЧЧ:ММ и «с» раньше «до». Смена цены больше чем на 30 % —
 * только с подтверждением: опечатка «7» вместо «70» иначе ушла бы всем.
 */

export type Offer = {
  prices: { course50: number; course70: number; bundle: number };
  /** Допуск по сумме чека, сомони: down — комиссия банка «съела» часть, up —
   *  комиссия добавлена сверху. Необязателен во входе (старый экран его не шлёт). */
  payment?: { toleranceDown: number; toleranceUp: number };
  offline: {
    price: number;
    /** ГГГГ-ММ-ДД или "" — «дата уточняется». */
    startDate: string;
    timeFrom: string;
    timeTo: string;
    address: string;
    seats: number | null;
    days: number;
    desserts: number;
  };
};

/** Порог «точно?»: относительная смена цены, после которой нужно подтверждение. */
export const PRICE_JUMP_CONFIRM = 0.3;

/** Набор дальше этого — скорее опечатка в годе (2027 вместо 2026): предупреждаем. */
export const FAR_START_DAYS = 180;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * ВЕРСИЯ «ЦЕН И ДАТ» — отпечаток сохранённых значений. Экран получает её с
 * GET и возвращает при сохранении; не совпала — кто-то (вторая вкладка,
 * телефон) уже сохранил своё, и молча перезаписать его правку нельзя.
 * Считается по строкам Settings, поэтому сверка идёт внутри той же транзакции,
 * что и запись.
 */
function versionOf(rows: { key: string; value: string }[]): string {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const flat = OFFER_SETTING_KEYS.map((k) => [k, byKey.get(k) ?? null]);
  return createHash("sha256").update(JSON.stringify(flat)).digest("hex").slice(0, 16);
}

type SettingReader = {
  setting: { findMany(args: { where: { key: { in: string[] } } }): Promise<{ key: string; value: string }[]> };
};

export async function offerVersion(db: SettingReader = prisma): Promise<string> {
  const rows = await db.setting.findMany({ where: { key: { in: [...OFFER_SETTING_KEYS] } } });
  return versionOf(rows ?? []);
}

export const STALE_OFFER_MESSAGE = "Кто-то уже изменил цены или даты — обновите страницу и проверьте";

const price = (label: string) =>
  z
    .number({ error: `${label}: укажите сумму` })
    .int(`${label}: целое число сомони`)
    .min(1, `${label}: сумма должна быть больше нуля`)
    .max(100_000, `${label}: слишком большая сумма`);

const offerSchema = z.object({
  prices: z.object({
    course50: price("Арт-десерты"),
    course70: price("21 рецепт"),
    bundle: price("Оба курса"),
  }),
  payment: z
    .object({
      toleranceDown: z
        .number({ error: "Допуск вниз: укажите число" })
        .int("Допуск вниз: целое число сомони")
        .min(0, "Допуск вниз: не меньше нуля")
        .max(MAX_TOLERANCE_DOWN, `Допуск вниз: не больше ${MAX_TOLERANCE_DOWN} сомони — это уже недоплата`),
      toleranceUp: z
        .number({ error: "Допуск вверх: укажите число" })
        .int("Допуск вверх: целое число сомони")
        .min(0, "Допуск вверх: не меньше нуля")
        .max(MAX_TOLERANCE_UP, `Допуск вверх: не больше ${MAX_TOLERANCE_UP} сомони`),
    })
    .optional(),
  offline: z.object({
    price: price("Очный курс"),
    startDate: z
      .string()
      .trim()
      .refine((v) => v === "" || parseIsoDay(v) !== null, "Дата набора: такой даты нет"),
    timeFrom: z.string().trim().regex(HHMM, "Время начала: формат ЧЧ:ММ, например 10:00"),
    timeTo: z.string().trim().regex(HHMM, "Время конца: формат ЧЧ:ММ, например 13:00"),
    address: z.string().trim().min(3, "Адрес: напишите хотя бы улицу").max(200, "Адрес: слишком длинно"),
    seats: z
      .number()
      .int("Мест: целое число")
      .min(1, "Мест: больше нуля или пусто")
      .max(500, "Мест: слишком много")
      .nullable(),
    days: z.number({ error: "Дней: укажите число" }).int().min(1, "Дней: больше нуля").max(60, "Дней: не больше 60"),
    desserts: z
      .number({ error: "Десертов: укажите число" })
      .int()
      .min(1, "Десертов: больше нуля")
      .max(200, "Десертов: не больше 200"),
  }),
});

export type FieldErrors = Record<string, string>;

/** Человеческие названия полей — для журнала и подтверждений. */
export const FIELD_LABELS: Record<string, string> = {
  "prices.course50": "Арт-десерты, цена",
  "prices.course70": "21 рецепт, цена",
  "prices.bundle": "Оба курса, цена",
  "payment.toleranceDown": "Чек: допуск вниз (комиссия банка), сомони",
  "payment.toleranceUp": "Чек: допуск вверх (комиссия сверху), сомони",
  "offline.price": "Очный курс, цена",
  "offline.startDate": "Очный курс, дата набора",
  "offline.timeFrom": "Очный курс, начало занятий",
  "offline.timeTo": "Очный курс, конец занятий",
  "offline.address": "Очный курс, адрес",
  "offline.seats": "Очный курс, мест в группе",
  "offline.days": "Очный курс, дней",
  "offline.desserts": "Очный курс, десертов",
};

export function parseOffer(body: unknown): { offer: Offer } | { errors: FieldErrors } {
  const parsed = offerSchema.safeParse(body);
  if (parsed.success) return { offer: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".") || "offer";
    errors[key] ??= issue.message;
  }
  return { errors };
}

/** Факты офлайн-курса в форме, которую понимают карточка бота и сайт. */
export function offerFacts(offer: Offer): OfflineFacts {
  return {
    price: offer.offline.price,
    days: offer.offline.days,
    hours: hoursValue({ from: offer.offline.timeFrom, to: offer.offline.timeTo }),
    desserts: offer.offline.desserts,
    address: offer.offline.address,
    seats: offer.offline.seats,
  };
}

/** Текущее состояние — из тех же функций, что читают бот и сайт (кэш сброшен). */
export async function readOffer(): Promise<{ offer: Offer; legacyHours: string | null }> {
  resetPriceCache();
  resetSalesTextsCache();
  const [p, facts, start, tol] = await Promise.all([getPrices(), getOfflineFacts(), offlineStartDate(), getPaymentTolerance()]);
  const range = parseHours(facts.hours);
  return {
    offer: {
      prices: { course50: p.price[COURSE_50], course70: p.price[COURSE_70], bundle: p.bundle },
      payment: { toleranceDown: tol.down, toleranceUp: tol.up },
      offline: {
        price: facts.price,
        startDate: start ? toIsoDay(start) : "",
        timeFrom: range?.from ?? "",
        timeTo: range?.to ?? "",
        address: facts.address,
        seats: facts.seats,
        days: facts.days,
        desserts: facts.desserts,
      },
    },
    // Старое время свободным текстом, которое не разобрать в ЧЧ:ММ, — экран
    // попросит указать часы заново, а бот пока говорит текст как есть.
    legacyHours: range ? null : facts.hours,
  };
}

export const OFFER_DEFAULTS: Offer = {
  prices: {
    course50: DEFAULT_PRICES.price[COURSE_50],
    course70: DEFAULT_PRICES.price[COURSE_70],
    bundle: DEFAULT_PRICES.bundle,
  },
  payment: { toleranceDown: DEFAULT_PAYMENT_TOLERANCE.down, toleranceUp: DEFAULT_PAYMENT_TOLERANCE.up },
  offline: {
    price: DEFAULT_OFFLINE_FACTS.price,
    // Дату набора по умолчанию НЕ придумываем: пусто = «дата уточняется».
    startDate: "",
    timeFrom: parseHours(DEFAULT_OFFLINE_FACTS.hours)!.from,
    timeTo: parseHours(DEFAULT_OFFLINE_FACTS.hours)!.to,
    address: DEFAULT_OFFLINE_FACTS.address,
    seats: DEFAULT_OFFLINE_FACTS.seats,
    days: DEFAULT_OFFLINE_FACTS.days,
    desserts: DEFAULT_OFFLINE_FACTS.desserts,
  },
};

type Flat = Record<string, string>;

function flatten(offer: Offer): Flat {
  return {
    "prices.course50": String(offer.prices.course50),
    "prices.course70": String(offer.prices.course70),
    "prices.bundle": String(offer.prices.bundle),
    ...(offer.payment
      ? {
          "payment.toleranceDown": String(offer.payment.toleranceDown),
          "payment.toleranceUp": String(offer.payment.toleranceUp),
        }
      : {}),
    "offline.price": String(offer.offline.price),
    "offline.startDate": offer.offline.startDate,
    "offline.timeFrom": offer.offline.timeFrom,
    "offline.timeTo": offer.offline.timeTo,
    "offline.address": offer.offline.address,
    "offline.seats": offer.offline.seats == null ? "" : String(offer.offline.seats),
    "offline.days": String(offer.offline.days),
    "offline.desserts": String(offer.offline.desserts),
  };
}

export type OfferChangeRow = { field: string; before: string; after: string };

export function diffOffer(before: Offer, after: Offer): OfferChangeRow[] {
  const a = flatten(before);
  const b = flatten(after);
  return Object.keys(b)
    .filter((k) => k in a)
    .filter((k) => a[k] !== b[k])
    .map((field) => ({ field, before: a[field], after: b[field] }));
}

export type PriceJump = { field: string; label: string; before: number; after: number; percent: number };

export type OfferCheck = { errors: FieldErrors; confirm: PriceJump[]; warnings: string[] };

/**
 * Бизнес-проверки поверх формата. Чистая функция: `today` — ГГГГ-ММ-ДД по
 * Душанбе, передаётся снаружи (тестам не нужно двигать часы).
 */
export function checkOffer(before: Offer, after: Offer, today: string): OfferCheck {
  const errors: FieldErrors = {};
  const warnings: string[] = [];
  const confirm: PriceJump[] = [];

  // ДЕНЬГИ: проверка чека (courses.allocate) узнаёт курс по сумме с допуском
  // −DOWN на комиссию банка. Комплект ловится первым — от «цена комплекта −
  // DOWN»; если эта граница не выше самого дорогого курса, оплата одного курса
  // откроет оба. А два курса с почти одной ценой бот не различит по чеку.
  const { course50, course70, bundle } = after.prices;
  const PAYMENT_TOLERANCE_DOWN = after.payment?.toleranceDown ?? DEFAULT_PAYMENT_TOLERANCE.down;
  const top = Math.max(course50, course70);
  if (bundle > course50 + course70)
    errors["prices.bundle"] = `Комплект дороже, чем два курса по отдельности (${course50 + course70})`;
  else if (bundle - PAYMENT_TOLERANCE_DOWN <= top)
    errors["prices.bundle"] =
      `Комплект должен стоить больше ${top + PAYMENT_TOLERANCE_DOWN} сомони: банк удерживает до ${PAYMENT_TOLERANCE_DOWN} сомони, ` +
      `и оплату дорогого курса бот принял бы за комплект`;
  if (Math.abs(course50 - course70) <= 2 * PAYMENT_TOLERANCE_DOWN)
    errors["prices.course70"] =
      `Цены курсов должны отличаться больше чем на ${2 * PAYMENT_TOLERANCE_DOWN} сомони — иначе по чеку не понять, какой курс оплачен`;

  if (after.offline.timeFrom >= after.offline.timeTo)
    errors["offline.timeTo"] = "Конец занятий должен быть позже начала";

  const start = after.offline.startDate;
  if (start && start < today) {
    if (start !== before.offline.startDate)
      errors["offline.startDate"] = "Эта дата уже прошла — выберите будущую или оставьте пусто";
    else warnings.push("Набор в прошлом — клиентам скажем, что дата уточняется");
  }
  if (!start) warnings.push("Дата набора не задана — клиентам скажем, что дата уточняется");
  if (start && start >= today && daysBetween(today, start) > FAR_START_DAYS)
    warnings.push(`Набор больше чем через полгода (${start}) — проверьте год`);

  const priceFields: [string, number, number][] = [
    ["prices.course50", before.prices.course50, course50],
    ["prices.course70", before.prices.course70, course70],
    ["prices.bundle", before.prices.bundle, bundle],
    ["offline.price", before.offline.price, after.offline.price],
  ];
  for (const [field, was, now] of priceFields) {
    if (was > 0 && now !== was && Math.abs(now - was) / was > PRICE_JUMP_CONFIRM) {
      confirm.push({
        field,
        label: FIELD_LABELS[field],
        before: was,
        after: now,
        percent: Math.round(((now - was) / was) * 100),
      });
    }
  }
  return { errors, confirm, warnings };
}

export type BotSays = { ru: string; tg: string };

export type OfferPreview = {
  course50: BotSays;
  course70: BotSays;
  bundle: BotSays;
  /** Карточка, которую бот отправит про очный курс. custom — свой текст из
   *  раздела «Тексты»: бот шлёт его дословно, поля ниже на него не влияют. */
  offline: BotSays & { source: "fields" | "custom" };
};

/**
 * «ТАК СКАЖЕТ БОТ КЛИЕНТУ» — собрано теми же функциями, что работают в бою:
 * offerPricePhrase (правило 17 промта = priceLineRu) и offlineCardDefault
 * (карточка очного курса). Прошедшая дата здесь, как и у бота, превращается в
 * «дата уточняется».
 */
export function offerPreview(
  offer: Offer,
  today: string,
  custom: { ru: string; tg: string } = { ru: "", tg: "" },
): OfferPreview {
  const table = priceTable(offer.prices.course50, offer.prices.course70, offer.prices.bundle);
  const say = (item: OfferItem): BotSays => ({
    ru: offerPricePhrase(item, table, "ru"),
    tg: offerPricePhrase(item, table, "tg"),
  });
  const startIso = offer.offline.startDate && offer.offline.startDate >= today ? offer.offline.startDate : "";
  const start = startIso ? parseIsoDay(startIso) : null;
  const facts = offerFacts(offer);
  const hasCustom = Boolean(custom.ru.trim() || custom.tg.trim());
  return {
    course50: say(COURSE_50),
    course70: say(COURSE_70),
    bundle: say("BUNDLE"),
    offline: {
      ru: custom.ru.trim() || offlineCardDefault("ru", start, facts),
      tg: custom.tg.trim() || offlineCardDefault("tg", start, facts),
      source: hasCustom ? "custom" : "fields",
    },
  };
}

/** Свой текст карточки (раздел «Тексты») — он важнее полей, экран об этом предупреждает. */
export async function customOfflineCard(): Promise<{ ru: string; tg: string }> {
  const [ru, tg] = await Promise.all([getSetting("offlineCourseInfo"), getSetting("offlineCourseInfoTg")]);
  return { ru: ru ?? "", tg: tg ?? "" };
}

/** Кто сохранил после сохранения: сайт (кэш витрины) подписывается здесь, а не
 *  импортируется — так сервис не тянет за собой роутер сайта и ИИ. */
const savedListeners: (() => void)[] = [];
export function onOfferSaved(listener: () => void): void {
  savedListeners.push(listener);
}

export type SaveResult =
  | { status: "invalid"; errors: FieldErrors }
  | { status: "confirm"; confirm: PriceJump[] }
  | { status: "stale" }
  | { status: "ok"; offer: Offer; changes: OfferChangeRow[]; warnings: string[] };

/** Ключ Settings → значение строкой. Часы — одной записью «13:40–16:30». */
function settingValues(offer: Offer): Record<string, string> {
  return {
    priceCourse50: String(offer.prices.course50),
    priceCourse70: String(offer.prices.course70),
    priceBundle: String(offer.prices.bundle),
    ...(offer.payment
      ? {
          receiptToleranceDown: String(offer.payment.toleranceDown),
          receiptToleranceUp: String(offer.payment.toleranceUp),
        }
      : {}),
    [OFFLINE_FACT_KEYS.price]: String(offer.offline.price),
    offlineCourseStartDate: offer.offline.startDate,
    [OFFLINE_FACT_KEYS.hours]: hoursValue({ from: offer.offline.timeFrom, to: offer.offline.timeTo }),
    [OFFLINE_FACT_KEYS.address]: offer.offline.address,
    [OFFLINE_FACT_KEYS.seats]: offer.offline.seats == null ? "" : String(offer.offline.seats),
    [OFFLINE_FACT_KEYS.days]: String(offer.offline.days),
    [OFFLINE_FACT_KEYS.desserts]: String(offer.offline.desserts),
  };
}

export async function saveOffer(
  body: unknown,
  opts: { actor: string; confirmed?: boolean; version: string },
): Promise<SaveResult> {
  const parsed = parseOffer(body);
  if ("errors" in parsed) return { status: "invalid", errors: parsed.errors };
  const next = parsed.offer;
  const [{ offer: before }, today, version] = await Promise.all([readOffer(), localTodayIso(), offerVersion()]);
  if (version !== opts.version) return { status: "stale" };

  const check = checkOffer(before, next, today);
  if (Object.keys(check.errors).length > 0) return { status: "invalid", errors: check.errors };
  if (check.confirm.length > 0 && !opts.confirmed) return { status: "confirm", confirm: check.confirm };

  const changes = diffOffer(before, next);
  const values = settingValues(next);
  const stale = await prisma.$transaction(async (tx) => {
    // Сверка версии ещё раз — уже внутри записи: две вкладки, нажавшие
    // «Сохранить» одновременно, не перезапишут друг друга молча.
    if ((await offerVersion(tx)) !== opts.version) return true;
    // Пишем все ключи, а не только изменённые: значение по умолчанию из кода
    // становится явной записью, и будущая смена умолчания в коде не сдвинет
    // цену, которую владелец видел и сохранял.
    for (const [key, value] of Object.entries(values)) {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
    // Витрина сайта показывает Course.price. Пишем при КАЖДОМ сохранении: если
    // строка курса когда-то разошлась с настройкой (ручная правка, backfill),
    // следующее сохранение её выравнивает.
    await tx.course.updateMany({ where: { code: COURSE_50 }, data: { price: next.prices.course50 } });
    await tx.course.updateMany({ where: { code: COURSE_70 }, data: { price: next.prices.course70 } });
    for (const change of changes) {
      await tx.offerChange.create({ data: { ...change, actor: opts.actor.slice(0, 120) } });
    }
    return false;
  });
  if (stale) return { status: "stale" };

  resetPriceCache();
  resetSalesTextsCache();
  for (const listener of savedListeners) {
    try {
      listener();
    } catch (err) {
      logError("offerService:listener", err);
    }
  }
  return { status: "ok", offer: next, changes, warnings: check.warnings };
}

export type OfferHistoryRow = OfferChangeRow & { label: string; actor: string; at: string };

export async function offerHistory(take = 30): Promise<OfferHistoryRow[]> {
  const rows = await prisma.offerChange.findMany({ orderBy: { createdAt: "desc" }, take });
  return (rows ?? []).map((r) => ({
    field: r.field,
    label: FIELD_LABELS[r.field] ?? r.field,
    before: r.before,
    after: r.after,
    actor: r.actor,
    at: r.createdAt.toISOString(),
  }));
}
