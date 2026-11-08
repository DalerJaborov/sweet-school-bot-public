import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * КНОПКИ В ТРЕВОГЕ ПО ЧЕКУ (08.11.2026). Ширин выдала ссылку руками, а карточка
 * в Telegram осталась с живыми кнопками «Подтвердить/Отклонить» - нажатие
 * ничего не меняло и казалось сломанным. Теперь: устаревшая кнопка переписывает
 * карточку («уже обработано»), а тревога по уже выданному доступу закрывается сама.
 */
const editCaption = vi.fn(async (..._a: unknown[]) => undefined);
const answerCallback = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../src/telegram.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/telegram.js")>("../../src/telegram.js");
  return {
    ...actual,
    editCaption: (...a: unknown[]) => editCaption(...a),
    answerCallback: (...a: unknown[]) => answerCallback(...a),
    trustedChatIds: vi.fn(async () => ["1"]),
  };
});
vi.mock("../../src/ai.js", () => ({ grantCourses: vi.fn(async () => ["COURSE70"]) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/courses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/courses.js")>()),
  allocate: vi.fn(async () => ({ grant: ["COURSE70"], note: "21 рецепт" })),
  ownedCourses: vi.fn(async () => []),
}));

import { handleTelegramUpdate } from "../../src/telegramWebhook.js";
import { decideReceipt } from "../../src/receiptDecision.js";
import {
  closeReceiptById,
  closeSettledReceiptAlerts,
  parseAlerts,
  resetSweepClock,
} from "../../src/receiptAlerts.js";
import { grantCourses } from "../../src/ai.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { telegramBotToken: "tok" };
const contact = fakeContact({ username: "client" });

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    contactId: contact.id,
    contact,
    imageHash: "h1",
    kind: "valid",
    amount: 71,
    reason: "перевод",
    linkSent: false,
    ownerDecision: "PENDING",
    ownerAlerts: JSON.stringify([{ chatId: "1", messageId: 55 }]),
    createdAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  };
}

/** findMany: ждущие чеки; запрос "других принятых чеков" (OR) - пусто. */
function pendingRows(rows: unknown[]) {
  db.model("receiptCheck").findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.OR ? [] : rows));
}

function press(data: string) {
  return handleTelegramUpdate(
    { callback_query: { id: "cb1", data, from: { id: 1 }, message: { message_id: 55, chat: { id: 1 } } } },
    undefined,
  );
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
  );
  db.model("purchase").findMany.mockResolvedValue([]);
  db.model("purchase").count.mockResolvedValue(0);
  editCaption.mockClear();
  answerCallback.mockClear();
  vi.mocked(grantCourses).mockClear();
  resetSweepClock();
});
afterEach(() => {
  restorePrisma();
});

describe("нажатие устаревшей кнопки", () => {
  it("чек уже обработан руками: карточка переписывается без кнопок, не ломается", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(row({ ownerDecision: "HANDLED" }));
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 0 });
    await press("ok:r1");
    expect(answerCallback).toHaveBeenCalledWith("tok", "cb1", expect.stringMatching(/Уже обработано/));
    expect(editCaption).toHaveBeenCalledTimes(1);
    expect(String(editCaption.mock.calls[0][3])).toMatch(/уже обработано.*другим способом/);
    expect(grantCourses).not.toHaveBeenCalled();
  });

  it("повторное нажатие после «ссылка отправлена»", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(row({ ownerDecision: "APPROVED", linkSent: true }));
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 0 });
    await press("no:r1");
    expect(String(editCaption.mock.calls[0][3])).toMatch(/ссылка уже отправлена/);
  });

  it("чек удалён: кнопки убираются, а не молчат", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(null);
    await press("ok:ghost");
    expect(answerCallback).toHaveBeenCalled();
    expect(editCaption).toHaveBeenCalledTimes(1);
  });
});

describe("decideReceipt", () => {
  it("доступ по курсу был отозван: ссылка не уходит, чек закрывается понятным ответом", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(row());
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("receiptCheck").update.mockResolvedValue({});
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE70", revokedAt: new Date() }]); // отозванная покупка
    const result = await decideReceipt("r1", "approve");
    expect(result).toMatchObject({ ok: true, status: "approved_no_link" });
    expect(grantCourses).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerDecision: "APPROVED" }) }),
    );
  });

  it("уже обработанный чек: «Уже обработано», без второй выдачи", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(row({ ownerDecision: "HANDLED" }));
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 0 });
    const result = await decideReceipt("r1", "approve", "COURSE70");
    expect(result).toMatchObject({ ok: false, reason: "already_decided", message: "Уже обработано" });
  });
});

