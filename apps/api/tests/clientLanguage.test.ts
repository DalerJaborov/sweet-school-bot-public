import assert from "node:assert/strict";
import { detectClientLanguage } from "../src/ai/clientLanguage.js";

/**
 * Язык ответа определяется по КАЖДОМУ сообщению заново — человек посреди разговора
 * переходит с языка на язык, и живой собеседник переходит вместе с ним.
 *
 * Тест написан по живой переписке 22.08.2026, где бот отвечал таджикоязычной
 * женщине по-русски: «Мутаассифона не, апачон — у нас только кондитерские курсы».
 * Половина фразы на её языке, половина на чужом. Причина: язык узнавался ТОЛЬКО по
 * буквам ӣӯҳқҷғ, а в Душанбе половина пишет обычной кириллицей без них.
 *
 * Запуск: npx tsx apps/api/tests/clientLanguage.test.ts
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

// --- Живые фразы из переписки, на которых бот ошибался ---
check("«Курси Салат Доред» — таджикский", detectClientLanguage("Курси Салат Доред"), "tg");
check("«Сливкаш Чи намуд бошад Ман нофахмидам»", detectClientLanguage("Сливкаш Чи намуд бошад Ман нофахмидам"), "tg");
check("«Максад имено бояд хамун шири бозори бошад»", detectClientLanguage("Максад имено бояд хамун шири бозори бошад"), "tg");
check("«Мара добавит мекнен»", detectClientLanguage("Мара добавит мекнен"), "tg");

// --- С особыми буквами (работало и раньше) ---
check("с буквами ӣӯҳқҷғ", detectClientLanguage("Салом апаҷон, курс чӣ хел аст?"), "tg");

// --- Русский остаётся русским ---
check("«Здравствуйте»", detectClientLanguage("Здравствуйте"), "ru");
check("«Подскажите пожалуйста сколько стоит торт ?»", detectClientLanguage("Подскажите пожалуйста сколько стоит торт ?"), "ru");
check("«Мне нужен торт а не рецепт»", detectClientLanguage("Мне нужен торт а не рецепт"), "ru");

// --- Английский ---
check("«Hello, how much is the course?»", detectClientLanguage("Hello, how much is the course?"), "en");
check("«Do you sell cakes?»", detectClientLanguage("Do you sell cakes?"), "en");
// Латиница, но таджикская речь — не английский.
check("«Salom apajon» — не английский", detectClientLanguage("Salom apajon"), "tg");

// --- Границы слов: «ман» внутри другого слова ничего не значит ---
check("«манго» не делает фразу таджикской", detectClientLanguage("Есть курс где манго используют?"), "ru");
check("«команда» не делает фразу таджикской", detectClientLanguage("Какая у вас команда преподавателей?"), "ru");

// --- Пусто: язык школы, а не чужой ---
check("пустой текст — таджикский", detectClientLanguage(""), "tg");

console.log(failures === 0 ? "\nВсе проверки прошли" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
