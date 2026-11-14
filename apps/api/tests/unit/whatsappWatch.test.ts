import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const bridgeRequest = vi.fn();
vi.mock("../../src/whatsapp/client.js", () => ({
  bridgeRequest: (...a: unknown[]) => bridgeRequest(...a),
  whatsappConfigured: () => true,
}));
const sendTelegramMessage = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  techChatIds: vi.fn(async () => ["owner-1"]),
}));
const shouldSendAlert = vi.fn(async () => true);
vi.mock("../../src/alertGate.js", () => ({ shouldSendAlert: (...a: unknown[]) => shouldSendAlert(...a) }));

import { checkWhatsappConnection, whatsappProblem, resetWhatsappWatch, WHATSAPP_SUSTAINED_MS } from "../../src/whatsapp/watch.js";

let db: PrismaMock;
let settings: Record<string, string>;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  db = mockPrisma();
  settings = { telegramBotToken: "tok", whatsappEverReady: "1" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] ? { key: where.key, value: settings[where.key] } : null
  );
  db.model("setting").upsert.mockResolvedValue({});
  bridgeRequest.mockReset();
  sendTelegramMessage.mockClear();
  shouldSendAlert.mockClear();
  shouldSendAlert.mockResolvedValue(true);
  resetWhatsappWatch();
});
afterEach(() => restorePrisma());

describe("Сторож WhatsApp", () => {
  it("подключён — тишина, в панели пусто", async () => {
    bridgeRequest.mockResolvedValue({ state: "ready", contactsReady: true });
    await checkWhatsappConnection(T0);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(whatsappProblem(T0)).toBeNull();
  });
  it("короткое отключение (меньше 10 минут) никого не будит", async () => {
    bridgeRequest.mockResolvedValue({ state: "pairing", contactsReady: false });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS - 60_000);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(whatsappProblem(T0 + WHATSAPP_SUSTAINED_MS - 60_000)).toBeNull();
  });
  it("дольше 10 минут — строка в панели, а в Telegram НЕ пишем (11.11.2026: «WhatsApp отключился» — шум)", async () => {
    bridgeRequest.mockResolvedValue({ state: "pairing", contactsReady: false });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS);
    await checkWhatsappConnection(T0 + 7 * 3_600_000);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(whatsappProblem(T0 + WHATSAPP_SUSTAINED_MS)).toContain("Настройки → WhatsApp → Подключить");
  });
  it("мост не отвечает — отдельный текст в панели", async () => {
    bridgeRequest.mockRejectedValue(new Error("down"));
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS);
    expect(whatsappProblem(T0 + WHATSAPP_SUSTAINED_MS)).toContain("мост связи не отвечает");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
  it("ожил — проблема снимается", async () => {
    bridgeRequest.mockResolvedValue({ state: "auth_failure", contactsReady: false });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS);
    bridgeRequest.mockResolvedValue({ state: "ready", contactsReady: true });
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS + 60_000);
    expect(whatsappProblem(T0 + WHATSAPP_SUSTAINED_MS + 60_000)).toBeNull();
  });
  it("ни разу не подключали — молчим", async () => {
    delete settings.whatsappEverReady;
    bridgeRequest.mockResolvedValue({ state: "pairing", contactsReady: false });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS * 2);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(whatsappProblem(T0 + WHATSAPP_SUSTAINED_MS * 2)).toBeNull();
  });
  it("пауза ответов (paused, контакты загружены) — не поломка", async () => {
    bridgeRequest.mockResolvedValue({ state: "paused", contactsReady: true });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS * 2);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
