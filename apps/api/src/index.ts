import express from "express";
import os from "node:os";
import fs from "node:fs";
import { checkInboundSilence, checkUnansweredInbound } from "./inboundWatch.js";
import { runOwnerReminders } from "./ownerReminder.js";
import { singleFlight } from "./services/singleFlight.js";
import { notifyOwnerDirect } from "./systemAlerts.js";
import { markWorkerOk, markWorkerTimeout, STUCK_AFTER } from "./workerHealth.js";
import cors from "cors";
import { adminAccessConfig, createAdminAccessGuard } from "./adminAccess.js";
import { adminRevocations } from "./adminRevocations.js";
import { env } from "./env.js";
import { webhookRouter, runWebhookInbox } from "./webhook.js";
import { adminRouter } from "./admin.js";
import { adminLoginRouter } from "./adminLogin.js";
import { mediaRouter } from "./upload.js";
import { telegramRouter } from "./telegramWebhook.js";
import { miniAppRouter } from "./miniApp.js";
import { courseRouter } from "./course/router.js";
import { siteRouter } from "./site/router.js";
import { freeLessonRouter } from "./site/freeLesson.js";
import { goRouter } from "./links/siteLinks.js";
import { maybeSendDailyReport } from "./dailyReport.js";
import { retryUncheckedReceipts } from "./receiptRetry.js";
import { retryPendingAiReplies } from "./aiReplyRetry.js";
import { runJoinReminders } from "./joinReminder.js";
import { runOfflineReminders } from "./offlineReminder.js";
import { runLearningCheckIns } from "./learningCheckIn.js";
import { maybeRunNightlyLearning } from "./nightlyLearning.js";
import { refreshProfiles } from "./profiles.js";
import { runDueFollowUps } from "./followUp.js";
import { runDueDeliveries } from "./funnel.js";
import { pollMissedComments } from "./commentBackfill.js";
import { logError, logInfo, tuneSqlite, onNewSystemError, getSetting } from "./db.js";
import { notifyOwnerOfSystemError } from "./systemAlerts.js";
import { autoCatch } from "./asyncRoute.js";
import { flushAllPending } from "./debounce.js";
import { checkStorageReachable } from "./storage/s3.js";
import { purgeTrashedLessons } from "./course/lessonTrash.js";
import { runDiskMaintenance } from "./diskInfo.js";
import { checkIgToken } from "./igTokenWatch.js";
import { checkFbToken } from "./fbTokenWatch.js";
import { checkAppSecret } from "./appSecretWatch.js";
import { healthReport, markWorkerTick } from "./health.js";
import { resumeUnfinishedTranscodes } from "./course/adminRoutes.js";
import { startWhatsAppWorker } from "./whatsapp/worker.js";

// index.ts — единственная точка, где db.ts и telegram.ts (через systemAlerts.ts)
// встречаются без цикла импортов (см. комментарий у onNewSystemError в db.ts).
onNewSystemError(notifyOwnerOfSystemError);

// Ни один async-роут не должен зависать навсегда или ронять процесс на
// необработанном промисе — см. asyncRoute.ts. Патчим до app.use, чтобы под
// защитой оказался КАЖДЫЙ роут, зарегистрированный в этих файлах.
autoCatch(webhookRouter);
autoCatch(telegramRouter);
autoCatch(miniAppRouter);
autoCatch(courseRouter);
autoCatch(siteRouter);
autoCatch(freeLessonRouter);
autoCatch(goRouter);
autoCatch(adminRouter);
autoCatch(adminLoginRouter);

// Второй рубеж: если что-то всё-таки проскочит (сторонний код, таймер вне
// роутера), процесс не должен падать молча — падение бота хуже, чем шум в логе.
process.on("unhandledRejection", (err) => logError("unhandledRejection", err));
process.on("uncaughtException", (err) => logError("uncaughtException", err));

