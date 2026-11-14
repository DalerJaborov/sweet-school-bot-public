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
  chatsForKind: vi.fn(async () => ["owner-1"]),
}));
const shouldSendAlert = vi.fn(async () => true);
vi.mock("../../src/alertGate.js", () => ({ shouldSendAlert: (...a: unknown[]) => shouldSendAlert(...a) }));

import {
  checkWhatsappConnection,
  whatsappProblem,
  resetWhatsappWatch,
  WHATSAPP_SUSTAINED_MS,
  WHATSAPP_DOWN_ALERT_MS,
  WHATSAPP_ALERT_REPEAT_MS,
} from "../../src/whatsapp/watch.js";

let db: PrismaMock;
let settings: Record<string, string>;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  db = mockPrisma();
  settings = { telegramBotToken: "tok", whatsappEverReady: "1" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] ? { key: where.key, value: settings[where.key] } : null
  );
  db.model("setting").upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    settings[where.key] = update.value;
    return {};
  });
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
  it("дольше 10 минут — строка в панели, Telegram молчит до 3 часов (11.11.2026: каждое отключение — шум)", async () => {
    bridgeRequest.mockResolvedValue({ state: "pairing", contactsReady: false });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS);
    await checkWhatsappConnection(T0 + WHATSAPP_DOWN_ALERT_MS - 60_000);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(whatsappProblem(T0 + WHATSAPP_SUSTAINED_MS)).toContain("Настройки → WhatsApp → Подключить");
  });
  it("отключение дольше 3 часов — одно сообщение владельцу, повтор не раньше чем через сутки", async () => {
    bridgeRequest.mockResolvedValue({ state: "pairing", contactsReady: false });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_DOWN_ALERT_MS);
    await checkWhatsappConnection(T0 + WHATSAPP_DOWN_ALERT_MS + 60_000);
    await checkWhatsappConnection(T0 + 7 * 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("WhatsApp отключился 3 ч");
    await checkWhatsappConnection(T0 + WHATSAPP_DOWN_ALERT_MS + WHATSAPP_ALERT_REPEAT_MS);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
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
  it("короткая пауза ответов (меньше 3 ч) — не поломка, тишина", async () => {
    bridgeRequest.mockResolvedValue({ state: "paused", contactsReady: true });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + WHATSAPP_SUSTAINED_MS * 2);
    await checkWhatsappConnection(T0 + 3 * 3_600_000 - 60_000);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(whatsappProblem(T0 + 3 * 3_600_000 - 60_000)).toBeNull();
  });
  it("пауза дольше 3 ч (09–13.11 пауза 4 дня глотала чеки) — строка в панели и одно сообщение владельцу", async () => {
    bridgeRequest.mockResolvedValue({ state: "paused", contactsReady: true });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + 3 * 3_600_000);
    await checkWhatsappConnection(T0 + 5 * 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const text = String(sendTelegramMessage.mock.calls[0][2]);
    expect(text).toContain("WhatsApp на паузе уже 3 ч");
    expect(text).toContain("чеки");
    expect(text).toContain("Только чеки");
    expect(whatsappProblem(T0 + 5 * 3_600_000)).toContain("на паузе уже 5 ч");
  });
  it("порог паузы берётся из настройки whatsappPauseAlertHours", async () => {
    settings.whatsappPauseAlertHours = "1";
    bridgeRequest.mockResolvedValue({ state: "paused", contactsReady: true });
    await checkWhatsappConnection(T0);
    await checkWhatsappConnection(T0 + 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
  it("перезапуск api не обнуляет счётчик: начало беды берётся из настроек", async () => {
    settings.whatsappTroubleSince = `paused:${T0}`;
    bridgeRequest.mockResolvedValue({ state: "paused", contactsReady: true });
    await checkWhatsappConnection(T0 + 4 * 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("на паузе уже 4 ч");
  });
  it("уже предупредили до перезапуска — повторно в тот же день не пишем", async () => {
    settings.whatsappTroubleSince = `paused:${T0}`;
    settings.whatsappTroubleAlertAt = String(T0 + 3 * 3_600_000);
    bridgeRequest.mockResolvedValue({ state: "paused", contactsReady: true });
    await checkWhatsappConnection(T0 + 4 * 3_600_000);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
  it("мост ожил — отметка беды стирается", async () => {
    settings.whatsappTroubleSince = `paused:${T0}`;
    bridgeRequest.mockResolvedValue({ state: "ready", contactsReady: true });
    await checkWhatsappConnection(T0 + 60_000);
    const upserts = db.model("setting").upsert.mock.calls.map((c: unknown[]) => (c[0] as { where: { key: string }; update: { value: string } }));
    expect(upserts.some((u) => u.where.key === "whatsappTroubleSince" && u.update.value === "")).toBe(true);
  });
});
