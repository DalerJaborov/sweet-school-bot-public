/**
 * ДОСОЗДАТЬ ЛЁГКИЕ ДОРОЖКИ 360p и 240p УЖЕ ГОТОВЫМ УРОКАМ.
 *
 * Зачем: на 16.11.2026 у всех 31 урока только 720p (≈3.4 Мбит/с) и 480p
 * (≈1.4 Мбит/с), и на мобильном канале ниже 1.5 Мбит/с урок бесконечно
 * грузится. Новые уроки лёгкие дорожки получают сами (renditionsFor), старым
 * их досоздаёт этот скрипт. Логика — storage/lowRenditionBackfill.ts.
 *
 * Что гарантирует:
 *  • готовые дорожки, ключ шифрования и база НЕ меняются (в базу скрипт не
 *    пишет вовсе); новые дорожки шифруются тем же ключом урока и тем же IV,
 *    а ключ заранее проверяется расшифровкой готового сегмента 480p;
 *  • master.m3u8 переписывается ПОСЛЕДНИМ: оборвалось — плеер о недоделанной
 *    дорожке не знает, повторный запуск доделает (уже готовые уроки пропустит);
 *  • один урок за раз, ffmpeg с `nice -n 19` (это делает сам пайплайн) и
 *    `-threads 2` — бот на том же сервере продолжает отвечать.
 *
 * ЗАПУСК НА СЕРВЕРЕ (из папки с docker-compose.yml, после выката этой ветки):
 *
 *   # 1. Что будет сделано — ничего не меняет:
 *   docker compose exec api node dist/scripts/backfillLowRenditions.js --dry-run
 *
 *   # 2. Один урок на пробу — и проверить его на телефоне (см. ниже):
 *   docker compose exec api nice -n 19 node dist/scripts/backfillLowRenditions.js --lesson=<id>
 *
 *   # 3. Все остальные, в фоне, с журналом:
 *   docker compose exec -d api sh -c 'nice -n 19 node dist/scripts/backfillLowRenditions.js > /tmp/lowrend.log 2>&1'
 *   docker compose exec api tail -f /tmp/lowrend.log
 *
 * Ключи: --dry-run, --lesson=<id>, --limit=<N> (первые N уроков, которым есть
 * что делать), --threads=<N> (по умолчанию 2), --workdir=<папка> (куда класть
 * исходник на время работы; по умолчанию /tmp контейнера).
 *
 * ВРЕМЯ. ФАКТ (замер 16.11.2026 на ноутбуке, 6 ядер): минута шумного видео
 * 720×1280 кодируется в 360p+240p при -threads 2 примерно за 11 с (≈0.2 от
 * длительности); выход — ≈7.3 МБ на минуту видео (360p ≈4.8, 240p ≈2.5).
 * ОЦЕНКА для сервера (ядра медленнее, под nice): 0.3–0.5 от длительности, то
 * есть 20-минутный урок — 6–10 минут плюс скачивание исходника (сотни МБ) и
 * заливка ≈150 МБ. Общая длительность 31 урока — НЕТ ДАННЫХ: --dry-run
 * печатает минуты каждого урока, по ним и считать. Место: исходник одного
 * урока во временной папке (удаляется после урока) — до запуска `df -h`.

 * ПРОВЕРКА ПОСЛЕ:
 *  • повторный --dry-run пишет «уже есть» по всем урокам;
 *  • на телефоне в уроке меню качества показывает 240p и 360p, «Авто» на
 *    слабой связи (DevTools → Network → Slow 3G) играет без остановок;
 *  • офлайн-загрузка урока работает как раньше (она берёт только 480p).
 *
 * НЕ ПЕРЕКОДИРОВАТЬ уроки из панели, пока идёт скрипт: он это заметит и
 * пропустит урок, но время на кодирование будет потрачено зря.
 */
import { prisma } from "../db.js";
import { storageConfig } from "../storage/s3.js";
import { ffmpegAvailable } from "../storage/videoPipeline.js";
import { executePlan, planLesson, r2Store, type BackfillLesson } from "../storage/lowRenditionBackfill.js";

type Args = { dryRun: boolean; lessonId: string | null; limit: number | null; threads: number; workDir: string | undefined };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, lessonId: null, limit: null, threads: 2, workDir: undefined };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--lesson=")) args.lessonId = a.slice(9).trim() || null;
    else if (a.startsWith("--limit=")) args.limit = Math.max(1, Number.parseInt(a.slice(8), 10) || 1);
    else if (a.startsWith("--threads=")) args.threads = Math.min(8, Math.max(1, Number.parseInt(a.slice(10), 10) || 2));
    else if (a.startsWith("--workdir=")) args.workDir = a.slice(10).trim() || undefined;
    else throw new Error(`неизвестный ключ ${a}`);
  }
  return args;
}