const app = express();
app.use(["/admin", "/admin-form"], createAdminAccessGuard(adminAccessConfig(), adminRevocations));
const publicCors = cors();
app.use((req, res, next) => {
  if (res.locals.schoolAccessAuthenticated === true) next();
  else publicCors(req, res, next);
});
app.use(
  express.json({
    limit: "1mb",
    // Сырое тело нужно для проверки подписи вебхука Meta.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

/**
 * Проверка здоровья для внешнего наблюдателя. 503, если что-то из основного
 * сломано, — иначе «страница открывается» ошибочно читается как «бот работает»
 * (см. health.ts).
 */
app.get("/health", (_req, res) => {
  void healthReport()
    .then((report) => res.status(report.ok ? 200 : 503).json(report))
    .catch(() => res.status(503).json({ ok: false, problems: ["проверка здоровья упала"] }));
});
app.use(mediaRouter);
app.use(webhookRouter);
app.use(telegramRouter);
app.use(courseRouter); // платформа курсов: своя сессия по куке, не админский JWT
app.use(siteRouter); // публичное API сайта: кука посетителя, без токена
app.use(freeLessonRouter);
app.use(goRouter); // короткие рекламные ссылки /go/<код>: только перенаправление на свой сайт
app.use(miniAppRouter); // до adminRouter: вход из Telegram идёт без токена
app.use(adminLoginRouter); // пароль: до adminRouter, под защитой от перебора
app.use(adminRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError("http", err);
  res.status(500).json({ error: "Внутренняя ошибка" });
});

// Настройка SQLite под одновременную запись — до того, как поедут вебхуки.
void tuneSqlite();

// Уроки, чья перекодировка оборвалась вместе с прошлым запуском, возвращаются
// в очередь. Без этого они оставались в статусе «перекодируется» навсегда:
// очередь жила только в памяти и терялась при любом рестарте.
setTimeout(() => {
  void resumeUnfinishedTranscodes()
    .then((n) => n > 0 && logInfo("video:queue", `возвращено в очередь незаконченных уроков: ${n}`))
    .catch((err) => logError("video:resume", err));
}, 15_000);

const server = app.listen(env.port, () => {
  logInfo("http", `Sweet School Bot API на порту ${env.port}`);
});
startWhatsAppWorker();

// Graceful shutdown: при SIGTERM/SIGINT сначала сбрасываем pending-сообщения
// дебаунса (чтобы не потерять неотправленные ответы), потом закрываем сервер.
// Без этого in-memory буфер теряется при любом рестарте/деплое.
function gracefulShutdown(signal: string) {
  logInfo("shutdown", `${signal}: сбрасываю буферы дебаунса…`);
  // Ждём отправки ответов, но не дольше восьми секунд: Docker даёт десять до
  // SIGKILL, и лучше потерять один ответ, чем упасть с открытой базой.
  const flushed = Promise.race([flushAllPending(), new Promise<void>((r) => setTimeout(r, 8_000))]);
  void flushed.then(() => {
    server.close(() => {
      logInfo("shutdown", "HTTP-сервер закрыт");
      process.exit(0);
    });
  });
  // Если сервер не закрылся за 10 секунд — выходим принудительно,
  // чтобы не зависнуть в CI/Docker forever.
  setTimeout(() => process.exit(1), 10_000).unref?.();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Разносчик отложенных шагов воронки и утренняя сводка владельцу.
// Overlap protection: если предыдущий цикл ещё не завершился (например,
// refreshProfiles завис на медленном API), новый тик пропускается целиком.
// Без этого под нагрузкой задачи накапливаются параллельно, что приводит
// к дублям отправок и contention в базе.
let workersRunning = false;

/** Потолок на одну фоновую задачу. Без него зависший сетевой вызов внутри любой
 *  из них оставил бы workersRunning=true НАВСЕГДА: воронки, догоняющие, сводка
 *  и перепроверка чеков молча перестали бы работать, и в логе не было бы ни
 *  одной ошибки — просто тишина. Две минуты с запасом больше любого честного
 *  прохода. */
const WORKER_TIMEOUT_MS = 120_000;

// TMPDIR из docker-compose указывает на том данных — папки может ещё не быть.
try {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
} catch (err) {
  logError("boot:tmpdir", err);
}

function withTimeout<T>(name: string, task: Promise<T>): Promise<T | null> {
  // ТАЙМЕР ОБЯЗАТЕЛЬНО ГАСИМ. Без этого Promise.race отдавал результат
  // успевшей задачи, а таймер продолжал тикать и через две минуты рапортовал
  // о «зависании» давно завершённой работы. Тик идёт раз в десять секунд и
  // заводит девять таких таймеров — владельцу за минуту прилетала полная
  // лента ложных тревог о том, что не сломано (живой случай 03.09.2026,
  // сразу после выкладки).
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      logError("worker:timeout", new Error(`${name} не завершилась за ${WORKER_TIMEOUT_MS / 1000} с — пропускаю тик`));
      // Три тайм-аута подряд — задача не отвечает. Тревога уходит один раз,
      // без дедупа (logError выше дедупится и после первого раза молчит), и
      // /health начинает отдавать 503 с именем задачи (workerHealth.ts).
      if (markWorkerTimeout(name)) {
        void notifyOwnerDirect(
          `⚠️ Фоновая задача «${name}» не отвечает: ${STUCK_AFTER} тайм-аута подряд. ` +
            `Остальные задачи работают, но эта стоит — если не оживёт сама, перезапустите бота.`,
          { dedupeKey: `worker-timeout:${name}` }
        );
      }
      resolve(null);
    }, WORKER_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([task, guard]).finally(() => {
    clearTimeout(timer);
    if (!timedOut) markWorkerOk(name);
  });
}

setInterval(() => {
  if (workersRunning) return;
  workersRunning = true;
  // Слияние 03.09: защита от перекрытия и потолок на задачу — из ветки аудита,
  // повтор отложенных ответов ИИ (retryPendingAiReplies) — из ветки учёта
  // стоимости. Нужны обе: без первой одна зависшая задача молча выключает всю
  // автоматику, без второй ответ клиентке теряется при отказе Gemini.
  void getSetting("botFrozen").then((v) => {
    const frozen = v === "true";
    // Экстренная пауза (владелец 13.09.2026): «всё, кроме воронки». Разносчик
    // отложенных шагов воронки (runDueDeliveries) — это и есть «воронка», не
    // гасим. followUp/joinReminder/offlineReminder/learningCheckIn пишут
    // клиентам вне воронки — гасим. Receipt/AI retry queues also pause:
    // they must neither issue access nor consume retry attempts while frozen.
    // Owner reports, learning maintenance and profile refresh remain separate.
    const tasks = [
      withTimeout("webhookInbox", runWebhookInbox().catch((err) => logError("webhookInbox", err))),
      withTimeout("worker", runDueDeliveries().catch((err) => logError("worker", err))),
      withTimeout("dailyReport", maybeSendDailyReport().catch((err) => logError("dailyReport", err))),
      withTimeout("nightlyLearning", maybeRunNightlyLearning().catch((err) => logError("nightlyLearning", err))),
      withTimeout("profiles", refreshProfiles().catch((err) => logError("profiles", err))),
    ];
    if (!frozen) {
      tasks.push(
        withTimeout("receiptRetry", retryUncheckedReceipts().catch((err) => logError("receiptRetry", err))),
        withTimeout("aiReplyRetry", retryPendingAiReplies().catch((err) => logError("aiReplyRetry", err))),
        withTimeout("followUp", runDueFollowUps().catch((err) => logError("followUp", err))),
        withTimeout("joinReminder", runJoinReminders().catch((err) => logError("joinReminder", err))),
        withTimeout("offlineReminder", runOfflineReminders().catch((err) => logError("offlineReminder", err))),
        withTimeout("learningCheckIn", runLearningCheckIns().catch((err) => logError("learningCheckIn", err)))
      );
    }
    return Promise.allSettled(tasks);
  }).then(() => {
    workersRunning = false;
    // Круг замкнулся — отмечаем для /health. Молчание дольше пяти минут значит,
    // что автоматика встала, и снаружи это иначе не видно.
    markWorkerTick();
  });
}, 10_000);

// Дозаправка пропущенных комментариев (см. commentBackfill.ts) — отдельный,
// более редкий тик: опрос ленты и комментариев дороже, чем остальные задачи
// выше, гонять его каждые 10 секунд незачем. Первый прогон — почти сразу
// после старта: самый частый случай потери комментария — это как раз рестарт
// контейнера при деплое, и нагонять пропущенное стоит быстро, а не только
// через 10 минут.
setTimeout(() => pollMissedComments().catch((err) => logError("commentBackfill", err)), 30_000);

// ПРОВЕРКА ХРАНИЛИЩА ВИДЕО раз в час — обязательное смягчение риска Cloudflare
// R2 (см. docs/course-platform-design.md §5.2): в России его периодически режут
// через DPI, и о перебоях владелец должен узнавать от бота, а не от ученицы,
// которая не смогла открыть урок. Две неудачи подряд пишут тревогу в лог.
// Хранилище не настроено — проверка молча ничего не делает.
setInterval(() => {
  void checkStorageReachable().catch((err) => logError("storage:check", err));
}, 60 * 60_000);

// КОРЗИНА УРОКОВ (course/lessonTrash.ts): раз в час стираем уроки, пролежавшие
// в корзине дольше суток, — строку и файлы в хранилище.
setInterval(() => void purgeTrashedLessons().catch((err) => logError("lessonTrash", err)), 60 * 60_000);

// МЕСТО НА ДИСКЕ — самый тихий из отказов: заполнился, SQLite перестал писать,
// и бот молча замолчал для всех. Раз в час чистим брошенные временные файлы и
// пишем в журнал (diskInfo.ts). В Telegram про диск больше не пишем (08.11.2026).
// Первая проверка — через минуту после старта, а не сразу: пусть контейнер
// сначала поднимется.
setTimeout(() => void runDiskMaintenance().catch((err) => logError("disk:check", err)), 60_000);
setInterval(() => {
  void runDiskMaintenance().catch((err) => logError("disk:check", err));
}, 60 * 60_000);
// МАРКЕР INSTAGRAM (igTokenWatch.ts): живёт 60 дней. 20.10.2026 истёк, и бот
// шесть дней молчал для всех. Раз в 6 часов продлеваем, если пора, и заранее
// предупреждаем владельца, если продлить не выходит.
setTimeout(() => void checkIgToken().catch((err) => logError("igToken", err)), 4 * 60_000);
setInterval(() => void checkIgToken().catch((err) => logError("igToken", err)), 6 * 60 * 60_000);
// МАРКЕР СТРАНИЦЫ FACEBOOK (fbTokenWatch.ts): сам бессрочный, но доступ к данным у него
// кончается (data_access_expires_at). Раз в 12 часов спрашиваем Meta и предупреждаем заранее.
setTimeout(() => void checkFbToken().catch((err) => logError("fbToken", err)), 5 * 60_000);
setInterval(() => void checkFbToken().catch((err) => logError("fbToken", err)), 12 * 60 * 60_000);
// СЕКРЕТ ПРИЛОЖЕНИЯ META (appSecretWatch.ts): пуст — вебхук отклоняет всё, бот глухой.
const secretTick = () =>
  void checkAppSecret()
    .then((r) => { if (r === "no-recipient") logError("appSecret:noRecipient", new Error("Секрет Meta пуст, а чат владельца для тревог не задан — предупредить некого")); })
    .catch((err) => logError("appSecret", err));
setTimeout(secretTick, 3 * 60_000);
setInterval(secretTick, 60 * 60_000);
setInterval(() => pollMissedComments().catch((err) => logError("commentBackfill", err)), 10 * 60_000);

// СТОРОЖ ВХОДЯЩИХ (inboundWatch.ts): Instagram перестал присылать сообщения —
// внутри всё зелёное, а школа молча теряет заявки. Раз в час, в рабочее время.
setTimeout(() => void checkInboundSilence().catch((err) => logError("inboundWatch", err)), 2 * 60_000);
setInterval(() => {
  void checkInboundSilence().catch((err) => logError("inboundWatch", err));
}, 60 * 60_000);

// СТОРОЖ НЕОТВЕЧЕННЫХ (inboundWatch.ts): клиент написал, а бот включён и молчит
// дольше двух минут — тревога владельцу с именем и причиной; заодно самолечение
// ложного «передано человеку». Раз в минуту, singleFlight не нужен: прогон короткий.
setInterval(() => {
  void checkUnansweredInbound().catch((err) => logError("inboundWatch:unanswered", err));
}, 60_000);

// НАПОМИНАНИЕ ВЛАДЕЛЬЦУ (ownerReminder.ts): чеки и вопросы учениц, которые
// висят дольше часа, — раз в два часа в рабочее время. Тик частый, сама
// задача решает, пора ли (отметка в базе); singleFlight — чтобы медленный
// Telegram не наложил два прогона друг на друга.
const ownerReminderTick = () =>
  void singleFlight("ownerReminder", () => runOwnerReminders()).catch((err) => logError("ownerReminder", err));
setTimeout(ownerReminderTick, 3 * 60_000);
setInterval(ownerReminderTick, 10 * 60_000);
