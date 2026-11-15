import { prisma, logError } from "../db.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { ACCEPTED_WHERE } from "../receiptAccepted.js";
import type { ClientLanguage } from "./clientLanguage.js";
import { COURSE_50, COURSE_70, type Course } from "../prices.js";
import { declinesPayment, priceOrChoice } from "./paymentIntent.js";

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

/**
 * ЗАХВАТ «НОМЕР УХОДИТ СЕЙЧАС» (16.11.2026). Номер карты могут отправить почти
 * одновременно двое: шаг воронки (клиент нажал «21 рецепт») и ответ ИИ на вопрос,
 * который клиент дописал через 2 секунды. Оба смотрят историю ДО того, как другой
 * успел записать отправленное, и номер уходил дважды. Захват ставится в памяти
 * процесса синхронно (проверка и запись без await между ними): кто первый, тот
 * шлёт; второй ведёт себя так, будто номер уже в переписке. Живёт столько же,
 * сколько окно повтора; сбой отправки снимает захват (releaseRequisitesClaim).
 */
const requisitesClaims = new Map<string, number>();

function claimedRecently(contactId: string, now = Date.now()): boolean {
  const at = requisitesClaims.get(contactId);
  if (at === undefined) return false;
  if (now - at >= REPEAT_WINDOW_MS) {
    requisitesClaims.delete(contactId);
    return false;
  }
  return true;
}

/** true: номер шлёт вызывающий (захват его); false: его уже шлёт или прислал другой путь. */
export function tryClaimRequisites(contactId: string, now = Date.now()): boolean {
  if (claimedRecently(contactId, now)) return false;
  requisitesClaims.set(contactId, now);
  return true;
}

/** Отправка не удалась: номер не дошёл, следующий путь вправе прислать его. */
export function releaseRequisitesClaim(contactId: string): void {
  requisitesClaims.delete(contactId);
}

/** Только для тестов. */
export function resetRequisitesClaims(): void {
  requisitesClaims.clear();
}

/** Окно, в котором ищем «не надо / позже» после интереса к оплате. */
const DECLINE_LOOKBACK_MS = 24 * 3_600_000;

/**
 * «НЕ НАДО / ПОЗЖЕ»: НОМЕР БОЛЬШЕ НЕ НАВЯЗЫВАЕМ (16.11.2026, дух #86).
 * Смотрим сообщения клиента за сутки по порядку (текущее последним): решает
 * последний сигнал. «Не надо» — молчим про номер; потом сам спросил цену или
 * «куда переводить» — снова можно. Сообщения без сигнала ничего не меняют.
 */
export function declinedInOrder(clientTextsOldestFirst: readonly (string | null | undefined)[]): boolean {
  let declined = false;
  for (const t of clientTextsOldestFirst) {
    if (!t) continue;
    // Вопрос о цене / выбор курса побеждает слово отказа в той же реплике (ревью #99).
    if (priceOrChoice(t) || clientWantsToPayAgain(t)) declined = false;
    else if (declinesPayment(t)) declined = true;
  }
  return declined;
}

export async function requisitesDeclined(contactId: string, currentText = ""): Promise<boolean> {
  try {
    const rows = await prisma.message.findMany({
      where: { contactId, direction: "IN", createdAt: { gte: new Date(Date.now() - DECLINE_LOOKBACK_MS) } },
      orderBy: { createdAt: "asc" },
      take: 40,
      select: { text: true },
    });
    const texts = (rows ?? []).map((r) => r.text);
    // Текущее сообщение уже может лежать в базе последним: второй раз не добавляем.
    if (currentText && texts[texts.length - 1] !== currentText) texts.push(currentText);
    return declinedInOrder(texts);
  } catch (err) {
    logError("repeatGuard:declined", err);
    return false;
  }
}

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
  /** Клиент сказал «не надо / позже» и с тех пор про оплату не спрашивал. */
  requisitesDeclined?: boolean;
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

/** Оплачены оба онлайн-курса: номер для оплаты бесполезен (шаг воронки, ответ ИИ). */
export async function ownsAllCourses(contactId: string): Promise<boolean> {
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
  const [texts, recent, paidWithAccess, accepted, declined] = await Promise.all([
    getSalesTexts(),
    recentOutgoing(contactId),
    hasDeliveredAccess(contactId, clientText),
    hasAcceptedReceipt(contactId),
    requisitesDeclined(contactId, clientText),
  ]);
  return {
    phone: texts.paymentPhone,
    // Номер уже в переписке ИЛИ его прямо сейчас шлёт другой путь (шаг воронки).
    requisitesSentRecently:
      recent.some((t) => mentionsPaymentPhone(t, texts.paymentPhone)) || claimedRecently(contactId),
    requisitesDeclined: declined,
    receiptAskedRecently: recent.some((t) => asksForReceipt(t)),
    paidWithAccess,
    hasAcceptedReceipt: accepted,
    clientAsksToPay: clientWantsToPayAgain(clientText),
  };
}

/** Номер уже в наших сообщениях за окно повтора или его прямо сейчас шлёт другой путь. */
export async function requisitesRecentlySent(contactId: string, phone: string): Promise<boolean> {
  if (claimedRecently(contactId)) return true;
  return (await recentOutgoing(contactId)).some((t) => mentionsPaymentPhone(t, phone));
}

export const ALREADY_WROTE_NUMBER: Record<ClientLanguage, string> = {
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
  // «Не надо / позже»: номер не повторяем, пока клиент сам не спросит, куда платить.
  const dropRequisites = ctx.requisitesSentRecently || (Boolean(ctx.requisitesDeclined) && !ctx.clientAsksToPay);
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
 * Шаг воронки с реквизитами: пропустить текст, если номер только что уходил (или
 * его прямо сейчас шлёт ответ ИИ), человек сказал «не надо / позже» или уже
 * оплатил ОБА онлайн-курса (купившему один номер нужен для второго).
 * Не пропускаем: захват «номер шлю я» ставится здесь же, синхронно с решением;
 * отправка не удалась — вызывающий снимает его (releaseRequisitesClaim).
 * Ошибка базы — шлём как обычно.
 */
export async function shouldSkipRequisitesStep(contactId: string, stepText: string): Promise<boolean> {
  try {
    const texts = await getSalesTexts();
    if (!mentionsPaymentPhone(stepText, texts.paymentPhone)) return false;
    if (await ownsAllCourses(contactId)) return true;
    if (await requisitesDeclined(contactId)) return true;
    const recent = await recentOutgoing(contactId);
    if (recent.some((t) => mentionsPaymentPhone(t, texts.paymentPhone))) return true;
    return !tryClaimRequisites(contactId);
  } catch (err) {
    logError("repeatGuard:step", err);
    return false;
  }
}

/** Подсказка модели на повторный ход: что именно вырезал фильтр и почему. */
const REGENERATE_HINT: Record<string, string> = {
  requisites:
    "номер для оплаты сейчас не пишите: он уже есть в переписке выше (можно сказать, что номер выше) или клиент сказал «не надо / позже»",
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