const now = () => new Date().toISOString().slice(11, 19);
const say = (msg: string) => console.log(`[${now()}] ${msg}`);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await storageConfig();
  if (!cfg) {
    say("Хранилище не настроено (ключи R2 в настройках панели) — делать нечего.");
    return 1;
  }
  if (!args.dryRun && !(await ffmpegAvailable())) {
    say("ffmpeg не найден — запускать внутри контейнера api.");
    return 1;
  }
  const store = r2Store(cfg);

  const lessons = await prisma.lesson.findMany({
    where: {
      hlsPath: { not: null },
      deletedAt: null,
      status: "READY",
      ...(args.lessonId ? { id: args.lessonId } : {}),
    },
    select: { id: true, title: true, order: true, hlsPath: true, sourcePath: true, encryptionKey: true },
    orderBy: [{ moduleId: "asc" }, { order: "asc" }],
  });
  if (args.lessonId && lessons.length === 0) {
    say(`Урок ${args.lessonId} не найден среди готовых (READY, с видео, не в корзине).`);
    return 1;
  }
  say(`${args.dryRun ? "СУХОЙ ПРОГОН. " : ""}Уроков с видео: ${lessons.length}`);

  const done: string[] = [];
  const ok: string[] = [];
  const impossible: string[] = [];
  const failed: string[] = [];
  let taken = 0;

  for (const l of lessons) {
    const lesson: BackfillLesson = {
      id: l.id,
      hlsPath: l.hlsPath!,
      sourcePath: l.sourcePath,
      encryptionKey: l.encryptionKey,
    };
    const label = `${l.id} «${l.title}»`;
    let plan;
    try {
      plan = await planLesson(lesson, store);
    } catch (err) {
      failed.push(`${label}: ${(err as Error).message}`);
      say(`ОШИБКА ${label}: ${(err as Error).message}`);
      continue;
    }
    if (plan.kind === "done") {
      done.push(label);
      say(`уже есть  ${label}`);
      continue;
    }
    if (plan.kind === "impossible") {
      impossible.push(`${label}: ${plan.reason}`);
      say(`НЕЛЬЗЯ    ${label}: ${plan.reason}`);
      continue;
    }
    const what = `${plan.missing.map((r) => r.name).join("+")} из ${plan.from === "source" ? "исходника" : `расшифрованной ${plan.reference}`}`;
    if (args.dryRun) {
      ok.push(`${label}: ${what}`);
      say(`СДЕЛАЮ    ${label}: ${what}, ${Math.round(plan.referenceDurationSec / 60)} мин`);
      continue;
    }
    if (args.limit !== null && taken >= args.limit) continue;
    taken += 1;

    const started = Date.now();
    say(`начинаю   ${label}: ${what}`);
    try {
      const res = await executePlan(lesson, plan, store, {
        threads: args.threads,
        workDir: args.workDir,
        log: (m) => say(`          ${m}`),
        recheck: async () => {
          const fresh = await prisma.lesson.findUnique({
            where: { id: l.id },
            select: { status: true, deletedAt: true, hlsPath: true, encryptionKey: true },
          });
          if (!fresh) return "урок удалён";
          if (fresh.deletedAt) return "урок в корзине";
          if (fresh.status !== "READY") return `статус ${fresh.status}`;
          if (fresh.hlsPath !== l.hlsPath) return "сменился hlsPath";
          if (fresh.encryptionKey !== l.encryptionKey) return "сменился ключ";
          return null;
        },
      });
      const min = ((Date.now() - started) / 60000).toFixed(1);
      ok.push(`${label}: +${res.added.join(", ")} (${min} мин)`);
      say(`готово    ${label}: +${res.added.join(", ")}, файлов ${res.uploaded}, ${min} мин`);
    } catch (err) {
      failed.push(`${label}: ${(err as Error).message}`);
      say(`ОШИБКА    ${label}: ${(err as Error).message}`);
    }
  }

  say("—".repeat(20));
  say(
    `${args.dryRun ? "будет сделано" : "сделано"}: ${ok.length}; уже было: ${done.length}; нельзя: ${impossible.length}; ошибок: ${failed.length}`,
  );
  for (const line of impossible) say(`  нельзя: ${line}`);
  for (const line of failed) say(`  ошибка: ${line}`);
  return failed.length > 0 ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
