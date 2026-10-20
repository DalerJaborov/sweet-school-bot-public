import assert from "node:assert/strict";
import { parseReceiptDate } from "../src/ai/receiptDate.js";

/**
 * Время на чеке напечатано по Душанбе, а контейнер живёт в UTC.
 *
 * Живой случай 22.08.2026: перевод 70 сомони прошёл, реквизиты и сумма сошлись, а
 * вердикт вышел «suspicious — дата на чеке из будущего». Причина не в чеке: модель
 * возвращает время строкой без часового пояса, `new Date()` понимает её как время
 * процесса (UTC), и местные 12:30 оказывались на пять часов впереди настоящего
 * момента. Человек заплатил и остался без доступа, пока его не выдали руками.
 *
 * Запуск: npx tsx apps/api/tests/receiptDate.test.ts
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

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Чек напечатан «22.08.2026 12:30» по Душанбе — это 07:30 UTC, а не 12:30 UTC.
check("местное время сдвигается на смещение", iso(parseReceiptDate("2026-08-22T12:30:00", 5)), "2026-08-22T07:30:00.000Z");

// Тот самый случай: чек оплачен пять минут назад, а выглядел как «из будущего».
const now = Date.UTC(2026, 7, 22, 7, 35, 0);
const receipt = parseReceiptDate("2026-08-22T12:30:00", 5)!;
const ageHours = (now - receipt.getTime()) / 3_600_000;
check("свежий чек больше не выглядит будущим", ageHours > 0, true);
check("и не выглядит старым", ageHours < 1, true);

// Строку СО зоной трогать нельзя — в ней всё уже сказано.
check("зона +05:00 уважается как есть", iso(parseReceiptDate("2026-08-22T12:30:00+05:00", 5)), "2026-08-22T07:30:00.000Z");
check("зона Z уважается как есть", iso(parseReceiptDate("2026-08-22T07:30:00Z", 5)), "2026-08-22T07:30:00.000Z");

check("мусор — это null, а не «дата 1970 года»", parseReceiptDate("не разобрал", 5), null);
check("пустая строка — null", parseReceiptDate("   ", 5), null);

console.log(failures === 0 ? "\nВсе проверки прошли" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
