import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { businessFollowsUser, silenceIfFollowedByBusiness, resetFollowCache } from "../../src/profiles.js";

const contact = { id: "c-1", channel: "INSTAGRAM", igUserId: "ig-1", paid: false, personal: false };
const fetchMock = vi.fn();

function replyFollows(value: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => (value === undefined ? { error: { code: 230 } } : { is_business_follow_user: value }) });
}

describe("бот молчит с теми, на кого подписана Ширин", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    resetFollowCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "igToken" ? { value: "tok" } : null
    );
    db.model("purchase").count.mockResolvedValue(0);
  });
  afterEach(() => {
    restorePrisma();
    vi.unstubAllGlobals();
  });

  it("ГЛАВНОЕ: подписана — контакт помечается личным, отвечать не нужно", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false })).toBe(true);
    const upd = db.model("contact").update.mock.calls[0][0] as { data: { personal: boolean; personalReason: string } };
    expect(upd.data.personal).toBe(true);
    expect(upd.data.personalReason).toContain("подписана");
    expect(String(fetchMock.mock.calls[0][0])).toContain("is_business_follow_user");
  });

  it("не подписана — отвечаем как обычно", async () => {
    replyFollows(false);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false })).toBe(false);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("API не ответил или не дал согласия — сомнение: отвечаем", async () => {
    replyFollows(undefined);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false })).toBe(false);
    fetchMock.mockRejectedValue(new Error("сеть"));
    resetFollowCache();
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false })).toBe(false);
  });

  it("оплатившая и ученица с покупкой не молчат, даже если Ширин на неё подписана", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness({ ...contact, paid: true }, { hasImage: false })).toBe(false);
    db.model("purchase").count.mockResolvedValue(1);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false })).toBe(false);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("с картинкой (возможный чек) не молчим", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: true })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("другие каналы и уже личные контакты не проверяются", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness({ ...contact, channel: "WHATSAPP" }, { hasImage: false })).toBe(false);
    expect(await silenceIfFollowedByBusiness({ ...contact, personal: true }, { hasImage: false })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ответ API кэшируется: второй вопрос про того же человека без запроса", async () => {
    replyFollows(false);
    await businessFollowsUser("ig-1");
    await businessFollowsUser("ig-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
