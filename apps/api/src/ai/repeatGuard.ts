import { prisma, logError } from "../db.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { ACCEPTED_WHERE } from "../receiptAccepted.js";
import type { ClientLanguage } from "./clientLanguage.js";
import { COURSE_50, COURSE_70, type Course } from "../prices.js";

/**
 * РЕКВИЗИТЫ И «ПРИШЛИТЕ ЧЕК» — НЕ ЧАЩЕ ОДНОГО РАЗА (владелец 11.11.2026).
 *
 * Разбор 48 часов переписок: номер и «фиристед чек» уходили 3–5 раз за пару
 * минут. Источников четыре, и каждый сам по себе прав: шаг воронки с номером,
 * ответ ИИ («как оплатить?»), повторный ответ ИИ на следующий пузырь и
 * подтверждение экрана перевода. Вместе — назойливость, от которой уходят.
 * И хуже: чек просили у того, кто уже заплатил и получил ссылку.
 *
 * ОДНА ДВЕРЬ на весь класс: и ai.ts (ответ модели), и funnel.ts (шаг воронки)
 * спрашивают здесь, можно ли сейчас назвать номер или попросить чек.
 *
 *  - номер уже был в наших сообщениях за последние REPEAT_WINDOW_MS — не повторяем;
 *  - «пришлите чек» уже просили за то же окно — не повторяем;
 *  - человек уже оплатил ТОТ курс, о котором речь (ревью 11.11.2026: по курсу, а не
 *    по человеку — купил «21 рецепт», спрашивает про арт-десерты, и ему нужен чек), —
 *    чек не просим никогда. Реквизиты оплатившему НЕ режем: номер нужен для второго
 *    курса, а повтор и так ловит окно в 15 минут;
 *  - «чек получили / приняли» без принятого чека — не говорим (ложное «принято»).
 */
export const REPEAT_WINDOW_MS = 15 * 60_000;
/** Сколько наших последних сообщений смотреть, кроме окна по времени. */
const RECENT_OUT = 8;

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** Есть ли в тексте наш номер для оплаты (с пробелами, дефисами, кодом 992). */
export function mentionsPaymentPhone(text: string, phone: string): boolean {
  const want = digitsOf(phone);
  if (want.length < 6) return false;
  return digitsOf(text).includes(want);
}

/** Просьба прислать чек — по-русски и по-таджикски, в любой форме. */
const RECEIPT_ASK =
  /(пришлите|присылайте|скиньте|отправьте|скинь|пришли|киньте)[^.!?\n]{0,25}(чек|скрин|квитанц)|(чек|скрин)\p{L}*[^.!?\n]{0,25}(пришлите|скиньте|отправьте|фирист\p{L}*|равон\s+кун\p{L}*|партоед|партоен|монед|монен)|(фиристед|фиристен|равон\s+кунед|партоед)[^.!?\n]{0,15}чек/iu;

export function asksForReceipt(text: string): boolean {
  return RECEIPT_ASK.test(text);
}

/** «Чек получили», «Кабул кардем», «Оплата принята» — подтверждение оплаты. */
const RECEIPT_ACK =
  /(кабул\s+кард(ем|ам|им)|қабул\s+кард(ем|ам|им)|кабул\s+шуд|қабул\s+шуд|чек\p{L}*\s+(гирифт(ем|ам)|омад)|(оплат\p{L}*|чек|перевод)\s+(принят|получ\p{L}+)|(принял[аи]?|получил[аи]?)\s+(ваш\s+)?(чек|оплату|перевод))/iu;

export function claimsReceiptAccepted(text: string): boolean {
  return RECEIPT_ACK.test(text);
}

/** Человек спрашивает про ВТОРОЙ курс или прямо про реквизиты — тогда номер уместен и после оплаты. */
const WANTS_MORE =
  /(второй|другой|ещё\s+один|еще\s+один|дигар|дуюм|боз\s+як)\s*курс|(арт|21)[^.!?\n]{0,20}(тоже|хам|ҳам)|(куда|как)\s+(перев|оплат|скинуть|отправить)|номер\p{L}*\s*(карт|для|барои)|(ракам|номер)\p{L}*\s*(дихед|диҳед|нависед|партоед)|(чи\s*хел|чихел|чӣ\s*хел)\s+(пардохт|пул\s+партоям|гузаронам)/iu;

export function clientWantsToPayAgain(text: string): boolean {
  return WANTS_MORE.test(text ?? "");
}

export type RepeatContext = {
  phone: string;
  /** Номер уже был в наших недавних сообщениях. */
  requisitesSentRecently: boolean;
  /** «Пришлите чек» уже звучало недавно. */
  receiptAskedRecently: boolean;
  /** Оплачен курс, о котором сейчас речь (или оба онлайн-курса) — чек не просим. */
  paidWithAccess: boolean;
  /** Есть принятый чек — можно говорить «принято». */
  hasAcceptedReceipt: boolean;
  /** Клиент в этом ходе сам спросил про оплату второго курса / реквизиты. */
  clientAsksToPay: boolean;
};

