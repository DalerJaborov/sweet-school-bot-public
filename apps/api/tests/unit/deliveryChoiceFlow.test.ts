import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@prisma/client";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { MetaDeliveryError } from "../../src/messaging/metaErrors.js";

const { sendToContact, createOneTimeInviteLink } = vi.hoisted(() => ({ sendToContact: vi.fn(), createOneTimeInviteLink: vi.fn() }));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact }));
vi.mock("../../src/telegram.js", () => ({ createOneTimeInviteLink }));
vi.mock("../../src/groupAccess.js", () => ({ rememberInviteLink: vi.fn() }));
import { grantCourses } from "../../src/ai/grantCourses.js";
import { DELIVERY_QUESTION, handleDeliveryChoiceReply, parseDeliveryAnswer } from "../../src/course/deliveryChoice.js";

let db: PrismaMock;
let contact: Record<string, any>;
let purchases: Record<string, any>[];
let messages: Record<string, any>[];
let frozen: boolean;
const plan = { grant: ["COURSE70" as const], note: "paid" };
const asContact = () => ({ ...contact }) as Contact;
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (key === "id" && value?.in) return value.in.includes(row.id);
    return (row[key] ?? null) === value;
  });
}
beforeEach(() => {
  db = mockPrisma(); frozen = false; purchases = []; messages = [];
  contact = { ...fakeContact(), preferredLanguage: "ru", courseDeliveryChoice: null, deliveryChoicePromptState: null,
    deliveryChoiceAskedAt: null, deliveryChoicePromptMid: null, deliveryChoiceDispatchAt: null, accessTokenId: null, accessIssuedAt: null };
  sendToContact.mockReset().mockImplementation(async () => `mid-${sendToContact.mock.calls.length}`);
  createOneTimeInviteLink.mockReset().mockResolvedValue("https://t.me/+one-use");
  db.model("setting").findUnique.mockImplementation(async (arg: any) => {
    const values: Record<string, string> = { botFrozen: String(frozen), telegramBotToken: "fake", telegramChatId70: "group", courseDeliveryMode: "both" };
    return { value: values[arg.where.key] ?? "" };
  });
  db.model("contact").findUnique.mockImplementation(async () => ({ ...contact }));
  db.model("contact").updateMany.mockImplementation(async (arg: any) => {
    if (!matches(contact, arg.where)) return { count: 0 };
    Object.assign(contact, arg.data); return { count: 1 };
  });
  db.model("contact").update.mockImplementation(async (arg: any) => Object.assign(contact, arg.data));
  db.model("course").findUnique.mockResolvedValue({ id: "catalog", code: "COURSE70" });
  db.model("lesson").count.mockResolvedValue(1);
  db.model("purchase").findUnique.mockImplementation(async (arg: any) => purchases.find((p) => matches(p, arg.where.contactId_course ?? arg.where)) ?? null);
  db.model("purchase").findMany.mockImplementation(async (arg: any) => purchases.filter((p) => matches(p, arg.where)));
  db.model("purchase").count.mockImplementation(async (arg: any) => purchases.filter((p) => matches(p, arg.where)).length);
  db.model("purchase").create.mockImplementation(async (arg: any) => {
    const p = { id: `p${purchases.length}`, inviteLink: null, revokedAt: null, accessDeliveryUncertainAt: null, source: "RECEIPT", ...arg.data };
    purchases.push(p); return p;
  });
  db.model("purchase").update.mockImplementation(async (arg: any) => Object.assign(purchases.find((p) => p.id === arg.where.id)!, arg.data));
  db.model("purchase").updateMany.mockImplementation(async (arg: any) => {
    const found = purchases.filter((p) => matches(p, arg.where)); found.forEach((p) => Object.assign(p, arg.data)); return { count: found.length };
  });
  db.model("message").create.mockImplementation(async (arg: any) => { messages.push({ ...arg.data }); return arg.data; });
  db.model("message").findFirst.mockImplementation(async (arg: any) => messages.filter((m) => matches(m, arg.where)).at(-1) ?? null);
});
afterEach(restorePrisma);

async function pay() { return grantCourses(asContact(), plan, 70, { amount: 70, currency: "TJS" }); }

