import { generateWithFallback, thinkingConfigFor } from "../gemini.js";
import { getSetting, logError } from "../db.js";
import { DEFAULT_OFFSET_HOURS, parseReceiptDate } from "./receiptDate.js";
import { logAiCall } from "./aiLog.js";
import type { MediaPart } from "./media.js";
import { COURSE_50, COURSE_70, COURSE_TITLE, DEFAULT_PRICES, type PriceTable } from "../prices.js";
import { getPrices } from "../services/priceService.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { DEFAULT_SALES_TEXTS } from "./prompts.js";

export type ReceiptVerdict = {
  /** pre_transfer — экран ДО перевода: человек ввёл наш номер, банк показал имя
   *  получателя (или форму суммы), и он прислал это как «проверьте, правильно?».
   *  Это не чек и не подозрение — на такое отвечаем «да, номер и имя верные». */
  kind: "not_receipt" | "pre_transfer" | "valid" | "suspicious";
  confidence: number;
  reason: string;
  /** Сумма перевода, если разборчива — по ней код выбирает, в какую группу
   *  (курс за 50 или за 70 сомони) отправить одноразовую ссылку. null — не
   *  разобрать: код тогда не угадывает курс сам, а оставляет на решение владельца. */
  amount: number | null;
  /** Валюта суммы с чека: TJS, RUB, USD… Люди платят из России и из-за границы,
   *  и в чеке стоит «635 ₽» — код переведёт это в сомони по курсу сам. */
  currency: string | null;
  /** Дата/время, которые видны прямо НА чеке (если разборчиво) — не время, когда
   *  сообщение дошло до бота. null — не разобрать (мелкий шрифт, обрезано). */
  receiptAt: Date | null;
  /** МЯГКИЙ сигнал: похоже, что именно поле суммы или даты отредактировано на
   *  иначе настоящем чеке (кто-то поправил цифру на скриншоте своего же более
   *  мелкого перевода). НЕ основание отклонять или одобрять автоматически —
   *  зрение модели тут регулярно ошибается в обе стороны. Только повод показать
   *  чек человеку глазами (handleReceiptVerdict переводит true в "suspicious",
   *  что и так уводит чек на карточку владельцу, а не отклоняет его). */
  tamperingSuspected: boolean;
};

/** Разбор чека — единственный ход, где отказ модели стоит денег: человек уже
 *  заплатил. Даём больше времени, чем обычному ответу, и не жалеем попыток. */
const BUDGET_MS = 75_000;

/**
 * Отдельный, структурированный запрос к Gemini — специально ДРУГОЙ вызов, а не
 * часть обычного разговора: обычный ответ бот пишет свободным текстом по промту
 * владельца, а здесь нужен строгий вердикт, на который код может положиться —
 * от него зависит, уйдёт ли клиенту ссылка доступа к курсу.
 *
 * Реквизиты (получатель, номер) зашиты прямо в инструкцию — если на фото
 * другое имя или другой номер, это ровно то, что должно понижать доверие.
 * Цены и реквизиты — те же, что у allocate() и правил бота (раздел «Тексты и
 * цены»): проверка чека не должна разойтись с тем, что бот назвал клиентке.
 * Экспортирована для теста на согласованность цен; без аргументов — умолчания.
 */