async function recentOutgoing(contactId: string): Promise<string[]> {
  try {
    const rows = await prisma.message.findMany({
      where: { contactId, direction: "OUT", text: { not: null } },
      orderBy: { createdAt: "desc" },
      take: RECENT_OUT,
      select: { text: true, createdAt: true },
    });
    const since = Date.now() - REPEAT_WINDOW_MS;
    return (rows ?? []).filter((r) => r.createdAt && r.createdAt.getTime() >= since).map((r) => r.text ?? "");
  } catch (err) {
    logError("repeatGuard:recent", err);
    return [];
  }
}

const ONLINE_COURSES: readonly Course[] = [COURSE_50, COURSE_70];

/** Какой курс назван в сообщении клиента (может быть оба или ни одного). */
const COURSE_MENTION: Record<Course, RegExp> = {
  [COURSE_50]: /(?<!\p{L})арт(?!\p{L})|арт[\s-]*(десерт|ширин)\p{L}*|art[\s-]*dessert|(?<!\d)50(?!\d)/iu,
  [COURSE_70]: /(?<!\d)21(?!\d)|двадцать\s+од\p{L}*|бисту\s+як|(?<!\d)70(?!\d)/iu,
};

export function mentionedCourses(text: string): Course[] {
  return ONLINE_COURSES.filter((c) => COURSE_MENTION[c].test(text ?? ""));
}

/**
 * ОПЛАЧЕННОЕ ПОКРЫВАЕТ ТО, О ЧЁМ РЕЧЬ (ревью 11.11.2026). Раньше «оплатил и получил
 * ссылку» считалось по человеку: купившая «21 рецепт» писала «хочу ещё арт-десерты»,
 * и бот вырезал из ответа просьбу прислать чек — она платила и ждала.
 *  - оба онлайн-курса оплачены — покупать больше нечего: true;
 *  - один оплачен, а клиент называет другой курс или сам спрашивает, куда платить, — false;
 *  - один оплачен, другой не назван — речь о купленном: true.
 * «Оплачен» = действующая покупка (не отозвана), с выданной ссылкой или без: ссылку
 * могла дать Ширин сама или она ждёт выбора «Telegram или сайт» — чек всё равно уже был.
 */
export function accessCovers(owned: readonly string[], clientText: string): boolean {
  if (owned.length === 0) return false;
  if (ONLINE_COURSES.every((c) => owned.includes(c))) return true;
  if (clientWantsToPayAgain(clientText)) return false;
  return !mentionedCourses(clientText).some((c) => !owned.includes(c));
}

async function paidCourses(contactId: string): Promise<string[]> {
  const rows = await prisma.purchase.findMany({ where: { contactId, revokedAt: null }, select: { course: true } });
  return [...new Set((rows ?? []).map((r) => r.course))];
}

/** Оплачен ли курс, о котором пишет клиент (см. accessCovers). Сбой базы — «нет»: лучше лишний раз спросить чек. */
export async function hasDeliveredAccess(contactId: string, clientText = ""): Promise<boolean> {
  try {
    return accessCovers(await paidCourses(contactId), clientText);
  } catch (err) {
    logError("repeatGuard:access", err);
    return false;
  }
}

/** Оплачены оба онлайн-курса — номер для оплаты в шаге воронки бесполезен. */
async function ownsAllCourses(contactId: string): Promise<boolean> {
  const owned = await paidCourses(contactId);
  return ONLINE_COURSES.every((c) => owned.includes(c));
}

async function hasAcceptedReceipt(contactId: string): Promise<boolean> {
  try {
    const n = await prisma.receiptCheck.count({
      where: { contactId, OR: ACCEPTED_WHERE },
    });
    return (n ?? 0) > 0;
  } catch (err) {
    logError("repeatGuard:receipt", err);
    return false;
  }
}

export async function loadRepeatContext(contactId: string, clientText: string): Promise<RepeatContext> {
  const [texts, recent, paidWithAccess, accepted] = await Promise.all([
    getSalesTexts(),
    recentOutgoing(contactId),
    hasDeliveredAccess(contactId, clientText),
    hasAcceptedReceipt(contactId),
  ]);
  return {
    phone: texts.paymentPhone,
    requisitesSentRecently: recent.some((t) => mentionsPaymentPhone(t, texts.paymentPhone)),
    receiptAskedRecently: recent.some((t) => asksForReceipt(t)),
    paidWithAccess,
    hasAcceptedReceipt: accepted,
    clientAsksToPay: clientWantsToPayAgain(clientText),
  };
}

