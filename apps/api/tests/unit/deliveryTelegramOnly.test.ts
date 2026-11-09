import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@prisma/client";
import { fakeContact, mockPrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn() }));
import { deliveryModeFor } from "../../src/course/delivery.js";
import { deferGrantForChoice } from "../../src/course/deliveryChoice.js";

/**
 * Владелец 08.11.2026: «как только получаем деньги — пусть бот отправит ссылку на Телеграм, и всё».
 * Режим telegram (он же по умолчанию) — ни вопроса «куда прислать», ни ссылки на платформу,
 * и для WhatsApp тоже (раньше WhatsApp был жёстко «только платформа»).
 */
let db: PrismaMock;
let mode: string | null;
beforeEach(() => {
  db = mockPrisma(); mode = null;
  db.model("setting").findUnique.mockImplementation(async (arg: any) =>
    arg.where.key === "courseDeliveryMode" ? (mode === null ? null : { value: mode }) : { value: "" });
});

describe("deliveryModeFor — WhatsApp идёт по настройке, сайт всегда платформа", () => {
  it("без настройки — telegram для Instagram и WhatsApp, web только для сайта", async () => {
    expect(await deliveryModeFor({ channel: "WHATSAPP" })).toBe("telegram");
    expect(await deliveryModeFor({ channel: "INSTAGRAM" })).toBe("telegram");
    expect(await deliveryModeFor({ channel: "WEB" })).toBe("web");
  });
  it("настройка web — WhatsApp тоже получает платформу; личный выбор человека важнее настройки", async () => {
    mode = "web";
    expect(await deliveryModeFor({ channel: "WHATSAPP" })).toBe("web");
    expect(await deliveryModeFor({ channel: "WHATSAPP", courseDeliveryChoice: "telegram" })).toBe("telegram");
  });
});

describe("deferGrantForChoice — вопрос «куда прислать» только в режиме both", () => {
  const args = [{ grant: ["COURSE70" as const], note: "paid" }, 70, { amount: 70, currency: "TJS" }, {}] as const;
  it("режим telegram (и пустой): вопроса нет, покупка выдаётся сразу, в базу не лезем", async () => {
    const contact = { ...fakeContact(), channel: "INSTAGRAM" } as Contact;
    expect(await deferGrantForChoice(contact, ...args)).toBe(false);
    mode = "telegram";
    expect(await deferGrantForChoice(contact, ...args)).toBe(false);
    expect(db.model("contact").findUnique).not.toHaveBeenCalled();
  });
  it("режим both: прежний порядок — доходит до проверки контакта", async () => {
    mode = "both";
    db.model("contact").findUnique.mockResolvedValue(null);
    const contact = { ...fakeContact(), channel: "INSTAGRAM" } as Contact;
    expect(await deferGrantForChoice(contact, ...args)).toBe(false);
    expect(db.model("contact").findUnique).toHaveBeenCalledTimes(1);
  });
});
