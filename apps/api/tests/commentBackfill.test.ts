import assert from "node:assert/strict";
import { shouldBackfill, type IgComment } from "../src/commentBackfill.js";

/**
 * Юнит-тест на чистую логику «какие комментарии считать пропущенными»
 * (commentBackfill.ts). Без БД и без Instagram API — только сама функция
 * отбора, сеть и SeenComment здесь не участвуют.
 *
 * Запуск: npx tsx apps/api/tests/commentBackfill.test.ts
 */

const SELF_USERNAME = "shirin.sweets.dushanbe";
const NOW = Date.parse("2026-08-22T10:00:00Z");
const cutoffMs = NOW - 48 * 3_600_000;

function comment(overrides: Partial<IgComment> = {}): IgComment {
  return {
    id: "c1",
    text: "Сколько стоит курс?",
    timestamp: new Date(NOW - 3_600_000).toISOString(), // час назад — внутри окна
    from: { id: "999", username: "client_a" },
    ...overrides,
  };
}

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

// Свежий чужой комментарий с текстом и id автора — берём в обработку.
check("свежий комментарий постороннего — берём", shouldBackfill(comment(), SELF_USERNAME, cutoffMs), true);

// Наш же комментарий (ответ хозяйки под своим постом) — не заводим воронку сами с собой.
check(
  "комментарий от себя — пропускаем",
  shouldBackfill(comment({ from: { id: "17800000000000000", username: SELF_USERNAME } }), SELF_USERNAME, cutoffMs),
  false
);

// Комментарий без id автора — контакт завести нечем, гадать нельзя.
check(
  "комментарий без id автора — пропускаем",
  shouldBackfill(comment({ from: { username: "no_id_user" } }), SELF_USERNAME, cutoffMs),
  false
);

// Пустой текст — нечего передавать в воронку.
check("пустой текст — пропускаем", shouldBackfill(comment({ text: "   " }), SELF_USERNAME, cutoffMs), false);
check("текст отсутствует — пропускаем", shouldBackfill(comment({ text: undefined }), SELF_USERNAME, cutoffMs), false);

// Без id самого комментария — нечем защититься от повтора (SeenComment ключ по id).
check("комментарий без id — пропускаем", shouldBackfill(comment({ id: undefined }), SELF_USERNAME, cutoffMs), false);

// Старше окна подстраховки (глубже 48 часов) — это не рестарт, это старая история, не трогаем.
check(
  "старше 48 часов — пропускаем",
  shouldBackfill(comment({ timestamp: new Date(cutoffMs - 3_600_000).toISOString() }), SELF_USERNAME, cutoffMs),
  false
);

// Ровно на границе окна (чуть новее cutoff) — ещё берём.
check(
  "чуть новее границы окна — берём",
  shouldBackfill(comment({ timestamp: new Date(cutoffMs + 1_000).toISOString() }), SELF_USERNAME, cutoffMs),
  true
);

// Без timestamp вовсе — не режем по времени, полагаемся на остальные фильтры.
check("без timestamp — берём", shouldBackfill(comment({ timestamp: undefined }), SELF_USERNAME, cutoffMs), true);

if (failures > 0) {
  console.error(`\n${failures} тест(а/ов) упали`);
  process.exit(1);
}
console.log("\nвсе тесты прошли");
