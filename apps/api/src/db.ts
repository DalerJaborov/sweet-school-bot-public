import { PrismaClient, Prisma } from "@prisma/client";

/** Singleton instance — used by all production code. Mutable so tests can
 *  replace it via setPrismaClient() without touching import sites. */
export let prisma: PrismaClient = new PrismaClient();

/** Factory for tests / alternative configurations — returns a fresh client
 *  that is NOT wired into the module-level singleton. */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

/** Replace the module-level singleton (test mock injection). All existing
 *  imports of `prisma` from this module see the new instance because they
 *  read the live binding, not a snapshot. */
export function setPrismaClient(client: PrismaClient): void {
  prisma = client;
}

/**
 * НАСТРОЙКА SQLITE ПОД ОДНОВРЕМЕННУЮ РАБОТУ. Вызывается один раз при старте.
 *
 * По умолчанию SQLite пишет через журнал отката: пока идёт запись, читатели
 * ждут. У нас пишут одновременно вебхуки Instagram, восемь фоновых задач раз в
 * десять секунд и ученицы, смотрящие уроки, — и любая из этих записей может
 * поймать «database is locked» в случайном месте: потерянный ответ клиентке,
 * потерянный прогресс урока.
 *
 * WAL меняет это: читатели не блокируются о писателя вовсе. busy_timeout даёт
 * писателю подождать пять секунд вместо мгновенного отказа. synchronous=NORMAL
 * — обычный компромисс для WAL: на порядок меньше обращений к диску ценой
 * потери последних долей секунды при внезапном отключении питания, что для
 * переписки приемлемо.
 */
export async function tuneSqlite(): Promise<void> {
  try {
    // journal_mode и busy_timeout ВОЗВРАЩАЮТ значение (новый режим, число
    // миллисекунд), а $executeRawUnsafe в SQLite на любой результат отвечает
    // «Execute returned results, which is not allowed» — на проде это уронило
    // всю настройку целиком, и база осталась без WAL. Читающие прагмы идут
    // через $queryRawUnsafe, изменяющие без ответа — через executeRaw.
    const [journal] = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode=WAL");
    await prisma.$executeRawUnsafe("PRAGMA synchronous=NORMAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000");
    logInfo("db", `SQLite: journal_mode=${journal?.journal_mode ?? "?"}, synchronous=NORMAL, busy_timeout=5s`);
  } catch (err) {
    // Не критично: база будет работать и на настройках по умолчанию, просто
    // хуже под нагрузкой. Ронять старт из-за этого нельзя.
    logError("db:tuneSqlite", err);
  }
}

/**
 * ГОНКА С handleEcho (webhook.ts): вебхук-эхо нашего же отправленного
 * сообщения иногда долетает быстрее, чем мы сами успеваем записать mid —
 * тогда handleEcho создаёт строку сам, помечая её byHuman: true и ставя
 * contact.humanSilencedUntil, как будто хозяйка перехватила разговор из
 * приложения. Здесь мы это ТОЧНО знаем не так (мы сами только что отправили
 * текст), поэтому при конфликте по mid не просто глотаем ошибку — чиним
 * обе ложные пометки, оставленные handleEcho.
 */
/**
 * Префикс «идентификатора» исходящего для канала WEB. У Meta mid выдаёт сама
 * сеть; у сайта сети нет — messaging/send.ts сам кладёт строку Message и
 * возвращает такой mid, чтобы вызывающий код (у которого везде «отправил →
 * записал») не создавал вторую строку: recordOutgoingMessage по префиксу
 * понимает, что запись уже есть.
 */
export const WEB_MID_PREFIX = "web:";

