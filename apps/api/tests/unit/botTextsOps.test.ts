import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

/**
 * СКРИПТ ТЕКСТОВ БОТА (ops/2026-11-11-bot-texts.mjs) — НА НАСТОЯЩЕЙ SQLITE
 * (ревью 11.11.2026). Скрипт пишет в живую базу промпт и шаги воронки, поэтому
 * проверяем ровно то, что может испортить правки владельца: двойной прогон,
 * бэкап на каждый APPLY, транзакцию и громкое «НЕ ПРИМЕНИТСЯ».
 * Данные выдуманные; база — временный файл.
 */
vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-texts-"));
const dbFile = path.join(dir, "test.db").replace(/\\/g, "/");
let db: PrismaClient;

type Change = { what: string };
type Plan = { changes: Change[]; notes: string[]; backup: Record<string, unknown> };
type Ops = {
  MARKER: string;
  BACKUP_PREFIX: string;
  planBotTexts(db: PrismaClient): Promise<Plan>;
  main(opts: {
    db: PrismaClient;
    apply: boolean;
    log?: (s: string) => void;
  }): Promise<{ plan: Plan; backupKey: string | null }>;
};
let ops: Ops;

const OLD_PROMPT =
  "Старый промпт владельца.\nАдрес: Рудаки 156, доми Додо Пицца.\nhttps://www.instagram.com/stories/highlights/1234567890/";

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: path.join(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: "ignore",
  });
  db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
  process.env.BOT_TEXTS_NO_MAIN = "1";
  const file = path.resolve(__dirname, "../../../../ops/2026-11-11-bot-texts.mjs");
  ops = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Ops;
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.funnelStep.deleteMany();
  await db.funnel.deleteMany();
  await db.setting.deleteMany();
  await db.setting.create({ data: { key: "aiPrompt", value: OLD_PROMPT } });
  await db.setting.create({
    data: {
      key: "objectionLibrary",
      value: JSON.stringify([{ counterThatWorked: "бе телеграм намешад" }, { counterThatWorked: "Хавотир нашавед" }]),
    },
  });
  const dm = await db.funnel.create({ data: { name: "Директ", trigger: "DM", enabled: true } });
  await db.funnelStep.create({
    data: { funnelId: dm.id, order: 20, text: "Ассалому алейкум!\nДарсҳо дар телеграм мебошанд, 70 сомони." },
  });
  await db.funnelStep.create({ data: { funnelId: dm.id, order: 30, text: "Офлайн: Рудаки 156, доми Додо Пицца" } });
});

const backups = () => db.setting.findMany({ where: { key: { startsWith: "botTextsBackup20261111@" } } });
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (s: string) => lines.push(s) };
};

describe("ops/2026-11-11-bot-texts.mjs", () => {
  it("сухой прогон: печатает «было → стало» (промпт — края и длина, шаг — полностью) и ничего не пишет", async () => {
    const out = quiet();
    await ops.main({ db, apply: false, log: out.log });
    const text = out.lines.join("\n");
    expect(text).toContain("ИЗМЕНИТ: Setting aiPrompt");
    expect(text).toMatch(/знаков, \d+ строк/);
    expect(text).toContain("| Ассалому алейкум!"); // было: шаг 20 полностью
    expect(text).toContain("| Дарсҳо дар Telegram ё дар сайти мо мебошанд, 70 сомони."); // стало
    expect(text).toContain("Это проверка");
    expect((await db.setting.findUnique({ where: { key: "aiPrompt" } }))?.value).toBe(OLD_PROMPT);
    expect(await backups()).toHaveLength(0);
  });

  it("двойной APPLY: второй ничего не меняет и бэкап не плодит; правки владельца после него не затираются", async () => {
    const first = await ops.main({ db, apply: true, log: quiet().log });
    expect(first.backupKey).toMatch(/^botTextsBackup20261111@/);
    const saved = JSON.parse((await db.setting.findUnique({ where: { key: first.backupKey! } }))!.value);
    expect(saved.aiPrompt).toBe(OLD_PROMPT);
    expect(saved.steps).toHaveLength(2);
    const prompt = (await db.setting.findUnique({ where: { key: "aiPrompt" } }))!.value;
    expect(prompt.startsWith(ops.MARKER)).toBe(true);

    // Владелец поправил промпт в панели, метку версии оставил.
    await db.setting.update({ where: { key: "aiPrompt" }, data: { value: `${prompt}\nПравка владельца` } });
    const second = await ops.main({ db, apply: true, log: quiet().log });
    expect(second.plan.changes).toEqual([]);
    expect(second.backupKey).toBeNull();
    expect((await db.setting.findUnique({ where: { key: "aiPrompt" } }))!.value).toContain("Правка владельца");
    expect(await backups()).toHaveLength(1);
  });

  it("владелец снял метку и переписал промпт — новый APPLY перезаписывает только с НОВЫМ бэкапом его текста", async () => {
    await ops.main({ db, apply: true, log: quiet().log });
    await db.setting.update({ where: { key: "aiPrompt" }, data: { value: "Промпт владельца без метки" } });
    await new Promise((r) => setTimeout(r, 5)); // другая метка времени
    const again = await ops.main({ db, apply: true, log: quiet().log });
    const all = await backups();
    expect(all).toHaveLength(2);
    const latest = JSON.parse((await db.setting.findUnique({ where: { key: again.backupKey! } }))!.value);
    expect(latest.aiPrompt).toBe("Промпт владельца без метки");
  });

  it("шаг не узнан — громко «НЕ ПРИМЕНИТСЯ», а не молчание", async () => {
    await db.funnelStep.updateMany({ where: { order: 20 }, data: { text: "Салом! Курсҳо 70 ва 50 сомони." } });
    await db.funnelStep.updateMany({ where: { order: 30 }, data: { text: "Офлайн курс: адрес скоро" } });
    const out = quiet();
    await ops.main({ db, apply: false, log: out.log });
    const text = out.lines.join("\n");
    expect(text).toMatch(/НЕ ПРИМЕНИТСЯ: DM «Директ» шаг 20 — приветствия/);
    expect(text).toMatch(/НЕ ПРИМЕНИТСЯ: DM «Директ» шаг 20 — строки «Дарсҳо дар телеграм» нет/);
    expect(text).toMatch(/НЕ ПРИМЕНИТСЯ: DM «Директ» шаг 30/);
  });

  it("сбой посреди записи — не остаётся ни бэкапа, ни половины правок (одна транзакция)", async () => {
    const plan = await ops.planBotTexts(db);
    const failing = {
      ...db,
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.$transaction(async (tx) => {
          await fn(tx);
          throw new Error("сбой диска (тест)");
        }),
    } as unknown as PrismaClient;
    const mod = ops as unknown as { applyBotTexts(d: PrismaClient, p: Plan): Promise<string | null> };
    await expect(mod.applyBotTexts(failing, plan)).rejects.toThrow("сбой диска");
    expect(await backups()).toHaveLength(0);
    expect((await db.setting.findUnique({ where: { key: "aiPrompt" } }))?.value).toBe(OLD_PROMPT);
  });
});
