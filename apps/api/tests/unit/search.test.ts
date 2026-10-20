import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { searchRouter, searchSections, type SearchResponse } from "../../src/search.js";

/**
 * ⌘K-поиск: минимум два символа, три группы не длиннее восьми строк,
 * синонимы разделов («цена» → Тексты и цены), оплатившие ученицы — первыми.
 */
let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(searchRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function search(q: string): Promise<SearchResponse> {
  const r = await fetch(`${base}/admin/search?q=${encodeURIComponent(q)}`);
  expect(r.status).toBe(200);
  return (await r.json()) as SearchResponse;
}

function contact(i: number, paid: boolean) {
  return { id: `c${i}`, username: `madina${i}`, name: null, igUserId: `ig-${i}`, paid, offlineSignup: null };
}

describe("searchSections — разделы по словам владелицы", () => {
  it("синонимы: «цена» и «реквизиты» → Тексты и цены, «чек» → Чеки", () => {
    expect(searchSections("цена").map((s) => s.tab)).toEqual(["texts"]);
    expect(searchSections("реквизиты").map((s) => s.tab)).toEqual(["texts"]);
    expect(searchSections("чек").map((s) => s.tab)).toContain("receipts");
  });

  it("совпадение по началу названия без учёта регистра и ё", () => {
    expect(searchSections("Ден").map((s) => s.tab)).toEqual(["money"]);
    expect(searchSections("настр").map((s) => s.tab)).toEqual(["settings"]);
  });

  it("короче двух символов — пусто", () => {
    expect(searchSections("ц")).toEqual([]);
  });
});

describe("GET /admin/search", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findMany.mockResolvedValue([]);
    db.model("lesson").findMany.mockResolvedValue([]);
  });
  afterEach(restorePrisma);

  it("запрос короче двух символов — три пустые группы и ни одного обращения к базе", async () => {
    const r = await search("м");
    expect(r).toEqual({ q: "м", students: [], lessons: [], sections: [] });
    expect(db.model("contact").findMany).not.toHaveBeenCalled();
  });

  it("группирует: ученицы, уроки, разделы", async () => {
    db.model("contact").findMany.mockResolvedValue([
      { ...contact(1, true), offlineSignup: { name: "Мадина Р.", phone: "+992900000001" } },
    ]);
    db.model("lesson").findMany.mockResolvedValue([
      { id: "l1", title: "Тирамису", order: 3, module: { course: { title: "21 рецепт" } } },
    ]);
    const r = await search("ма");
    expect(r.students).toEqual([{ id: "c1", handle: "@madina1", name: "Мадина Р.", paid: true, phone: "+992900000001" }]);
    expect(r.lessons).toEqual([{ id: "l1", title: "Тирамису", order: 3, course: "21 рецепт" }]);
    expect(r.sections).toEqual([]);
  });

  it("оплатившие — первыми, не больше восьми в группе", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => contact(i, i >= 6));
    db.model("contact").findMany.mockResolvedValue(rows);
    const r = await search("madina");
    expect(r.students).toHaveLength(8);
    expect(r.students.slice(0, 6).every((s) => s.paid)).toBe(true);
    expect(r.students.slice(6).every((s) => !s.paid)).toBe(true);
  });

  it("кириллица ищется в обоих регистрах: в where уходят «Мадина» и «мадина»", async () => {
    await search("Мадина");
    const arg = db.model("contact").findMany.mock.calls[0][0] as { where: { OR: { username?: { contains: string } }[] } };
    const usernames = arg.where.OR.map((o) => o.username?.contains).filter(Boolean);
    expect(usernames).toContain("мадина");
    expect(usernames).toContain("Мадина");
  });

  it("уроки из корзины не ищутся: в where уходит deletedAt: null", async () => {
    await search("тирамису");
    const arg = db.model("lesson").findMany.mock.calls[0][0] as { where: { deletedAt?: unknown } };
    expect(arg.where.deletedAt).toBeNull();
  });

  it("«цена» находит раздел «Тексты и цены»", async () => {
    const r = await search("цена");
    expect(r.sections).toEqual([{ tab: "texts", title: "Тексты и цены" }]);
  });
});
