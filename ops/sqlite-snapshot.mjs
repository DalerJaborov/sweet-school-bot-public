/**
 * Согласованный снимок базы SQLite для бэкапа (ops/backup.sh).
 *
 * Копировать файл базы на ходу нельзя: если в этот момент идёт запись, копия
 * получится битой — и обнаружится это только при восстановлении, то есть в самый
 * неподходящий день. `VACUUM INTO` берёт снимок под блокировкой и попутно сжимает
 * базу. Консольного sqlite3 в образе нет, поэтому команда идёт через Prisma.
 */
const db = await import("/app/apps/api/dist/db.js");
const target = "/data/bot.backup.tmp";

try {
  // Остаток прошлого прогона: VACUUM INTO отказывается писать в существующий файл.
  const { rm } = await import("node:fs/promises");
  await rm(target, { force: true });
  await db.prisma.$executeRawUnsafe(`VACUUM INTO '${target}'`);
} catch (err) {
  console.error(String(err?.message ?? err).slice(0, 300));
  process.exit(1);
}
process.exit(0);
