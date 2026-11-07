import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { deliveryMode, issueCourseLink, accessMessage, linkPurchaseToCourse } from "../../src/course/delivery.js";

describe("deliveryMode", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue({ id: "contact-1", accessTokenId: null, accessIssuedAt: null });
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(restorePrisma);

  it("по умолчанию telegram — новая дверь не открывается сюрпризом после деплоя", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);
    expect(await deliveryMode()).toBe("telegram");
  });

  it("мусор в настройке трактуется как telegram, а не как поломка", async () => {
    db.model("setting").findUnique.mockResolvedValue({ value: "чтотоне то" });
    expect(await deliveryMode()).toBe("telegram");
  });

  it("web и both читаются как есть", async () => {
    db.model("setting").findUnique.mockResolvedValue({ value: "web" });
    expect(await deliveryMode()).toBe("web");
    db.model("setting").findUnique.mockResolvedValue({ value: "both" });
    expect(await deliveryMode()).toBe("both");
  });
});

describe("issueCourseLink", () => {
  it("frozen: automatic issuance cannot rotate an existing student's access", async () => {
    const db = mockPrisma();
    db.model("setting").findUnique.mockResolvedValue({ value: "true" });
    await expect(issueCourseLink("contact-1", { automatic: true })).rejects.toThrow("Bot automation is frozen");
    await expect(issueCourseLink("contact-1")).rejects.toThrow("Bot automation is frozen");
    expect(db.model("contact").update).not.toHaveBeenCalled();
    await expect(issueCourseLink("contact-1", { automatic: false })).resolves.toEqual(expect.any(String));
    expect(db.model("contact").update).toHaveBeenCalledOnce();
  });
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue({ id: "contact-1", accessTokenId: null, accessIssuedAt: null });
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(restorePrisma);

  it("выдаёт ссылку ЧЕЛОВЕКУ и запоминает её идентификатор на контакте, гася прошлую", async () => {
    const url = await issueCourseLink("contact-1");

    expect(url).toMatch(/\/l\/[A-Za-z0-9]{10}/);
    const call = db.model("contact").updateMany.mock.calls[0][0] as {
      data: { accessTokenId: string; accessIssuedAt: Date };
    };
    expect(call.data.accessTokenId).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(call.data.accessIssuedAt).toBeInstanceOf(Date);
  });

  it("automatic delivery preserves a valid link without extending its expiry", async () => {
    db.model("contact").findUnique.mockResolvedValue({ accessTokenId: "Ab3kQ9xZpm", accessIssuedAt: new Date() });
    expect(await issueCourseLink("contact-1")).toContain("/l/Ab3kQ9xZpm");
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
  it("automatic delivery cannot reactivate revoked access", async () => {
    db.model("contact").findUnique.mockResolvedValue({ accessRevokedAt: new Date() });
    expect(await issueCourseLink("contact-1")).toBeNull();
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
  it("parallel automatic issuance converges on one valid code using compare-and-swap", async () => {
    let current = { id: "contact-1", accessTokenId: null as string | null, accessIssuedAt: null as Date | null };
    db.model("contact").findUnique.mockImplementation(async () => ({ ...current }));
    db.model("contact").updateMany.mockImplementation(async (args) => {
      const call = args as { where: { accessTokenId: string | null }; data: { accessTokenId: string; accessIssuedAt: Date } };
      if (call.where.accessTokenId !== current.accessTokenId) return { count: 0 };
      current = { ...current, ...call.data };
      return { count: 1 };
    });
    const links = await Promise.all([issueCourseLink("contact-1"), issueCourseLink("contact-1")]);
    expect(links[0]).toBe(links[1]);
    expect(links[0]).toContain(current.accessTokenId);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
  it("каждая выдача даёт новый идентификатор — старая ссылка не оживает", async () => {
    await issueCourseLink("contact-1", { automatic: false });
    await issueCourseLink("contact-1", { automatic: false });

    const calls = db.model("contact").update.mock.calls as { data: { accessTokenId: string } }[][];
    expect(calls[0][0].data.accessTokenId).not.toBe(calls[1][0].data.accessTokenId);
  });
});

describe("linkPurchaseToCourse", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue({ id: "contact-1", accessTokenId: null, accessIssuedAt: null });
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(restorePrisma);

  it("каталога ещё нет — молча пропускаем, это не ошибка", async () => {
    db.model("course").findUnique.mockResolvedValue(null);

    await linkPurchaseToCourse("purchase-1", "COURSE50");

    expect(db.model("purchase").update).not.toHaveBeenCalled();
  });

  it("курс найден — проставляем связь", async () => {
    db.model("course").findUnique.mockResolvedValue({ id: "course-1", code: "COURSE50" });

    await linkPurchaseToCourse("purchase-1", "COURSE50");

    expect(db.model("purchase").update).toHaveBeenCalledWith({
      where: { id: "purchase-1" },
      data: { courseId: "course-1" },
    });
  });
});

describe("accessMessage", () => {
  const web = "https://school.example/course?token=abc";
  const tg = "https://t.me/+invite";

  it("обе ссылки: платформа первой и с объяснением, зачем она", () => {
    const text = accessMessage({ courseTitle: "Арт-десерты", telegramLink: tg, webLink: web, withTitle: false })!;

    expect(text.indexOf(web)).toBeLessThan(text.indexOf(tg));
    expect(text).toContain("без Telegram");
  });

  it("только платформа: есть подсказка про экран «Домой» — от неё зависит офлайн на айфоне", () => {
    const text = accessMessage({ courseTitle: null, telegramLink: null, webLink: web, withTitle: false })!;

    expect(text).toContain(web);
    expect(text).toContain("Домой");
    expect(text).toContain("без интернета");
  });

  it("только Telegram: сообщение как было раньше, одна голая ссылка", () => {
    const text = accessMessage({ courseTitle: "Арт-десерты", telegramLink: tg, webLink: null, withTitle: false });
    expect(text).toBe(tg);
  });

  it("несколько курсов разом — название курса в первой строке", () => {
    const text = accessMessage({ courseTitle: "21 рецепт", telegramLink: tg, webLink: null, withTitle: true })!;
    expect(text.split("\n")[0]).toBe("21 рецепт");
  });

  it("ни одной ссылки — null, выдача считается неудавшейся", () => {
    expect(accessMessage({ courseTitle: "X", telegramLink: null, webLink: null, withTitle: false })).toBeNull();
  });
});