export function buildInstruction(
  p: PriceTable = DEFAULT_PRICES,
  payment: { phone: string; banks: string; recipient: string } = {
    phone: DEFAULT_SALES_TEXTS.paymentPhone,
    banks: DEFAULT_SALES_TEXTS.paymentBanks,
    recipient: DEFAULT_SALES_TEXTS.paymentRecipient,
  }
): string {
  const phoneDigits = payment.phone.replace(/\D/g, "");
  const phone = phoneDigits.startsWith("992") ? `+${phoneDigits}` : `+992${phoneDigits}`;
  return (
    "Ты проверяешь скриншот, который клиент прислал в директ авторского кондитерского курса Ширин как чек об оплате. " +
    `Наши реквизиты для перевода: ${payment.banks} на номер ${phone}, получатель — ${payment.recipient}. ` +
    `Ожидаемые суммы: ${p.price[COURSE_50]} сомони (курс «${COURSE_TITLE[COURSE_50]}»), ${p.price[COURSE_70]} сомони ` +
    `(курс «${COURSE_TITLE[COURSE_70]}»), ${p.bundle} сомони (оба курса вместе — обычная цена комплекта) или ` +
    `${p.bundleFull} сомони (оба курса по сумме двух цен); сумма на чеке решает, какой доступ открыть. ` +
    'Определи: это вообще похоже на скриншот банковского перевода/чека ("valid" или "suspicious"), ' +
    'или это не чек вовсе — фото десерта, мем, случайная картинка ("not_receipt"), ' +
    'или это ЭКРАН ДО ПЕРЕВОДА ("pre_transfer"): человек ввёл номер получателя в Алиф / Душанбе Сити / другой банк, ' +
    "приложение показало имя получателя и/или поле суммы, но кнопка «Перевести/Подтвердить» ещё не нажата — нет строки " +
    "«успешно», нет номера транзакции, нет чека. Такой скриншот люди присылают, чтобы спросить «правильно ли я ввёл?». " +
    'Это НЕ "suspicious" и не "valid" — именно "pre_transfer". ' +
    'Если это чек и получатель/номер совпадают с нашими реквизитами (или скриншот слишком мал/обрезан, чтобы ' +
    'проверить точно, но в целом похож на настоящий перевод) — "valid". ' +
    "ВАЖНО про имя получателя: в официальных чеках Алиф на перевод внутри самого Алиф (Alif-to-Alif) в поле " +
    "получателя вместо личного имени часто стоит просто «Alif» — это нормальный формат самого приложения, а не " +
    "подделка. Если номер получателя совпадает с нашим (+992905355355 / 905355355), а имя получателя — «Alif» " +
    "(или отсутствует), это НЕ повод считать чек подозрительным — номер важнее имени в этом случае. " +
    'Если это явно чек, но НОМЕР получателя другой (не наш), или сумма нулевая/отменена, или похоже на подделку/ ' +
    'скриншот старого чужого чека — "suspicious". ' +
    "Отдельно вытащи сумму перевода числом — ровно ту, что видна на чеке, БЕЗ ПЕРЕСЧЁТА. " +
    "Рядом верни валюту этой суммы кодом: TJS (сомони), RUB (рубли), USD, EUR, KZT, TRY. " +
    "ВАЖНО: клиенты часто платят из России и из-за границы, и на чеке две суммы — списанная в рублях и " +
    "зачисленная в сомони. Если видна строка «сумма зачисления» в сомони — бери ЕЁ и валюту TJS. " +
    "Если её нет, бери списанную сумму и её валюту. Не разобрать сумму — верни null, НЕ ГАДАЙ. " +
    "Отдельно вытащи дату и время, которые НАПЕЧАТАНЫ прямо на самом чеке (не сегодняшнюю дату, а именно дату " +
    "перевода с картинки) в формате ISO 8601 (например 2026-08-21T14:30:00) — если год не виден, возьми текущий год. " +
    "Не разобрать дату/время — верни null, НЕ ПРИДУМЫВАЙ. " +
    "ОТДЕЛЬНО, только если это похоже на чек (не для not_receipt): присмотрись именно к полю суммы и к полю " +
    "даты — нет ли следов, что цифры в НИХ отредактированы поверх иначе настоящего скриншота (например, кто-то " +
    "подправил свой же перевод на меньшую сумму, чтобы он совпал с ценой курса). Признаки редактирования именно " +
    "в этом числе, а не во всём изображении: шрифт, толщина или межбуквенные интервалы отличаются от того же " +
    "шрифта в остальном чеке; цифры сидят на другой базовой линии, чуть выше/ниже соседнего текста; вокруг " +
    "именно этих цифр другая резкость, сглаживание или JPEG-артефакты, чем на остальном скриншоте; тень или " +
    "блик на цифрах не совпадает по направлению света с остальной картинкой; цифры чуть смещены от сетки " +
    "пикселей, на которой стоят остальные цифры того же чека. Верни это отдельным булевым полем " +
    'tamperingSuspected. ЭТО МЯГКИЙ СИГНАЛ ДЛЯ ЧЕЛОВЕКА, А НЕ ВЕРДИКТ: ты, скорее всего, ошибёшься — сжатие ' +
    "изображения, повторное сохранение скриншота и особенности телефона сами по себе создают такие же артефакты. " +
    "Ставь true только при явных, заметных признаках именно локального редактирования одного числа, а не при " +
    "лёгком сомнении; при малейшей неуверенности — false. Это поле никогда не должно САМО отклонять настоящую " +
    "оплату — оно только просит человека посмотреть внимательнее. " +
    "Ответь СТРОГО JSON без пояснений вокруг: " +
    '{"kind":"valid"|"suspicious"|"not_receipt"|"pre_transfer","confidence":0-100,"amount":число или null,"currency":"TJS"|"RUB"|"USD"|"EUR"|"KZT"|"TRY"|null,' +
    '"receiptAt":"2026-08-21T14:30:00" или null,"tamperingSuspected":true|false,"reason":"короткая причина по-русски"}'
  );
}