const ALREADY_WROTE_NUMBER: Record<ClientLanguage, string> = {
  ru: "Номер я написала выше",
  tg: "Номерро болотар навиштам",
  en: "I wrote the number above",
};

/** Предложения ответа (по строкам и по точкам), чтобы вырезать лишнее, не ломая остальное. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Убирает из ответа модели то, что сейчас повторять нельзя. Возвращает текст
 * (возможно пустой — тогда отвечать нечего) и что убрано — для журнала.
 */
export function withoutRepeats(
  reply: string,
  ctx: RepeatContext,
  language: ClientLanguage,
): { text: string; removed: string[] } {
  const removed = new Set<string>();
  // Реквизиты режем только как повтор (ревью 11.11.2026): оплатившему один курс номер
  // нужен для второго. Просьбу чека — повтор или курс уже оплачен (accessCovers).
  const dropRequisites = ctx.requisitesSentRecently;
  const dropReceiptAsk = ctx.receiptAskedRecently || ctx.paidWithAccess;
  const kept = sentences(reply).filter((s) => {
    if (dropRequisites && mentionsPaymentPhone(s, ctx.phone)) {
      removed.add("requisites");
      return false;
    }
    if (dropReceiptAsk && asksForReceipt(s)) {
      removed.add("receipt_ask");
      return false;
    }
    if (!ctx.hasAcceptedReceipt && claimsReceiptAccepted(s)) {
      removed.add("false_receipt_ack");
      return false;
    }
    return true;
  });
  if (removed.size === 0) return { text: reply, removed: [] };
  let text = kept.join("\n").trim();
  // Человек переспросил номер, а он только что был: короткое «номер выше», а не тишина.
  if (!text && removed.has("requisites") && ctx.requisitesSentRecently) {
    text = ALREADY_WROTE_NUMBER[language];
  }
  return { text, removed: [...removed] };
}

/**
 * Шаг воронки с реквизитами: пропустить текст, если номер только что уходил или
 * человек уже оплатил ОБА онлайн-курса (купившему один номер нужен для второго).
 * Ошибка базы — шлём как обычно.
 */
export async function shouldSkipRequisitesStep(contactId: string, stepText: string): Promise<boolean> {
  try {
    const texts = await getSalesTexts();
    if (!mentionsPaymentPhone(stepText, texts.paymentPhone)) return false;
    if (await ownsAllCourses(contactId)) return true;
    const recent = await recentOutgoing(contactId);
    return recent.some((t) => mentionsPaymentPhone(t, texts.paymentPhone));
  } catch (err) {
    logError("repeatGuard:step", err);
    return false;
  }
}

/** Подсказка модели на повторный ход: что именно вырезал фильтр и почему. */
const REGENERATE_HINT: Record<string, string> = {
  requisites: "номер для оплаты уже есть в переписке выше, не повторяйте его (можно сказать, что номер выше)",
  receipt_ask: "просить прислать чек сейчас нельзя: уже просили или этот курс уже оплачен",
  false_receipt_ack: "не пишите, что чек принят: принятого чека нет",
  cleanup: "ответ был пустым или из одних значков",
};

/**
 * ПОСЛЕ ФИЛЬТРОВ ОТВЕТ ПУСТ (ревью 11.11.2026): раньше бот просто молчал. Один
 * повторный ход модели с прямой подсказкой, что убрано.
 *  - вернулся непустой текст, прошедший те же фильтры, — его и отправляем;
 *  - модель явно сказала [NO_REPLY] — "" (законное молчание);
 *  - ошибка, нарушение фактов или снова пусто — null: вызывающий передаёт разговор
 *    человеку (ai.ts::handOffUnknownToShirin), а не молчит.
 * `generate` возвращает уже очищенный текст, null на ошибку и сырое [NO_REPLY].
 */
export async function regenerateAfterFilters(
  removed: string[],
  generate: (extraInstruction: string) => Promise<string | null>,
  ctx: RepeatContext,
  language: ClientLanguage,
): Promise<string | null> {
  const hints = removed.map((r) => REGENERATE_HINT[r]).filter(Boolean);
  const extra =
    `\n\nИсправьте ответ: ${hints.join("; ")}. Ответьте на последний вопрос клиента по-другому, коротко. ` +
    "Если отвечать нечего, верните ровно [NO_REPLY].";
  let raw: string | null;
  try {
    raw = await generate(extra);
  } catch (err) {
    logError("repeatGuard:regenerate", err);
    return null;
  }
  if (raw === null) return null;
  if (raw.trim() === "[NO_REPLY]") return "";
  const again = withoutRepeats(raw, ctx, language);
  return again.text.trim() ? again.text : null;
}
