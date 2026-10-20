import { logError, logInfo } from "../db.js";
import { importHistory } from "../ai/historyImport.js";
import { importArchiveTestimonials } from "../ai/testimonialImport.js";

/**
 * Долгие разовые импорты, которые ЗАПУСКАЮТСЯ ФОНОМ, а HTTP-ответ уходит сразу.
 *
 * Проход по полусотне диалогов — сотни запросов к Meta и минуты работы: и
 * Cloudflare (100 с), и nginx обрывают такой запрос по таймауту раньше, чем он
 * закончится. Поэтому роутер только «нажимает кнопку», а прогресс виден по
 * счётчикам в панели и по логу сервера.
 *
 * Один и тот же импорт не должен идти в два потока (двойной тап, два открытых
 * окна панели) — у каждой задачи свой флаг занятости. Раньше флаги и сами
 * промисы жили прямо в admin.ts вперемешку с роутами; здесь они собраны в один
 * маленький механизм, чтобы следующий такой импорт добавлялся одной строкой.
 *
 * ПРОГРЕСС (03.09.2026). Импорт уроков из Telegram идёт часами — заливка
 * десятков видео по гигабайту. «Запущено / готово» для такого мало: владелец
 * должен видеть, какой урок сейчас идёт и сколько осталось, иначе решит, что
 * зависло, и нажмёт ещё раз. Поэтому задача получает `report`, а снаружи есть
 * `status()`.
 *
 * ПОВТОРНЫЙ ЗАПУСК ПО ЗАПРОСУ. Очередь перекодировки видео живёт как раз на
 * этом механизме, и у неё была гонка: урок, попавший в очередь между выходом
 * из цикла и сбросом флага, получал «встало в очередь» и не обрабатывался до
 * перезапуска (разбор надёжности 03.09.2026). Теперь `start()` во время работы
 * оставляет заявку, и по завершении задача запускается ещё раз сама.
 */

export type StartResult = { started: true; note: string } | { started: false; note: string };

export type JobProgress = {
  done: number;
  total: number;
  /** Что делается прямо сейчас — название урока, файл. */
  current: string | null;
  errors: { item: string; error: string }[];
};

export type JobStatus<R = unknown> = {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  progress: JobProgress | null;
  lastResult: R | null;
  lastError: string | null;
};

export type BackgroundJob<R = unknown> = {
  /** Запустить, если не идёт. Ответ — что сказать в панели. */
  start(): StartResult;
  /** Идёт ли прямо сейчас — для статуса/тестов. */
  isRunning(): boolean;
  /** Ход дела для панели: прогресс, когда началось, чем кончилось. */
  status(): JobStatus<R>;
};

/** Колбэк для задачи: слить кусок прогресса в общую запись. */
export type ReportProgress = (patch: Partial<JobProgress>) => void;

export function createBackgroundJob<R>(spec: {
  /** Область для лога: [scope] … */
  scope: string;
  run: (report: ReportProgress) => Promise<R>;
  /** Что написать в лог по завершении. */
  summary: (result: R) => string;
  startedNote: string;
  busyNote?: string;
}): BackgroundJob<R> {
  let running = false;
  let rerunRequested = false;
  let startedAt: Date | null = null;
  let finishedAt: Date | null = null;
  let progress: JobProgress | null = null;
  let lastResult: R | null = null;
  let lastError: string | null = null;

  const report: ReportProgress = (patch) => {
    progress = { done: 0, total: 0, current: null, errors: [], ...(progress ?? {}), ...patch };
  };

  function launch(): void {
    running = true;
    rerunRequested = false;
    startedAt = new Date();
    finishedAt = null;
    progress = null;
    lastError = null;
    void spec
      .run(report)
      .then((r) => {
        lastResult = r;
        logInfo(spec.scope, `готово: ${spec.summary(r)}`);
      })
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        logError(spec.scope, err);
      })
      .finally(() => {
        running = false;
        finishedAt = new Date();
        // Кто-то просил запустить, пока шла работа, — выполняем заявку сейчас,
        // а не ждём перезапуска контейнера.
        if (rerunRequested) launch();
      });
  }

  return {
    isRunning: () => running,
    status: () => ({ running, startedAt, finishedAt, progress, lastResult, lastError }),
    start() {
      if (running) {
        rerunRequested = true;
        return { started: false, note: spec.busyNote ?? "Импорт уже идёт" };
      }
      launch();
      return { started: true, note: spec.startedNote };
    },
  };
}

/** Разовый импорт прошлых переписок Instagram — чтобы бот сразу знал манеру
 *  хозяйки (см. ai/historyImport.ts). Дальше доучивается сам. */
export const styleImportJob = createBackgroundJob({
  scope: "style:import",
  run: () => importHistory(),
  summary: (r) =>
    `${r.imported} примеров из ${r.scanned} сообщений, переписок ${r.conversations}, личных пропущено ${r.skippedPersonal}`,
  startedNote: "Импорт запущен, следи за счётчиком в разделе «Стиль»",
});

/** Разовый разбор архива учебной группы на отзывы (см. ai/testimonialImport.ts):
 *  черновики появляются выключенными (active:false) в списке /admin/testimonials. */
export const archiveTestimonialsImportJob = createBackgroundJob({
  scope: "testimonials:import-archive",
  run: () => importArchiveTestimonials(),
  summary: (r) => `${r.created} новых черновиков из ${r.matched} подходящих сообщений (просмотрено ${r.scanned})`,
  startedNote: "Импорт запущен — черновики появятся здесь же выключенными (active:false)",
});
