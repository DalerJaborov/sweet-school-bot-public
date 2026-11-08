import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Класс ошибки (Instagram 08.11.2026): клиент написал «Pahmat apajon», «Хоб» — бот ответил
 * тремя голосовыми подряд. Причины две: (1) в Instagram вложение записывается пустой строкой
 * с тем же mid, и метка голосового терялась на дубликате — правило «не больше одного голосового
 * подряд» видело пустоту; (2) на короткое «спасибо/хоб» голосом отвечать вообще не надо.
 */
const state = vi.hoisted(() => ({
  rows: [] as { contactId: string; direction: string; text: string | null; mid: string | null; byHuman: boolean; createdAt: Date }[],
}));

vi.mock("../../src/db.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db.js")>("../../src/db.js");
  const { Prisma } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
  const prisma = {
    message: {
      create: vi.fn(async ({ data }: { data: { contactId: string; direction: string; text: string; mid: string | null } }) => {
        // Настоящая ошибка уникальности Prisma: recordOutgoingMessage ловит именно её.
        if (data.mid && state.rows.some((r) => r.mid === data.mid)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on mid", { code: "P2002", clientVersion: "test" });
        }
        state.rows.push({ ...data, byHuman: false, createdAt: new Date(2026, 10, 8, 16, state.rows.length) });
      }),
      findUnique: vi.fn(async ({ where }: { where: { mid: string } }) => state.rows.find((r) => r.mid === where.mid) ?? null),
      update: vi.fn(async ({ where, data }: { where: { mid: string }; data: { text: string } }) => {
        const r = state.rows.find((x) => x.mid === where.mid)!;
        r.text = data.text;
        return r;
      }),
      findMany: vi.fn(async ({ where, take }: { where: { contactId: string }; take: number }) =>
        state.rows.filter((r) => r.contactId === where.contactId && r.direction === "OUT").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take)),
    },
    contact: { findUnique: vi.fn(async () => null) },
  };
  // Настоящий recordOutgoingMessage из db.ts (это он и чинится) — подменена только база.
  actual.setPrismaClient(prisma as never);
  return {
    ...actual,
    prisma,
    getSetting: vi.fn(async (k: string) => (k === "voiceReplyEnabled" ? "true" : null)),
    logError: vi.fn(),
  };
});

// Instagram: отправка вложения сама записывает пустую строку с mid (как messaging/send.ts).
vi.mock("../../src/messaging/send.js", () => ({
  sendAttachmentToContact: vi.fn(async (contact: { id: string }) => {
    const mid = `mid-${state.rows.length + 1}`;
    state.rows.push({ contactId: contact.id, direction: "OUT", text: "", mid, byHuman: false, createdAt: new Date(2026, 10, 8, 16, state.rows.length) });
    return mid;
  }),
}));
vi.mock("../../src/ai/voiceClone.js", () => ({
  synthesizeToFile: vi.fn(async () => ({ url: "https://x/v.m4a" })),
  voiceEnabled: vi.fn(async () => true),
  decorateForV3: (t: string) => t,
  splitForVoice: (t: string) => [t],
}));

import { isShortAcknowledgement, lastReplyWasVoice, trySendVoiceReply, VOICE_MARK } from "../../src/ai/voiceReply.js";

const ig = { id: "c-ig", igUserId: "ig1", channel: "INSTAGRAM" };

describe("Instagram: не больше одного голосового подряд", () => {
  beforeEach(() => { state.rows.length = 0; });

  it("после голосового в Instagram метка не теряется и второй ответ уходит текстом", async () => {
    expect(await trySendVoiceReply(ig, "Ассалому алейкум! Хуш омадед.", false, "Салом")).toBe("");
    const out = state.rows.filter((r) => r.contactId === ig.id);
    expect(out).toHaveLength(1); // одна строка на вложение, а не пустая плюс потерянная
    expect(out[0].text?.startsWith(VOICE_MARK)).toBe(true);
    expect(await lastReplyWasVoice(ig.id)).toBe(true);
    // Следующий короткий тёплый ответ — уже текстом.
    expect(await trySendVoiceReply(ig, "Марҳамат, ҳар вақт нависед.", false, "Хайр")).toBeNull();
  });

  it("пустые строки вложений (картинка меню после голоса) правило не сбивают", async () => {
    state.rows.push({ contactId: ig.id, direction: "OUT", text: `${VOICE_MARK}Ассалому алейкум`, mid: "v1", byHuman: false, createdAt: new Date(2026, 10, 8, 16, 0) });
    state.rows.push({ contactId: ig.id, direction: "OUT", text: "", mid: "img1", byHuman: false, createdAt: new Date(2026, 10, 8, 16, 1) });
    expect(await lastReplyWasVoice(ig.id)).toBe(true);
    state.rows.push({ contactId: ig.id, direction: "OUT", text: "Вот наше меню", mid: "t1", byHuman: false, createdAt: new Date(2026, 10, 8, 16, 2) });
    expect(await lastReplyWasVoice(ig.id)).toBe(false);
  });
});

describe("на «спасибо / рахмат / хоб» голосом не отвечаем", () => {
  beforeEach(() => { state.rows.length = 0; });

  it.each(["Pahmat apajon", "Хоб", "Xob mayli", "Рахмат", "Спасибо большое", "Ок, спасибо", "Раҳмат, апа!", "хуб, рахмат", "ладно", "Хорошо",
    // ❤️ = сердце + невидимый U+FE0F: раньше из-за него «спасибо с сердечком» получало голосовое.
    "Спасибо ❤️", "Рахмат апачон ❤️", "Спасибо 🙏🏻❤️", "Ташаккури зиёд", "Рахмати калон 🥰"])(
    "«%s» — благодарность без вопроса",
    (t) => expect(isShortAcknowledgement(t)).toBe(true),
  );
  it.each(["Спасибо, а сколько стоит?", "Рахмат, курс кай сар мешад", "Хоб, адрес дайте", "Салом", "", null])(
    "«%s» — не благодарность или есть вопрос",
    (t) => expect(isShortAcknowledgement(t)).toBe(false),
  );
  it("после «Pahmat apajon» голосового нет даже при включённом рубильнике", async () => {
    expect(await trySendVoiceReply(ig, "Марҳамат, ҳар вақт нависед.", false, "Pahmat apajon")).toBeNull();
    expect(state.rows).toHaveLength(0);
  });
});