describe("автозакрытие тревоги", () => {
  it("closeReceiptById: чек закрыт как HANDLED, карточка переписана", async () => {
    pendingRows([row()]);
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    expect(await closeReceiptById("r1", "Ширин уже отправила ссылку сама")).toBe(1);
    expect(db.model("receiptCheck").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", ownerDecision: "PENDING" } }),
    );
    expect(editCaption).toHaveBeenCalledWith("tok", "1", 55, expect.stringContaining("уже обработано"));
  });

  it("уборка: покупка заведена после чека — тревога закрывается", async () => {
    pendingRows([row()]);
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("purchase").findMany.mockResolvedValue([{ id: "p1", course: "COURSE70" }]);
    expect(await closeSettledReceiptAlerts()).toBe(1);
    expect(editCaption).toHaveBeenCalledTimes(1);
  });

  it("уборка: сообщение Ширин со ссылкой статус не меняет (не отличить от обычного ответа)", async () => {
    pendingRows([row()]);
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("message").findFirst.mockResolvedValue({ text: "Вот ссылка https://shirinsweets.online/c/abc" });
    expect(await closeSettledReceiptAlerts()).toBe(0);
  });

  it("уборка: комплект закрывается только когда доставлены оба курса", async () => {
    pendingRows([row({ amount: 100 })]);
    db.model("purchase").findMany.mockResolvedValue([{ id: "p1", course: "COURSE70" }]);
    expect(await closeSettledReceiptAlerts()).toBe(0);
  });

  it("уборка: чек за 50 ждёт Ширин, курс за 70 выдан другим чеком - чек за 50 НЕ закрывается", async () => {
    pendingRows([row({ amount: 50 })]);
    db.model("purchase").findMany.mockResolvedValue([{ id: "p1", course: "COURSE70" }]);
    expect(await closeSettledReceiptAlerts()).toBe(0);
    expect(editCaption).not.toHaveBeenCalled();
  });

  it("уборка: закрытый чек получает linkSent, чтобы проверки повторов видели платёж", async () => {
    pendingRows([row()]);
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("purchase").findMany.mockResolvedValue([{ id: "p1", course: "COURSE70" }]);
    await closeSettledReceiptAlerts();
    expect(db.model("receiptCheck").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerDecision: "HANDLED", linkSent: true }) }),
    );
  });

  it("уборка: у клиентки только старая покупка и обычное сообщение — тревога остаётся", async () => {
    pendingRows([row()]);
    db.model("purchase").findMany.mockResolvedValue([]);
    expect(await closeSettledReceiptAlerts()).toBe(0);
    expect(editCaption).not.toHaveBeenCalled();
  });

  it("parseAlerts переживает мусор", () => {
    expect(parseAlerts(null)).toEqual([]);
    expect(parseAlerts("не json")).toEqual([]);
    expect(parseAlerts('[{"chatId":"1","messageId":5},{"x":1}]')).toEqual([{ chatId: "1", messageId: 5 }]);
  });
});

describe("сторож: понятие «чек принят» живёт в одном месте", () => {
  it("условие принятого чека не копируется в обход receiptAccepted.ts", async () => {
    const fsm = await import("node:fs");
    const pathm = await import("node:path");
    const root = pathm.join(__dirname, "../../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fsm.readdirSync(d, { withFileTypes: true })) {
        const p = pathm.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const copies = files.filter((f) => {
      if (f.endsWith("receiptAccepted.ts")) return false;
      const text = fsm.readFileSync(f, "utf8");
      // любой порядок записи: в одном OR-массиве рядом linkSent:true и ownerDecision:"APPROVED"
      const arrays = text.match(/OR:\s*\[[^\]]{0,400}\]/g) ?? [];
      return arrays.some((a) => /linkSent:\s*true/.test(a) && /ownerDecision:\s*"APPROVED"/.test(a));
    });
    expect(copies).toEqual([]);
  });
});
