import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const findPeople = vi.fn(async (_q: string): Promise<unknown[]> => []);
const issueOwnerLink = vi.fn(async (_id: string, _k: string): Promise<unknown> => ({ ok: true, kind: "web", url: "https://x.test/l/A", courses: [] }));
vi.mock("../../src/course/ownerLink.js", async (orig) => ({
  ...(await orig<typeof import("../../src/course/ownerLink.js")>()),
  findPeople: (q: string) => findPeople(q),
  issueOwnerLink: (id: string, k: string) => issueOwnerLink(id, k),
}));

import { ownerLinkRouter } from "../../src/course/ownerLinkRoutes.js";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(ownerLinkRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, "127.0.0.1", r);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  findPeople.mockClear();
  issueOwnerLink.mockClear();
});

const post = (body: unknown) =>
  fetch(`${base}/admin/access-link/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Панель: выдать ссылку", () => {
  it("поиск возвращает людей и ничего не выдаёт", async () => {
    findPeople.mockResolvedValueOnce([{ id: "c1", handle: "@a", name: null, courses: [] }]);
    const r = await fetch(`${base}/admin/access-link/search?q=anna`);
    expect((await r.json()).people).toHaveLength(1);
    expect(findPeople).toHaveBeenCalledWith("anna");
    expect(issueOwnerLink).not.toHaveBeenCalled();
  });
  it("выдача по явному выбору человека и способа", async () => {
    const r = await post({ contactId: "c1", kind: "telegram" });
    expect(r.status).toBe(200);
    expect(issueOwnerLink).toHaveBeenCalledWith("c1", "telegram");
  });
  it("мусор в запросе не доходит до выдачи", async () => {
    expect((await post({ contactId: "c1", kind: "root" })).status).toBe(400);
    expect((await post({ kind: "web" })).status).toBe(400);
    expect(issueOwnerLink).not.toHaveBeenCalled();
  });
  it("отказ — 409 с понятным текстом", async () => {
    issueOwnerLink.mockResolvedValueOnce({ ok: false, reason: "in-group" });
    const r = await post({ contactId: "c1", kind: "telegram" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("уже в группе");
  });
});
