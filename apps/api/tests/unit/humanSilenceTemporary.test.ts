import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import {
  contactAutomationBlocked,
  everTalkedWithShirin,
  humanSilenceActive,
  humanTakeoverActive,
  humanTakeoverEndsAt,
  loadHumanSilenceMs,
  resetHumanSilenceMs,
} from "../../src/messaging/automation.js";

/**
 * ПАУЗА ПОСЛЕ ЖИВОГО ОТВЕТА ШИРИН — ВРЕМЕННАЯ (владелец 09.11.2026).
 * Раньше одна её реплика из приложения глушила бота с этим человеком навсегда,
 * и клиент со вторым вопросом оставался без ответа.
 */
const HOUR = 3_600_000;
const ig = (hoursAgo: number) => ({ channel: "INSTAGRAM", humanTakenOverAt: new Date(Date.now() - hoursAgo * HOUR), humanSilencedUntil: null });

let db: PrismaMock;
beforeEach(() => {
  db = mockPrisma();
  resetHumanSilenceMs();
});
afterEach(() => {
  restorePrisma();
  resetHumanSilenceMs();
});

describe("пауза после ответа Ширин", () => {
  it("ГЛАВНОЕ: через 3 часа после её последнего ответа бот снова отвечает", () => {
    expect(humanTakeoverActive(ig(1))).toBe(true);
    expect(contactAutomationBlocked(ig(1))).toBe(true);
    expect(humanTakeoverActive(ig(3.1))).toBe(false);
    expect(contactAutomationBlocked(ig(3.1))).toBe(false);
  });

  it("срок берётся из настройки humanSilenceHours; мусор в настройке — 3 часа", async () => {
    db.model("setting").findUnique.mockResolvedValue({ value: "1" });
    await loadHumanSilenceMs();
    expect(humanTakeoverActive(ig(1.5))).toBe(false);
    db.model("setting").findUnique.mockResolvedValue({ value: "abc" });
    await loadHumanSilenceMs();
    expect(humanTakeoverActive(ig(1.5))).toBe(true);
  });

  it("WhatsApp (ручная пауза из панели) и контакт без канала — по-прежнему навсегда", () => {
    const old = new Date(Date.now() - 240 * HOUR);
    expect(humanTakeoverEndsAt({ channel: "WHATSAPP", humanTakenOverAt: old })).toBe(Infinity);
    expect(humanTakeoverActive({ channel: "WHATSAPP", humanTakenOverAt: old })).toBe(true);
    expect(humanTakeoverActive({ humanTakenOverAt: old })).toBe(true);
  });

  it("просьба клиента позвать человека (humanSilencedUntil) работает как раньше", () => {
    const asked = { channel: "INSTAGRAM", humanTakenOverAt: null, humanSilencedUntil: new Date(Date.now() + 10 * 60_000) };
    expect(humanSilenceActive(asked)).toBe(true);
    expect(humanSilenceActive({ ...asked, humanSilencedUntil: new Date(Date.now() - 1000) })).toBe(false);
  });

  it("личный контакт и спам глушатся независимо от паузы", () => {
    expect(contactAutomationBlocked({ ...ig(10), personal: true })).toBe(true);
    expect(contactAutomationBlocked({ ...ig(10), spamBlockedAt: new Date() })).toBe(true);
  });
});

/**
 * СТОРОЖ В CI: паузу Ширин читают только через одну дверь
 * (messaging/automation.ts). Любая новая проверка вида `if (contact.humanTakenOverAt)`
 * снова сделала бы паузу вечной — ровно тот класс ошибки, который чинили.
 */
describe("одна дверь для паузы", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  /** Кому можно трогать поле напрямую: дверь, писатели отметки и WhatsApp (там пауза ручная). */
  const ALLOWED = new Set([
    "messaging/automation.ts",
    "webhook.ts", // пишет отметку в handleEcho
    "db.ts", // чинит ложную отметку от нашего же эха
    "whatsapp/routes.ts",
    "whatsapp/worker.ts",
  ]);

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith(".ts") ? [full] : [];
    });
  }

  /** Рассылки-напоминания (не ответы на вопрос): каждая обязана спросить дверь. */
  const REMINDERS = ["followUp.ts", "joinReminder.ts", "offlineReminder.ts", "learningCheckIn.ts"];
  it.each(REMINDERS)("напоминание %s спрашивает everTalkedWithShirin", (file) => {
    expect(fs.readFileSync(path.join(SRC, file), "utf8")).toContain("everTalkedWithShirin(");
  });

  it("никто, кроме двери, не читает humanTakenOverAt", () => {
    const offenders = walk(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => fs.readFileSync(path.join(SRC, rel), "utf8").includes("humanTakenOverAt"));
    expect(offenders).toEqual([]);
  });
});

/**
 * НАПОМИНАНИЯ — НИКОГДА ТЕМ, С КЕМ ШИРИН ГОВОРИЛА САМА (владелец 09.11.2026),
 * даже когда 3-часовая пауза давно кончилась.
 */
describe("everTalkedWithShirin", () => {
  it("ГЛАВНОЕ: отметка паузы когда-либо стояла — да, даже если пауза кончилась неделю назад", async () => {
    expect(await everTalkedWithShirin({ id: "c", humanTakenOverAt: new Date(Date.now() - 7 * 24 * HOUR) })).toBe(true);
    expect(db.model("message").findFirst).not.toHaveBeenCalled();
  });

  it("отметки нет, но в истории есть её сообщение — да", async () => {
    db.model("message").findFirst.mockResolvedValue({ id: "m" });
    expect(await everTalkedWithShirin({ id: "c", humanTakenOverAt: null })).toBe(true);
    expect(db.model("message").findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "c", direction: "OUT", byHuman: true } }),
    );
  });

  it("ни отметки, ни её сообщений — нет; сбой базы — считаем «да» (лучше не напомнить)", async () => {
    db.model("message").findFirst.mockResolvedValue(null);
    expect(await everTalkedWithShirin({ id: "c" })).toBe(false);
    db.model("message").findFirst.mockRejectedValue(new Error("db"));
    expect(await everTalkedWithShirin({ id: "c" })).toBe(true);
  });
});
