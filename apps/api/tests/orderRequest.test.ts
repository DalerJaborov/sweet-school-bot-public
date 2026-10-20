import assert from "node:assert/strict";
import { guardOffTopic, guardReply } from "../src/ai/offTopicGuard.js";

/**
 * Заказ готового изделия: школа только учит и НИКОГДА не продаёт торты.
 *
 * Тест написан по живому диалогу 22.08.2026, где бот потерял покупательницу:
 *
 *   — Подскажите пожалуйста сколько стоит торт ?
 *   — Апачон, по рецептам у нас чат в телеграм-группе... (то есть мимо)
 *   — Мне нужен торт, а не рецепт
 *   — (молчание)
 *
 * Человек пришёл купить торт и ушёл, так и не услышав внятного «мы не продаём».
 * Причина: отсечка искала глаголы «заказать/испечь», а покупатель спрашивает
 * ЦЕНУ и НАЛИЧИЕ. Вторая половина проверки не менее важна первой: вопрос про
 * цену КУРСА обязан остаться вопросом про курс, иначе, чиня одно, сломаем продажи.
 *
 * Запуск: npx tsx apps/api/tests/orderRequest.test.ts
 */

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch {
    failures += 1;
    console.error(`FAIL ${name}: получили ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`);
  }
}

const kindOf = (text: string): string | null => guardOffTopic(text)?.kind ?? null;

// --- То, из-за чего всё началось ---
check("«сколько стоит торт» — это заказ, а не вопрос про рецепт", kindOf("Подскажите пожалуйста сколько стоит торт ?"), "order_request");
check("«мне нужен торт, а не рецепт»", kindOf("Мне нужен торт а не рецепт"), "order_request");

// --- Как ещё спрашивает покупатель ---
check("«почём чизкейк»", kindOf("почём чизкейк?"), "order_request");
check("«продаёте ли десерты»", kindOf("Вы продаете десерты?"), "order_request");
check("«есть готовые торты»", kindOf("есть у вас готовые торты"), "order_request");
check("«хочу купить торт»", kindOf("хочу купить торт на день рождения"), "order_request");
check("прежний путь через глагол заказа жив", kindOf("сделаете торт на заказ?"), "order_request");
check("«принимаете заказы» без названия изделия", kindOf("вы принимаете заказы?"), "order_request");

// --- Продажи курса ломать нельзя ---
check("цена КУРСА остаётся вопросом про курс", kindOf("сколько стоит курс?"), null);
check("цена курса по тортам — тоже про курс", kindOf("сколько стоит курс по тортам?"), null);
check("«хочу записаться»", kindOf("хочу записаться на курс"), null);
check("вопрос про состав курса", kindOf("а сколько рецептов входит в курс?"), null);
check("«есть ли доступ в телеграм»", kindOf("есть доступ в телеграм группу?"), null);

// --- Сам ответ: вежливый отказ БЕЗ допродажи (решение владельца 22.08.2026) ---
const ru = guardReply("order_request", "ru");
const tg = guardReply("order_request", "tg");
check("отказ по-русски не предлагает курс", /курс/i.test(ru), false);
check("отказ по-таджикски не предлагает курс", /курс|таълим/i.test(tg), false);
check("отказ по-русски остаётся вежливым", /к сожалению/i.test(ru), true);
check("отказ по-таджикски остаётся вежливым", /мутаассифона/i.test(tg), true);

// --- Ни один шаблон не предлагает курс (решение владельца 22.08.2026) ---
// «Люди не любят таких в нашей стране»: человеку, которому только что отказали, не
// место предложению купить. Проверяем ВСЕ шаблоны разом, а не только заказы, —
// иначе допродажа тихо вернётся в первый же новый вид отказа.
for (const kind of ["probing", "offtopic", "task_request", "no_such_course", "order_request", "recipe_question"] as const) {
  for (const lang of ["ru", "tg"] as const) {
    const reply = guardReply(kind, lang);
    check(`${kind}/${lang} — без допродажи`, /давайте|биёед|лучше расскажу|хотите, расскажу/i.test(reply), false);
  }
}

// --- Закрытая телеграм-группа: звать туда можно только оплативших ---
// Живой случай 22.08.2026: женщина спросила про торт и получила «по рецептам у нас
// чат в телеграм-группе, напишите туда» — а она ничего не покупала. Группа закрытая,
// дверь для неё не откроется, да и раздавать там нечего тем, кто не платил.
const GROUP_MENTION = /телеграм|telegram|групп|group|гурӯҳ|гурух/i;
for (const lang of ["ru", "tg", "en"] as const) {
  const guest = guardReply("recipe_question", lang, false);
  const student = guardReply("recipe_question", lang, true);
  check(`гостю (${lang}) не предлагают закрытую группу`, GROUP_MENTION.test(guest), false);
  check(`ученице (${lang}) группу предлагают`, GROUP_MENTION.test(student), true);
  check(`гостю (${lang}) не продают курс вдогонку`, /курс|course/i.test(guest), false);
}

// --- Просьба позвать живого человека ---
// Раньше у бота было два исхода: ответить самому или молчать. Человек, прямо
// попросивший Ширин, получал очередной ответ бота и повторял просьбу.
check("«хочу поговорить с Ширин»", kindOf("хочу поговорить с Ширин"), "wants_human");
check("«позовите живого человека»", kindOf("позовите пожалуйста живого человека"), "wants_human");
check("«Ширин кати гап занам»", kindOf("Ширин кати гап занам мешава"), "wants_human");
check("обычный вопрос про курс не зовёт человека", kindOf("сколько стоит курс?"), null);
for (const lang of ["ru", "tg", "en"] as const) {
  check(`обещание позвать (${lang}) не пустое`, guardReply("wants_human", lang).length > 5, true);
}

// --- Ни один шаблон не содержит смайликов (решение владельца 22.08.2026) ---
// «Они выдают бота»: одинаковый значок в конце каждого ответа — подпись автомата.
// Живой человек то поставит смайлик, то нет, и всегда разный.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
for (const kind of [
  "probing",
  "offtopic",
  "task_request",
  "no_such_course",
  "order_request",
  "recipe_question",
  "wants_human",
] as const) {
  for (const lang of ["ru", "tg", "en"] as const) {
    check(`${kind}/${lang} — без смайликов`, EMOJI.test(guardReply(kind, lang)), false);
  }
}
for (const lang of ["ru", "tg", "en"] as const) {
  check(`гостю про рецепты (${lang}) — без смайликов`, EMOJI.test(guardReply("recipe_question", lang, false)), false);
}

console.log(failures === 0 ? "\nВсе проверки прошли" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
