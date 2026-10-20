import assert from "node:assert/strict";
import { runAfterPrevious } from "../src/debounce.js";

/**
 * Живой случай 23.08.2026 (parfume.ellita): чек и следом отдельным сообщением
 * «ина чекш» пришли с разрывом больше окна дебаунса — открылись ДВА независимых
 * окна. Пока первый вызов onFlush ещё выполнялся (в бою — ждал ответ Gemini),
 * второй уже стартовал, не дождавшись первого: его история переписки читалась
 * из базы раньше, чем первый успел записать туда свой ответ, и оба независимо
 * отправили одинаковое «Кабул кардем...».
 *
 * Тест гоняет саму очередь (runAfterPrevious) напрямую, а не через
 * debounceMessage — иначе пришлось бы ждать реальные 2,5 секунды окна дважды.
 * Проверяемое поведение то же самое: второй запуск для контакта стартует
 * только после того, как первый полностью завершится.
 *
 * Запуск: npx tsx apps/api/tests/debounceSerialization.test.ts
 */

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

async function testSerialization(): Promise<void> {
  const order: string[] = [];
  const contactId = "test-contact";

  runAfterPrevious(contactId, async () => {
    order.push("first:start");
    await new Promise((r) => setTimeout(r, 60));
    order.push("first:end");
  });

  // Второй запуск ставится в очередь, пока первый ещё выполняется — как разрыв
  // в 6 секунд между чеком и подписью, который больше окна дебаунса (2,5 с).
  runAfterPrevious(contactId, () => {
    order.push("second:start");
  });

  await new Promise((r) => setTimeout(r, 150));

  check("второй запуск стартует только после завершения первого", order, [
    "first:start",
    "first:end",
    "second:start",
  ]);
}

async function testFailureDoesNotBlockQueue(): Promise<void> {
  const order: string[] = [];
  const contactId = "test-contact-fail";

  runAfterPrevious(contactId, async () => {
    order.push("first:start");
    throw new Error("сбой генерации — не должен застопорить очередь");
  });
  runAfterPrevious(contactId, () => {
    order.push("second:start");
  });

  await new Promise((r) => setTimeout(r, 50));

  check("сбой первого запуска не блокирует второй", order, ["first:start", "second:start"]);
}

async function testIndependentContacts(): Promise<void> {
  const order: string[] = [];

  // Разные контакты не должны ждать друг друга — очередь per-contact, а не глобальная.
  runAfterPrevious("contact-a", async () => {
    order.push("a:start");
    await new Promise((r) => setTimeout(r, 60));
    order.push("a:end");
  });
  runAfterPrevious("contact-b", () => {
    order.push("b:start");
  });

  await new Promise((r) => setTimeout(r, 100));

  check(
    "b не ждёт a — разные контакты идут независимо",
    order.indexOf("b:start") < order.indexOf("a:end"),
    true
  );
}

await testSerialization();
await testFailureDoesNotBlockQueue();
await testIndependentContacts();

if (failures > 0) {
  console.error(`\n${failures} тест(ов) провалено`);
  process.exit(1);
}
console.log("\nВсе проверки прошли");