function parseVerdict(raw: string, offsetHours: number = DEFAULT_OFFSET_HOURS): ReceiptVerdict | null {
  const cleaned = raw.replace(/^```json\s*|^```\s*|```\s*$/gim, "").trim();
  try {
    const data = JSON.parse(cleaned) as Partial<ReceiptVerdict> & { receiptAt?: string | null };
    if (data.kind !== "valid" && data.kind !== "suspicious" && data.kind !== "not_receipt" && data.kind !== "pre_transfer") return null;
    const parsedDate = data.receiptAt ? parseReceiptDate(data.receiptAt, offsetHours) : null;
    return {
      kind: data.kind,
      confidence: typeof data.confidence === "number" ? Math.max(0, Math.min(100, data.confidence)) : 0,
      amount: typeof data.amount === "number" && Number.isFinite(data.amount) ? data.amount : null,
      currency: typeof data.currency === "string" && data.currency.trim() ? data.currency.trim().toUpperCase() : null,
      receiptAt: parsedDate,
      tamperingSuspected: data.tamperingSuspected === true,
      reason: typeof data.reason === "string" ? data.reason.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}

/** null — не удалось получить внятный вердикт (сеть, модель отказала). Разговор
 *  в этом случае идёт своим чередом — просто ссылку никто не отправит сам. */
export async function checkReceipt(imagePart: MediaPart, model: string, apiKeys: string[]): Promise<ReceiptVerdict | null> {
  const startedAt = Date.now();
  const [prices, texts] = await Promise.all([getPrices(), getSalesTexts()]);
  const instruction = buildInstruction(prices, {
    phone: texts.paymentPhone,
    banks: texts.paymentBanks,
    recipient: texts.paymentRecipient,
  });
  const result = await generateWithFallback(
    apiKeys,
    model,
    (m) =>
      JSON.stringify({
        contents: [{ role: "user", parts: [imagePart, { text: instruction }] }],
        generationConfig: {
          thinkingConfig: thinkingConfigFor(m),
          // +20 от прежних 200: одно новое булево поле в ответе, вписывается в
          // тот же бюджет с запасом — не второй вызов, просто чуть шире потолок.
          maxOutputTokens: 220,
          responseMimeType: "application/json",
        },
      }),
    BUDGET_MS
  );
  if ("error" in result) {
    logError("receiptCheck", result.error);
    void logAiCall({ endpoint: "receipt-check", ms: Date.now() - startedAt, ok: false });
    return null;
  }
  void logAiCall({ endpoint: "receipt-check", model: result.model, usage: result.usage, ms: Date.now() - startedAt, ok: true });
  if (!result.text) return null;
  // Смещение — из той же настройки, что у отчётов и ночного обучения: часовой пояс
  // у школы один, и второго места, где он задаётся, быть не должно.
  const offsetHours = Number((await getSetting("timezoneOffsetHours"))?.trim());
  const verdict = parseVerdict(result.text, Number.isFinite(offsetHours) ? offsetHours : DEFAULT_OFFSET_HOURS);
  if (!verdict) logError("receiptCheck", `Gemini вернул не-JSON: ${result.text.slice(0, 200)}`);
  return verdict;
}

/**
 * Из вердиктов по всем фото сообщения выбираем один: настоящий чек важнее
 * подозрительного, подозрительный — экрана «до перевода», тот — «не чек».
 * Экспортирована для теста.
 */
export function pickReceiptVerdict<T extends { verdict: ReceiptVerdict }>(items: (T | null)[]): T | null {
  const rank: Record<ReceiptVerdict["kind"], number> = { valid: 3, suspicious: 2, pre_transfer: 1, not_receipt: 0 };
  let best: T | null = null;
  for (const item of items) {
    if (!item) continue;
    if (!best || rank[item.verdict.kind] > rank[best.verdict.kind]) best = item;
  }
  return best;
}
