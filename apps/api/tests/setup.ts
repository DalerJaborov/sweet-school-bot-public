/**
 * Общая подготовка для vitest. env.ts падает при загрузке, если нет
 * JWT_SECRET/ADMIN_PASSWORD — в тестах база и секреты не нужны, но модуль
 * может подтянуться транзитивно (instagram.ts → env.ts). Значения фиктивные.
 */
process.env.JWT_SECRET ??= "test-secret";
process.env.ADMIN_PASSWORD ??= "test-password";
process.env.PUBLIC_BASE_URL ??= "http://localhost:4100";
process.env.DATABASE_URL ??= "file:./test-should-never-be-opened.db";
