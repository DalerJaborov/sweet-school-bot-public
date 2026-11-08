import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async (..._a: unknown[]) => "mid-1");
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);

vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: (c: { channel: string }) => c.channel,
}));
vi.mock("../../src/whatsapp/transport.js", () => ({
  sendWhatsAppText: (...a: unknown[]) => sendText(...a),
  sendWhatsAppAttachment: vi.fn(),
}));
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { requestTransferCode, verifyTransferCode, resetTransferCodes, approveTransferByOwner } from "../../src/course/phoneTransfer.js";
import { claimPlayback, resetPlaybackLocks } from "../../src/course/playbackLock.js";
import type { Contact } from "@prisma/client";

const contact = fakeContact({ id: "c-1", channel: "WHATSAPP", igUserId: "992900000000", username: null, name: "Гулнора", deviceSwaps: 0, deviceSwapAt: null, preferredLanguage: "ru" }) as unknown as Contact;

describe("перенос на новый телефон по коду", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    resetTransferCodes();
    sendText.mockClear();
    sendTelegramMessage.mockClear();
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    db.model("device").findMany.mockResolvedValue([]);
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "telegramBotToken" ? { value: "token" } : null
    );
  });
  afterEach(restorePrisma);

  function sentCode(): string {
    return /(\d{6})/.exec(String(sendText.mock.calls.at(-1)?.[1]))![1];
  }

  it("код уходит в ЧАТ покупательницы, подходит один раз и только верный", async () => {
    expect(await requestTransferCode(contact)).toBe("sent");
    const code = sentCode();
    expect(verifyTransferCode(contact.id, code === "000000" ? "111111" : "000000")).toBe(false);
    expect(verifyTransferCode(contact.id, code)).toBe(true);
    expect(verifyTransferCode(contact.id, code)).toBe(false); // сгорел
  });

  it("5 неверных попыток — код мёртв, даже верный", async () => {
    await requestTransferCode(contact);
    const code = sentCode();
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) expect(verifyTransferCode(contact.id, wrong)).toBe(false);
    expect(verifyTransferCode(contact.id, code)).toBe(false);
  });

  it("код другой покупательницы не подходит", async () => {
    await requestTransferCode(contact);
    expect(verifyTransferCode("c-2", sentCode())).toBe(false);
  });

  it("повторный запрос в первую минуту — пауза, второй код не уходит", async () => {
    await requestTransferCode(contact);
    expect(await requestTransferCode(contact)).toBe("cooldown");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("не удалось отправить в чат — владельцу сообщение, кода нет", async () => {
    sendText.mockRejectedValueOnce(new Error("окно WhatsApp закрыто"));
    expect(await requestTransferCode(contact)).toBe("send_failed");
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("не получилось отправить код");
    expect(verifyTransferCode(contact.id, "123456")).toBe(false);
  });

  it("перенос в этом месяце уже был — код НЕ шлём, владельцу карточка с кнопкой «Разрешить перенос»", async () => {
    const used = { ...contact, deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 5 * 86_400_000) } as unknown as Contact;
    db.model("device").findMany.mockResolvedValue([
      { userAgent: "Mozilla/5.0 (iPhone)", lastCity: "TJ", lastSeenAt: new Date("2026-11-07") },
    ]);

    expect(await requestTransferCode(used)).toBe("owner_asked");

    expect(sendText).not.toHaveBeenCalled();
    const call = sendTelegramMessage.mock.calls[0];
    expect(String(call[2])).toContain("ещё раз в этом месяце");
    expect(String(call[2])).toContain("iPhone");
    expect(JSON.stringify(call[4])).toContain("mn:tr:c-1");
  });

  it("владелец разрешил: месячный лимит сброшен, покупательнице написали", async () => {
    expect(await approveTransferByOwner("c-1")).toBe(true);
    const upd = db.model("contact").update.mock.calls[0][0] as { data: { deviceSwaps: number; deviceSwapAt: null } };
    expect(upd.data).toEqual({ deviceSwaps: 0, deviceSwapAt: null });
    expect(String(sendText.mock.calls[0][1])).toContain("Перенос на новый телефон разрешён");
  });

  it("по-таджикски код приходит на таджикском", async () => {
    await requestTransferCode({ ...contact, preferredLanguage: "tg" } as unknown as Contact);
    expect(String(sendText.mock.calls[0][1])).toContain("Рамз барои гузаронидани");
  });
});

describe("одновременный просмотр", () => {
  beforeEach(resetPlaybackLocks);

  it("одно устройство (несколько вкладок/браузеров телефона) — не блокирует само себя", () => {
    expect(claimPlayback("c-1", "phone")).toBe(true);
    expect(claimPlayback("c-1", "phone")).toBe(true);
  });

  it("второй телефон, пока первый играет, — отказ", () => {
    const t0 = 1_000_000;
    expect(claimPlayback("c-1", "phone-A", t0)).toBe(true);
    expect(claimPlayback("c-1", "phone-B", t0 + 30_000)).toBe(false);
    // Первый продолжает — замок продлён.
    expect(claimPlayback("c-1", "phone-A", t0 + 60_000)).toBe(true);
    expect(claimPlayback("c-1", "phone-B", t0 + 100_000)).toBe(false);
  });

  it("первый замолчал на две минуты — второй может играть", () => {
    const t0 = 1_000_000;
    claimPlayback("c-1", "phone-A", t0);
    expect(claimPlayback("c-1", "phone-B", t0 + 121_000)).toBe(true);
  });

  it("разные покупательницы друг другу не мешают", () => {
    expect(claimPlayback("c-1", "phone-A")).toBe(true);
    expect(claimPlayback("c-2", "phone-B")).toBe(true);
  });
});
