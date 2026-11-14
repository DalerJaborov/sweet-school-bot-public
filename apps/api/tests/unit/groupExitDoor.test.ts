import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

vi.mock("../../src/courses.js", async (orig) => ({
  ...(await orig<typeof import("../../src/courses.js")>()),
  chatIdFor: vi.fn(async (c: string) => (c === "COURSE70" ? "-1002" : "-1001")),
}));

import { removeInviteJoiner, InviteError } from "../../src/links/telegramInvites.js";
import { removeContactFromGroups } from "../../src/groupExit.js";

/**
 * ОДНА ДВЕРЬ «УДАЛИТЬ ИЗ TELEGRAM-ГРУППЫ» (08.11.2026, ревью PR 64).
 * Бан и разбан живут только в groupExit.ts; здесь — сторож от обхода и проверка
 * пути «Удалить» у вошедшего по ссылке из панели.
 */

let db: PrismaMock;
beforeEach(() => {
  db = mockPrisma();
  sendTelegramMessage.mockClear();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key === "telegramBotToken" ? { value: "token" } : null,
  );
  db.model("telegramInviteJoin").findUnique.mockResolvedValue({
    id: "j-1",
    inviteId: "inv-5",
    telegramUserId: "777",
    removedAt: null,
  });
  db.model("telegramInvite").findUnique.mockResolvedValue({ id: "inv-5", groupKey: "COURSE70", chatId: "-1002" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  restorePrisma();
});

function stubTelegram(over: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const method = String(url).split("/").pop() ?? "";
    const reply =
      over[method] ?? (method === "getChatMember" ? { ok: true, result: { status: "member" } } : { ok: true, result: true });
    return { json: async () => reply };
  });
  vi.stubGlobal("fetch", fetchMock);
  return (method: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`));
}

describe("«Удалить» у вошедшего по ссылке из панели идёт через общую дверь", () => {
  it("обычный участник: проверка, бан, разбан, отметка «удалён»", async () => {
    const calls = stubTelegram();

    await removeInviteJoiner("inv-5", "j-1");

    expect(calls("getChatMember")).toHaveLength(1);
    expect(calls("banChatMember")).toHaveLength(1);
    expect(calls("unbanChatMember")).toHaveLength(1);
    expect(db.model("telegramInviteJoin").updateMany).toHaveBeenCalledWith({
      where: { id: "j-1", removedAt: null },
      data: { removedAt: expect.any(Date) },
    });
  });

  it("администратор группы не удаляется: понятная ошибка, бана нет, отметки нет", async () => {
    const calls = stubTelegram({ getChatMember: { ok: true, result: { status: "administrator" } } });

    await expect(removeInviteJoiner("inv-5", "j-1")).rejects.toMatchObject({ reason: "protected" });

    expect(calls("banChatMember")).toHaveLength(0);
    expect(db.model("telegramInviteJoin").updateMany).not.toHaveBeenCalled();
  });

  it("бан не прошёл (нет прав): ошибка наружу, отметки нет", async () => {
    stubTelegram({ banChatMember: { ok: false, description: "Bad Request: not enough rights" } });

    await expect(removeInviteJoiner("inv-5", "j-1")).rejects.toBeInstanceOf(InviteError);

    expect(db.model("telegramInviteJoin").updateMany).not.toHaveBeenCalled();
  });

  it("разбан не прошёл: повтор три раза, тревога хозяйке, человек всё равно помечен удалённым", async () => {
    const calls = stubTelegram({ unbanChatMember: { ok: false, description: "Bad Request: timeout" } });

    await removeInviteJoiner("inv-5", "j-1");

    expect(calls("unbanChatMember")).toHaveLength(3);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("снять бан не вышло");
    expect(db.model("telegramInviteJoin").updateMany).toHaveBeenCalled();
  });
});

describe("removeContactFromGroups: старые оплаты без записей о покупке", () => {
  it("покупок нет и это отзыв доступа — убираем из обеих групп, историю входа не трогаем", async () => {
    const calls = stubTelegram();
    const contact = { id: "c-1", telegramUserId: "777", joinedGroupAt: new Date(), inviteLink: null };

    const report = await removeContactFromGroups(contact, [], "owner", { allChatsIfNoPurchases: true });

    expect(calls("banChatMember")).toHaveLength(2);
    expect(report.problems).toEqual([]);
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(db.model("purchase").updateMany).not.toHaveBeenCalled();
  });

  it("без отзыва доступа и без покупок — никого не баним", async () => {
    const calls = stubTelegram();
    const contact = { id: "c-1", telegramUserId: "777", joinedGroupAt: null, inviteLink: null };
    await removeContactFromGroups(contact, [], "bot");
    expect(calls("banChatMember")).toHaveLength(0);
  });

  it("бан прошёл, а ответ не дошёл (сеть): разбан всё равно пробуется", async () => {
    const calls = stubTelegram({ banChatMember: { ok: false, description: "timeout" } });
    const contact = { id: "c-1", telegramUserId: "777", joinedGroupAt: new Date(), inviteLink: null };

    const report = await removeContactFromGroups(contact, [], "owner", { allChatsIfNoPurchases: true });

    expect(calls("unbanChatMember").length).toBeGreaterThan(0);
    expect(report.problems.length).toBeGreaterThan(0);
  });
});

describe("сторож: бан и разбан только в groupExit.ts", () => {
  it("banChatMember / unbanChatMember / kickChatMember встречаются в src/ только в groupExit.ts", () => {
    const root = path.resolve(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (/\b(ban|unban|kick)ChatMember\b/.test(src) && path.basename(full) !== "groupExit.ts") {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
