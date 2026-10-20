import assert from "node:assert/strict";
import { hasDoubtSignal } from "../src/ai/testimonials.js";

/**
 * Детектор «клиент засомневался» — код-триггер для отправки скриншота
 * настоящего отзыва прямо в директ (см. ai/testimonials.ts). Ловит только
 * явные признаки колебания, не обычный разговор о курсе.
 *
 * Запуск: npx tsx apps/api/tests/testimonialDoubt.test.ts
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

// --- Должно сработать ---
check("«я сомневаюсь»", hasDoubtSignal("я как-то сомневаюсь, стоит ли"), true);
check("«не уверена, что получится»", hasDoubtSignal("не уверена, что у меня получится"), true);
check("«надо подумать»", hasDoubtSignal("надо подумать пока"), true);
check("«боюсь не справлюсь»", hasDoubtSignal("боюсь, что не справлюсь"), true);
check("«получится ли у меня»", hasDoubtSignal("а получится ли у меня вообще"), true);
check("«а вдруг не смогу»", hasDoubtSignal("а вдруг не смогу"), true);
check("«дорого для меня»", hasDoubtSignal("это дорого для меня если честно"), true);
check("«дороговато»", hasDoubtSignal("как-то дороговато выходит"), true);
check("тадж. «боварам нест»", hasDoubtSignal("ман боварам нест ки мешавад"), true);
check("тадж. «метарсам»", hasDoubtSignal("метарсам ки натавонам"), true);
check("тадж. «қимат»", hasDoubtSignal("ин каме қимат аст"), true);

// --- Не должно сработать (обычный разговор, не сомнение) ---
check("обычный вопрос про цену", hasDoubtSignal("сколько стоит курс?"), false);
check("«недорого» — не то же самое, что «дорого»", hasDoubtSignal("это недорого, беру"), false);
check("«дорога» (не про цену)", hasDoubtSignal("длинная дорога до вас"), false);
check("простое согласие", hasDoubtSignal("хорошо, записываюсь"), false);
check("пустая строка", hasDoubtSignal(""), false);
check("вопрос про рецепт", hasDoubtSignal("а рецепты на таджикском есть?"), false);

console.log(failures === 0 ? "\nВсе проверки прошли" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
