import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sendTelegramMessage = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a) }));

// MEDIA_DIR у upload.ts прибит к /data — на машине разработчика его нет, и
// mkdirSync на верхнем уровне модуля упал бы. Подменяем на временную папку.
//
// vi.hoisted обязателен: vi.mock поднимается выше объявлений, и обычная
// константа на момент подмены ещё не существует.
const { TMP_ROOT } = vi.hoisted(() => ({
  TMP_ROOT: `${require("node:os").tmpdir()}/disk-test-${Date.now()}`,
}));
vi.mock("../../src/upload.js", () => ({ MEDIA_DIR: TMP_ROOT }));

import { cleanupTempUploads, diskState } from "../../src/diskWatch.js";

const TMP_DIR = path.join(TMP_ROOT, "course-tmp");

describe("cleanupTempUploads", () => {
  beforeEach(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("удаляет только брошенные сутки назад, свежие не трогает", async () => {
    const old = path.join(TMP_DIR, "оборванная-загрузка.mp4");
    const fresh = path.join(TMP_DIR, "идёт-прямо-сейчас.mp4");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(fresh, "x");
    // Двое суток назад — это точно оборванная отправка.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);

    const removed = await cleanupTempUploads();

    expect(removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    // Свежий файл — это, возможно, идущая прямо сейчас загрузка урока.
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("папки нет — не падаем и ничего не удаляем", async () => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    await expect(cleanupTempUploads()).resolves.toBe(0);
  });
});

describe("diskState", () => {
  it("возвращает долю свободного места в разумных пределах", async () => {
    const state = await diskState(os.tmpdir());
    expect(state).not.toBeNull();
    expect(state!.freePct).toBeGreaterThanOrEqual(0);
    expect(state!.freePct).toBeLessThanOrEqual(100);
    expect(state!.totalGb).toBeGreaterThan(0);
  });

  it("несуществующий путь — null, а не исключение: это не повод для тревоги", async () => {
    await expect(diskState("/такого/пути/нет/точно")).resolves.toBeNull();
  });
});