describe("paid delivery choice", () => {
  it.each([["да", "telegram"], ["нет", "web"], ["ҳа", "telegram"], ["не", "web"]])("asks once, preserves payment, and routes %s to %s", async (answer, mode) => {
    if (answer === "ҳа" || answer === "не") contact.preferredLanguage = "tg";
    expect(await pay()).toEqual([]);
    expect(contact.paid).toBe(true);
    expect(purchases[0]).toMatchObject({ amount: 70, deliveryAwaitingChoice: true, inviteLink: null });
    expect(sendToContact.mock.calls[0][1]).toBe(DELIVERY_QUESTION[contact.preferredLanguage as "ru" | "tg"]);
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    await pay();
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(purchases).toHaveLength(1);
    expect(await handleDeliveryChoiceReply(asContact(), answer)).toBe(true);
    expect(contact.courseDeliveryChoice).toBe(mode);
    expect(purchases[0].deliveryAwaitingChoice).toBe(false);
    expect(purchases[0].inviteLink).toMatch(mode === "telegram" ? /t\.me/ : /\/l\//);
    expect(createOneTimeInviteLink).toHaveBeenCalledTimes(mode === "telegram" ? 1 : 0);
    expect(await handleDeliveryChoiceReply(asContact(), answer)).toBe(false);
    expect(sendToContact).toHaveBeenCalledTimes(2);
  });

  it("parallel contradictory answers cannot issue two different routes", async () => {
    await pay();
    await Promise.all([handleDeliveryChoiceReply(asContact(), "да"), handleDeliveryChoiceReply(asContact(), "нет")]);
    expect(sendToContact).toHaveBeenCalledTimes(2);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].deliveryAwaitingChoice).toBe(false);
  });
  it("a yes without the delivery question, or after another question, cannot choose", async () => {
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(false);
    await pay();
    messages.push({ contactId: contact.id, direction: "OUT", mid: "other", text: "Другой вопрос" });
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(false);
    expect(contact.courseDeliveryChoice).toBeNull();
    expect(await handleDeliveryChoiceReply(asContact(), "У меня есть Telegram")).toBe(true);
  });
  it("ambiguous question delivery is not repeated and bare yes is not guessed", async () => {
    sendToContact.mockRejectedValueOnce(new MetaDeliveryError("AMBIGUOUS", 0));
    await pay(); await pay();
    expect(contact.deliveryChoicePromptState).toBe("UNKNOWN");
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(purchases[0].amount).toBe(70);
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(false);
    expect(await handleDeliveryChoiceReply(asContact(), "на сайте")).toBe(true);
  });
  it("ambiguous access delivery retains payment and blocks another invitation", async () => {
    await pay();
    sendToContact.mockRejectedValueOnce(new MetaDeliveryError("AMBIGUOUS", 0));
    await handleDeliveryChoiceReply(asContact(), "да");
    expect(purchases[0].accessDeliveryUncertainAt).toBeInstanceOf(Date);
    expect(purchases[0].deliveryAwaitingChoice).toBe(true);
    await handleDeliveryChoiceReply(asContact(), "Telegram есть");
    expect(createOneTimeInviteLink).toHaveBeenCalledTimes(1);
    expect(purchases).toHaveLength(1);
  });
  it("freeze after payment never erases the purchase or sends access", async () => {
    await pay(); frozen = true;
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(false);
    expect(purchases[0].amount).toBe(70);
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });
  it.each(["WEB", "MANUAL"])("%s customers keep direct website access without a Telegram question", async (channel) => {
    contact.channel = channel;
    expect(await pay()).toEqual(["COURSE70"]);
    expect(contact.courseDeliveryChoice).toBeNull();
    expect(purchases[0].inviteLink).toMatch(/\/l\//);
    expect(sendToContact.mock.calls[0][1]).not.toContain("У вас есть Telegram");
  });
  it("retries a known failed question only when the customer returns", async () => {
    sendToContact.mockRejectedValueOnce(new Error("offline"));
    await pay(); await pay();
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(contact.deliveryChoicePromptState).toBe("FAILED");
    await handleDeliveryChoiceReply(asContact(), "Здравствуйте");
    expect(sendToContact).toHaveBeenCalledTimes(2);
    expect(contact.deliveryChoicePromptState).toBe("WAITING");
    expect(purchases).toHaveLength(1);
  });
  it.each(["нет Telegram", "У меня нет Telegram", "Telegram надорам"])("understands explicit negative %s", (answer) => {
    expect(parseDeliveryAnswer(answer)).toEqual({ choice: "web", explicit: true });
  });
  it("only a persisted accepted receipt permits delivery after operator takeover", async () => {
    await pay(); contact.humanTakenOverAt = new Date();
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(false);
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    db.model("receiptCheck").findFirst.mockResolvedValue({ imageHash: "accepted-receipt" });
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(true);
    expect(createOneTimeInviteLink).toHaveBeenCalledTimes(1);
    expect(db.model("receiptCheck").findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ contactId: contact.id, awaitingDeliveryChoice: true }) }));
  });
  it("even an accepted receipt cannot bypass personal-contact policy", async () => {
    await pay(); contact.personal = true;
    db.model("receiptCheck").findFirst.mockResolvedValue({ imageHash: "accepted-receipt" });
    expect(await handleDeliveryChoiceReply(asContact(), "да")).toBe(false);
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });
  it("does not interpret questions or contradictory prose as an answer", () => {
    for (const input of ["да но нет", "а Telegram обязательно?", "нет времени", "дайте рецепт", "нет Telegram, но есть у сестры"]) expect(parseDeliveryAnswer(input)).toBeNull();
  });
});
