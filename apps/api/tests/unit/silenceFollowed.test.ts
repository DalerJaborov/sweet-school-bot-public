import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { businessFollowsUser, silenceIfFollowedByBusiness, resetFollowCache, releaseFollowSilenceIfClient, FOLLOW_PERSONAL_REASON } from "../../src/profiles.js";

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

/**
 * ЗНАКОМЫЙ ИЛИ КЛИЕНТ (владелец 09.11.2026): подписка Ширин глушила навсегда и
 * реальных клиентов (пришли с рекламы, спросили цену), и тестовый аккаунт
 * владельца. Теперь подписка глушит, только если нет ни одного признака клиента.
 */
describe("подписка не глушит клиента", () => {
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
    db.model("delivery").count.mockResolvedValue(0);
    db.model("message").findMany.mockResolvedValue([]);
  });
  afterEach(() => {
    restorePrisma();
    vi.unstubAllGlobals();
  });

  it("ГЛАВНОЕ: вопрос про курс или цену — не глушим и даже не спрашиваем Meta", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false, text: "Курс чанд пул?" })).toBe(false);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false, text: "Сколько стоит обучение?" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("нажала кнопку воронки — клиент", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false, text: "Ҳа", payload: "step:f:2" })).toBe(false);
  });

  it("пришла с рекламы, через воронку или раньше спрашивала про курс — клиент", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness({ ...contact, adReferralAt: new Date() }, { hasImage: false, text: "Салом" })).toBe(false);
    db.model("delivery").count.mockResolvedValueOnce(1);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false, text: "Салом" })).toBe(false);
    db.model("message").findMany.mockResolvedValueOnce([{ text: "нархи курс чанд?" }]);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false, text: "а когда начало?" })).toBe(false);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("знакомая без признаков клиента — по-прежнему молчим", async () => {
    replyFollows(true);
    expect(await silenceIfFollowedByBusiness(contact, { hasImage: false, text: "Офарин, зебо!" })).toBe(true);
  });

  it("авто-отметка снимается, когда человек ведёт себя как клиент; ручная — никогда", async () => {
    const auto = { ...contact, personal: true, personalReason: FOLLOW_PERSONAL_REASON };
    const released = await releaseFollowSilenceIfClient(auto, { text: "Курсро чӣ тавр харам?" });
    expect(released.personal).toBe(false);
    expect(db.model("contact").update).toHaveBeenCalledWith({ where: { id: "c-1" }, data: { personal: false, personalReason: null } });

    db.model("contact").update.mockClear();
    const manual = { ...contact, personal: true, personalReason: "Отмечен вручную" };
    expect((await releaseFollowSilenceIfClient(manual, { text: "Курс чанд пул?" })).personal).toBe(true);
    expect((await releaseFollowSilenceIfClient(auto, { text: "Офарин" })).personal).toBe(true);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
});
