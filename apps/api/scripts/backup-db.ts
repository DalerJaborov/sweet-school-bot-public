/**
 * БЭКАП БАЗЫ ПЕРЕД МИГРАЦИЯМИ — выполняется при каждом старте контейнера.
 *
 * ЗАЧЕМ. Контейнер накатывает миграции сам (`prisma migrate deploy` в CMD), и
 * это удобно: забытая миграция на проде дороже лишней секунды запуска. Но
 * SQLite не умеет ALTER TABLE с ограничениями, поэтому Prisma при изменении
 * связей ПЕРЕСОЗДАЁТ таблицу целиком: CREATE new -> INSERT SELECT -> DROP ->
 * RENAME. Если такая миграция прервётся, откатываться будет некуда.
 *
 * ПОЧЕМУ НЕ ПРОСТО СКОПИРОВАТЬ ФАЙЛ. Раньше здесь был copyFileSync — и
 * заголовок уверял, что «никто не пишет, обычного копирования достаточно».
 * После включения WAL (db.ts, 03.09.2026) это перестало быть правдой: при
 * нечистой остановке (SIGKILL по таймауту, OOM, `docker kill`) последние
 * подтверждённые транзакции живут ТОЛЬКО в bot.db-wal, а копировался один
 * bot.db. Продажи и выданные доступы за последние минуты в копию не попадали,
 * скрипт при этом бодро писал «копия сохранена». Обнаружилось бы это в день
 * восстановления — то есть в самый неподходящий.
 *
 * `VACUUM INTO` берёт согласованный снимок с учётом WAL и попутно сжимает
 * базу. Консольного sqlite3 в образе нет, поэтому команда идёт через Prisma —
 * ровно как в ops/sqlite-snapshot.mjs, который делает ночной бэкап. Если
 * Prisma по какой-то причине не поднялся (например, сломан сгенерированный
 * клиент), падаем на копирование всех трёх файлов: bot.db, -wal, -shm —
 * вместе они восстанавливаются корректно.
 *
 * Ошибка бэкапа НЕ останавливает запуск: бот, который не поднялся, вредит
 * больше, чем отсутствие копии. Но в лог это попадёт заметно.
 */
import fs from "node:fs";
import path from "node:path";

/** Сколько копий держим. Десять последних деплоев — это недели истории при
 *  файле в десятки мегабайт. */
const KEEP = 10;

function dbFileFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  // Хвост с параметрами обязательно отрезаем: в docker-compose адрес выглядит
  // как file:/data/bot.db?connection_limit=1&socket_timeout=15, и без этого
  // скрипт искал файл вместе со строкой запроса, не находил и молча сообщал
  // «базы ещё нет» — то есть бэкап перед миграцией не делался ВООБЩЕ, хотя в
  // логе выглядел успешным (живой случай 03.09.2026).
  const raw = url.replace(/^file:/, "").split("?")[0];
  if (!raw) return null;
  // Относительный путь в DATABASE_URL считается от папки prisma/.
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), "prisma", raw);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function log(level: "INFO" | "WARN", msg: string): void {
  const line = `[backup] ${new Date().toISOString()} ${level} ${msg}`;
  if (level === "WARN") console.warn(line);
  else console.log(line);
}

/** Согласованный снимок через VACUUM INTO. Бросает — вызывающий уйдёт на запасной путь. */
async function snapshotWithVacuum(target: string): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    // VACUUM INTO отказывается писать в существующий файл.
    fs.rmSync(target, { force: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    await prisma.$disconnect();
  }
}

/** Запасной путь: три файла разом, иначе хвост транзакций из WAL потеряется. */
function copyWithSidecars(dbFile: string, target: string): string[] {
  const copied: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbFile + suffix;
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, target + suffix);
    copied.push(path.basename(target + suffix));
  }
  return copied;
}

async function main(): Promise<void> {
  const dbFile = dbFileFromUrl(process.env.DATABASE_URL);
  if (!dbFile) {
    log("WARN", "DATABASE_URL не задан — бэкап пропущен");
    return;
  }
  if (!fs.existsSync(dbFile)) {
    log("INFO", "базы ещё нет (первый запуск) — бэкапить нечего");
    return;
  }

  const dir = path.join(path.dirname(dbFile), "backup");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `bot-${stamp()}.db`);

  try {
    await snapshotWithVacuum(target);
    const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
    log("INFO", `снимок сохранён (VACUUM INTO, с учётом WAL): ${target} (${sizeMb} МБ)`);
  } catch (err) {
    log("WARN", `VACUUM INTO не удался (${err instanceof Error ? err.message : String(err)}) — копирую файлы`);
    const copied = copyWithSidecars(dbFile, target);
    log("INFO", `скопировано: ${copied.join(", ")}`);
  }

  // Чистим старые, оставляя KEEP последних по имени: имя начинается с даты в
  // ISO, поэтому лексикографический порядок совпадает с хронологическим.
  // Файлы-спутники (-wal/-shm) идут за своим bot-<дата>.db.
  const stamps = fs
    .readdirSync(dir)
    .filter((f) => /^bot-.*\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);
  let removed = 0;
  for (const file of stamps) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = path.join(dir, file + suffix);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        removed += 1;
      }
    }
  }
  if (removed > 0) log("INFO", `удалено старых файлов копий: ${removed}`);
}

main().catch((err) => {
  // Намеренно не роняем старт: см. заголовок файла.
  log("WARN", `бэкап не удался, запуск продолжается: ${err instanceof Error ? err.message : String(err)}`);
});
