import { defineConfig } from "vitest/config";

/**
 * Юнит-тесты на vitest — tests/unit/**.
 *
 * Старые тесты в tests/*.test.ts — самостоятельные tsx-скрипты с
 * node:assert (запуск: npm run test:legacy), их vitest не трогает: там нет
 * describe/it, и он бы счёл файл пустым набором. Новые тесты пишутся сюда,
 * с моком Prisma через tests/helpers.ts.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // Модульное состояние (кэш курсов, флаги воркеров) не должно течь между
    // файлами — каждый файл в своём изоляте.
    isolate: true,
    restoreMocks: true,
  },
});
