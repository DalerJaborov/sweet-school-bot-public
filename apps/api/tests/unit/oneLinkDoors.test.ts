import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * СТОРОЖ «ОДНА ССЫЛКА НА ЧЕЛОВЕКА» (PR 64 v2, ревью architect 08.11.2026).
 *
 * Три двери, обход которых раньше и давал блокеры:
 *  1. Ручная выдача ссылки на сайт владельцем — только course/ownerLink.ts
 *     (issueOwnerLink): она помечает выдачу и закрывает неиспользованное
 *     приглашение. Прямой issueCourseLink(..., { automatic: false }) в новом месте
 *     выдал бы ссылку «мимо учёта» (дыра из #78).
 *  2. Общий выпуск ссылки (delivery.ts) ничего не закрывает: «скрытое закрытие
 *     двери» жило именно там.
 *  3. Новое приглашение в группу выпускают только перечисленные места; выдача
 *     человеку, у которого доступ уже есть, проверяет «уже в группе» общей
 *     дверью course/groupInvite.ts.
 */
const SRC = path.resolve(__dirname, "../../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");
/** Код без комментариев: упоминания в пояснениях — не вызовы. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}
const files = walk(SRC).map((f) => ({ name: rel(f), src: code(f) }));
const callers = (re: RegExp) =>
  files
    .filter((f) => re.test(f.src))
    .map((f) => f.name)
    .sort();

/** Ручной выпуск ссылки на сайт (без «переиспользуй живую»): только дверь и возврат доступа. */
const MANUAL_SITE_LINK = /issueCourseLink\([^)]*automatic:\s*false/;
const MANUAL_SITE_LINK_ALLOWED: Record<string, string> = {
  "course/ownerLink.ts": "сама дверь: «Выдать ссылку», /ссылка, «Новая ссылка» в панели",
  "groupAccess.ts": "«Вернуть доступ»: покупки помечаются выданной ссылкой там же (restoreAccess)",
};

/** Кто выпускает приглашения в группу. */
const NEW_INVITE = /\bcreateOneTimeInviteLink\(/;
const NEW_INVITE_ALLOWED: Record<string, string> = {
  "telegram.ts": "определение",
  "course/ownerLink.ts": "«Выдать ссылку → Telegram»: проверка «уже в группе» — groupInvite.ts",
  "course/channelSwitch.ts": "переход «хочу в Telegram»: проверка «уже в группе» — groupInvite.ts",
  "ai/grantCourses.ts": "первая выдача после оплаты новой покупки",
  "joinReminder.ts": "напоминание тем, кто НЕ вошёл (joinedAt: null) — новая ссылка вместо потерянной",
  "groupAccess.ts": "«Вернуть доступ»: человек перед этим удалён из групп (revokeAccess)",
  "telegramMenu.ts": "кнопка «Ссылка в группу вопросов» в меню владельца (не ученице)",
};

describe("КЛАСС: одна ссылка на человека — двери не обходятся", () => {
  it("ручную ссылку на сайт выпускают только дверь ownerLink.ts и «Вернуть доступ»", () => {
    const extra = callers(MANUAL_SITE_LINK).filter((f) => !(f in MANUAL_SITE_LINK_ALLOWED));
    expect(extra, `Ручная выдача сайта мимо issueOwnerLink: ${extra.join(", ")}`).toEqual([]);
  });

  it("/ссылка и «Новая ссылка» в панели идут через issueOwnerLink (выдача помечается)", () => {
    for (const f of ["course/manualLink.ts", "metrics.ts"]) {
      const src = files.find((x) => x.name === f)!.src;
      expect(src, f).toMatch(/issueOwnerLink\(/);
      expect(src, f).not.toMatch(/issueCourseLink\(/);
    }
  });

  it("общий выпуск ссылки (delivery.ts) не закрывает Telegram-дверь", () => {
    const src = files.find((x) => x.name === "course/delivery.ts")!.src;
    expect(src).not.toMatch(/channelSwitch|closeTelegram|revokeInvite|removeContactFromGroups/);
  });

  it("приглашения в группу выпускают только перечисленные места (у каждого — причина)", () => {
    const extra = callers(NEW_INVITE).filter((f) => !(f in NEW_INVITE_ALLOWED));
    expect(extra, `Новое приглашение в группу мимо проверки: ${extra.join(", ")}`).toEqual([]);
    const stale = Object.keys(NEW_INVITE_ALLOWED).filter((f) => !callers(NEW_INVITE).includes(f));
    expect(stale, `Уберите из белого списка: ${stale.join(", ")}`).toEqual([]);
  });

  it("выдача приглашения уже купившей проверяет «уже в группе» одной дверью groupInvite.ts", () => {
    for (const f of ["course/ownerLink.ts", "course/channelSwitch.ts"]) {
      expect(files.find((x) => x.name === f)!.src, f).toMatch(/checkInviteTargets\(/);
    }
    // Своей копии списка «участник группы» нигде больше нет.
    const own = callers(/getChatMemberStatus\(/).filter((f) => f !== "telegram.ts" && f !== "course/groupInvite.ts");
    expect(own).toEqual([]);
  });

  it("ЛОВУШКА СТОРОЖА: шаблоны действительно видят нарушение", () => {
    expect(MANUAL_SITE_LINK.test("await issueCourseLink(id, { automatic: false })")).toBe(true);
    expect(MANUAL_SITE_LINK.test("await issueCourseLink(id, { automatic: true })")).toBe(false);
    expect(callers(NEW_INVITE)).toContain("course/channelSwitch.ts");
  });
});