export async function recordOutgoingMessage(contactId: string, text: string, mid: string | null): Promise<void> {
  if (mid?.startsWith(WEB_MID_PREFIX)) return; // канал WEB: строка уже записана в sendToContact
  try {
    await prisma.message.create({ data: { contactId, direction: "OUT", text, mid } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    if (!mid) return;
    const existing = await prisma.message.findUnique({ where: { mid } });
    if (existing?.byHuman) {
      await prisma.message.update({ where: { mid }, data: { byHuman: false, text } });
      await prisma.contact.update({ where: { id: contactId }, data: { humanSilencedUntil: null } }).catch(() => null);
    }
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** Некоторые вызовы (profiles.ts, instagram.ts) строят URL прокси с маркером в
 *  query-параметре — ошибка сети от fetch/undici может утащить в message весь
 *  адрес. Вырезаем значение секретных query-параметров, а не сам факт вызова:
 *  так видно, что произошло, но не видно, чем можно воспользоваться. */
function redact(msg: string): string {
  return msg.replace(/((?:access_token|token|key)=)[^&\s"]+/gi, "$1***");
}

/**
 * ПЕРСИСТЕНТНЫЙ ЖУРНАЛ + TELEGRAM НА НОВЫЙ ВИД ПОЛОМКИ (30.08.2026).
 *
 * До этого `logError` писал ТОЛЬКО в console.error контейнера — живёт до
 * первого перезапуска. Живой случай: человек написал с рекламы, ответа не
 * было, а разбирать было нечем — контейнер перезапустился раньше, чем кто-то
 * заглянул в docker logs, и причина пропала безвозвратно.
 *
 * Устроено как в Royal Home CRM (apps/api/src/lib/systemError.ts того
 * проекта): та же дедупликация по первым 160 символам за 10 минут — иначе одна
 * сломанная интеграция даёт тысячи одинаковых строк на каждое сообщение
 * клиента, и в них тонет всё остальное. В Telegram — только на ДЕЙСТВИТЕЛЬНО
 * новый вид поломки (`everSeen` ищет запись за всё время, не только за
 * 10 минут): повтор уже известной ошибки и так виден в таблице `ErrorLog`, а
 * будить хозяйку сообщением на каждый повтор — быстрый путь к тому, что
 * уведомления начнут игнорировать.
 */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const DEDUP_TEXT_LEN = 160;
/** Ошибка, молчавшая столько, при возвращении снова считается новой. */
const RENOTIFY_AFTER_MS = 24 * 3_600_000;

/**
 * КРЮЧОК ВМЕСТО ПРЯМОГО ИМПОРТА telegram.ts — ЛОМАЕТ ЦИКЛ ИМПОРТОВ.
 *
 * telegram.ts сам импортирует logError отсюда (запись отказа отправки в
 * журнал), поэтому прямой импорт telegram.ts здесь создал бы цикл. Вместо
 * этого db.ts зовёт зарегистрированный извне колбэк, ничего не зная про
 * Telegram. Регистрирует его index.ts один раз при старте.
 */
let newErrorHook: ((source: string, message: string) => void) | null = null;

export function onNewSystemError(hook: (source: string, message: string) => void): void {
  newErrorHook = hook;
}

async function persistAndMaybeAlert(source: string, text: string): Promise<void> {
  try {
    const dedupKey = text.slice(0, DEDUP_TEXT_LEN);
    const recent = await prisma.errorLog.findFirst({
      where: { source, message: { startsWith: dedupKey }, createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) } },
      select: { id: true },
    });
    if (recent) return;

    // ДО записи новой строки — иначе она сама себя найдёт, и «впервые» не
    // сработает никогда.
    //
    // Смотрим последние сутки, а не всю историю. Раньше искалось «когда-либо»,
    // и владельца будили ровно на ПЕРВОЕ в жизни появление ошибки: поломка,
    // случившаяся однажды при тестировании, дальше могла повторяться месяцами
    // в полной тишине (разбор надёжности 03.09.2026). Сутки тишины — и та же
    // ошибка снова считается новостью.
    const seenLately = await prisma.errorLog.findFirst({
      where: { source, message: { startsWith: dedupKey }, createdAt: { gte: new Date(Date.now() - RENOTIFY_AFTER_MS) } },
      select: { id: true },
    });

    await prisma.errorLog.create({ data: { source, message: text.slice(0, 2000) } });

    if (!seenLately) {
      try {
        newErrorHook?.(source, text);
      } catch {
        // Крючок не должен ронять запись самой ошибки.
      }
    }
  } catch {
    // Журнал ошибок не должен ломать то, об ошибке чего он пишет. Если
    // недоступна сама база (SQLite-файл занят/повреждён) — писать всё равно
    // некуда, а console.error выше уже случился.
  }
}

/**
 * `fetch failed` — это ВСЁ, что Node печатает от себя: настоящая причина
 * (ECONNREFUSED, ENOTFOUND, таймаут, обрыв TLS) лежит в `err.cause`, а логи
 * писали только `err.message` — реальная причина сетевых сбоев (media:fetch и
 * не только) терялась безвозвратно, разбирать было нечем даже с доступом к
 * контейнеру. Проходим по цепочке cause (undici кладёт их вложенно, иногда
 * через AggregateError с несколькими попытками DNS) и дописываем к сообщению.
 */
function withCauseChain(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = err.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    if (cause instanceof AggregateError) {
      parts.push(cause.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; "));
      break;
    }
    parts.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(" <- ");
}

export function logError(scope: string, err: unknown): void {
  const msg = redact(withCauseChain(err));
  console.error(`[${scope}] ${new Date().toISOString()} ERROR ${msg}`);
  // Постоянный журнал ошибок и тревога владельцу — из ветки учёта стоимости
  // (30.08). Сохранено при слиянии: без него ошибки видны только в логе Docker,
  // который никто не читает.
  void persistAndMaybeAlert(scope, msg);
}

/** Информационное логирование — единый формат с logError для парсинга в CI/Docker.
 *  Заменяет разрозненные console.log/warn по кодовой базе. */
export function logInfo(scope: string, msg: string): void {
  console.log(`[${scope}] ${new Date().toISOString()} INFO ${redact(msg)}`);
}

/** Предупреждения — не ошибка, но требует внимания (конфиг отсутствует, fallback). */
export function logWarn(scope: string, msg: string): void {
  console.warn(`[${scope}] ${new Date().toISOString()} WARN ${redact(msg)}`);
}
