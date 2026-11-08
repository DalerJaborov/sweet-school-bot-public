import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { normalizeEntry, parseList, importPersonalList, isListedPersonal } from "../../src/ai/personalList.js";
import { startsWithFamilyAddress } from "../../src/ai/personalContact.js";
import { storyReplyWorthAnswer } from "../../src/ai/storyRelevance.js";

let db: PrismaMock;
beforeEach(() => { db = mockPrisma(); });
afterEach(restorePrisma);

describe("список личных контактов", () => {
  it("ники и номера приводятся к ключу", () => {
    expect(normalizeEntry("@Mama_Nick")).toBe("mama_nick");
    expect(normalizeEntry("https://www.instagram.com/sestra.nick/?hl=ru")).toBe("sestra.nick");
    expect(normalizeEntry("+992 90 000-00-00")).toBe("992900000000");
    expect(normalizeEntry("не ник!!")).toBeNull();
    expect(parseList("a1\nA1, b2;\n\n+99290000000")).toEqual(["a1", "b2", "99290000000"]);
  });
  it("импорт сохраняет список и помечает уже писавших", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    const r = await importPersonalList("mama_nick\n+99290000000\n???");
    expect(r).toEqual({ added: 2, marked: 2, invalid: 1 });
    expect(db.model("setting").upsert).toHaveBeenCalled();
  });
  it("контакт из списка узнаётся по нику", async () => {
    db.model("setting").findUnique.mockResolvedValue({ value: "mama_nick\n99290000000" });
    expect(await isListedPersonal("Mama_Nick")).toBe(true);
    expect(await isListedPersonal("client_1")).toBe(false);
  });
});

describe("родня и истории", () => {
  it("обращение в начале — родня, в середине фразы — нет, «апа» — клиентка", () => {
    expect(startsWithFamilyAddress("Доченька, как ты?")).toBe(true);
    expect(startsWithFamilyAddress("Мама, позвони")).toBe(true);
    expect(startsWithFamilyAddress("моя мама хочет курс")).toBe(false);
    expect(startsWithFamilyAddress("Апа, салом, нарх чанд?")).toBe(false);
  });
  it("история: только про курсы", () => {
    expect(storyReplyWorthAnswer({ storyCaption: "Запись на курс", replyText: "хочу" })).toBe(true);
    expect(storyReplyWorthAnswer({ storyCaption: "Новый торт", replyText: "красота" })).toBe(false);
    expect(storyReplyWorthAnswer({ storyCaption: null, replyText: "нарх чанд?" })).toBe(true);
    expect(storyReplyWorthAnswer({ storyCaption: "", replyText: "❤️" })).toBe(false);
  });
});
