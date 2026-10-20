import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({ logInfo: vi.fn(), logError: vi.fn() }));
vi.mock("../../src/ai/historyImport.js", () => ({
  importHistory: vi.fn(async () => ({ imported: 3, scanned: 10, conversations: 2, skippedPersonal: 1 })),
}));
vi.mock("../../src/ai/testimonialImport.js", () => ({
  importArchiveTestimonials: vi.fn(async () => ({ created: 1, matched: 2, scanned: 5 })),
}));

import { logInfo, logError } from "../../src/db.js";
import { importHistory } from "../../src/ai/historyImport.js";
import { createBackgroundJob, styleImportJob } from "../../src/services/importService.js";

/** Промис, которым тест управляет вручную — чтобы «поймать» задачу в работе. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("createBackgroundJob", () => {
  beforeEach(() => {
    vi.mocked(logInfo).mockReset();
    vi.mocked(logError).mockReset();
  });

  it("успех: ответ сразу, итог в лог, флаг снят", async () => {
    const d = deferred<number>();
    const job = createBackgroundJob({
      scope: "test",
      run: () => d.promise,
      summary: (n) => `${n} штук`,
      startedNote: "пошло",
    });

    const first = job.start();
    expect(first).toEqual({ started: true, note: "пошло" });
    expect(job.isRunning()).toBe(true);

    d.resolve(7);
    await flush();

    expect(job.isRunning()).toBe(false);
    expect(logInfo).toHaveBeenCalledWith("test", "готово: 7 штук");
    expect(logError).not.toHaveBeenCalled();
  });

  it("повторный запуск во время работы — заявка: после завершения задача идёт ещё раз сама", async () => {
    // Очередь видео на этом механизме теряла урок, попавший между концом цикла
    // и сбросом флага: «встало в очередь» — и тишина до перезапуска (разбор
    // надёжности 03.09.2026). Теперь заявка выполняется по завершении.
    const first = deferred<void>();
    const second = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const job = createBackgroundJob({ scope: "t", run, summary: () => "", startedNote: "ok", busyNote: "занято" });

    job.start();
    expect(job.start()).toEqual({ started: false, note: "занято" });
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve();
    await flush();
    // Заявка отработала: второй прогон запустился без нажатия.
    expect(run).toHaveBeenCalledTimes(2);
    expect(job.isRunning()).toBe(true);

    second.resolve();
    await flush();
    expect(job.isRunning()).toBe(false);
    expect(job.status().finishedAt).toBeInstanceOf(Date);
  });

  it("прогресс читается снаружи, пока задача идёт", async () => {
    const d = deferred<void>();
    const job = createBackgroundJob({
      scope: "t",
      run: async (report) => {
        report({ done: 0, total: 3, current: "Наполеон" });
        await d.promise;
        report({ done: 3 });
      },
      summary: () => "",
      startedNote: "ok",
    });
    job.start();
    await flush();
    expect(job.status().progress).toMatchObject({ done: 0, total: 3, current: "Наполеон" });
    d.resolve();
    await flush();
    expect(job.status().progress).toMatchObject({ done: 3, total: 3 });
  });

  it("ошибка: пишется в logError, флаг снят, процесс не падает", async () => {
    const d = deferred<void>();
    const job = createBackgroundJob({ scope: "t", run: () => d.promise, summary: () => "", startedNote: "ok" });

    job.start();
    d.reject(new Error("Meta 500"));
    await flush();

    expect(job.isRunning()).toBe(false);
    expect(logError).toHaveBeenCalledWith("t", expect.any(Error));
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("styleImportJob собирает итог из результата importHistory", async () => {
    styleImportJob.start();
    await flush();
    expect(importHistory).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      "style:import",
      "готово: 3 примеров из 10 сообщений, переписок 2, личных пропущено 1"
    );
  });
});
