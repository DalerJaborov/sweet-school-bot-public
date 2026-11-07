import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { knowledgeReviewRouter, knowledgeReviewHash } from "../../src/knowledgeReview.js";

let server: Server;
let base: string;
let db: PrismaMock;
const row = { id: "q1", studentText: "Можно заменить сливки молоком в шоколадном креме?", ownerText: "Сливки молоком в шоколадном креме заменять нельзя.", approvedForAnswer: false, courseId: null };
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use("/review", knowledgeReviewRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/review`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { db = mockPrisma(); db.model("qaExample").findUnique.mockResolvedValue(row); db.model("qaExample").updateMany.mockResolvedValue({ count: 1 }); db.model("course").findUnique.mockResolvedValue({ id: "c1", active: true }); });
afterEach(restorePrisma);
const post = (body: unknown) => fetch(`${base}/examples/q1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("owner technical-answer review", () => {
  it("requires the exact content the owner viewed", async () => {
    expect((await post({ approved: true, courseId: "c1", reviewHash: "0".repeat(64) })).status).toBe(409);
    expect(db.model("qaExample").updateMany).not.toHaveBeenCalled();
  });
  it("rejects missing or inactive course", async () => {
    expect((await post({ approved: true, reviewHash: knowledgeReviewHash(row) })).status).toBe(400);
    db.model("course").findUnique.mockResolvedValue({ active: false });
    expect((await post({ approved: true, courseId: "c1", reviewHash: knowledgeReviewHash(row) })).status).toBe(400);
  });
  it("approval cannot edit raw texts or media permission", async () => {
    expect((await post({ approved: true, courseId: "c1", reviewHash: knowledgeReviewHash(row) })).status).toBe(200);
    expect(db.model("qaExample").updateMany).toHaveBeenCalledWith({ where: { id: row.id, studentText: row.studentText, ownerText: row.ownerText }, data: { approvedForAnswer: true, courseId: "c1" } });
  });
  it("can revoke approval without choosing a course", async () => {
    expect((await post({ approved: false })).status).toBe(200);
    expect(db.model("qaExample").updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { approvedForAnswer: false, courseId: null } }));
  });
  it("pagination stays stable as earlier examples are approved", async () => {
    db.model("qaExample").findMany.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ ...row, id: `q${i}` })));
    db.model("course").findMany.mockResolvedValue([]);
    const response = await fetch(`${base}/examples?after=q0&approved=false`);
    const data = await response.json() as { examples: unknown[]; nextCursor: string };
    expect(data.examples).toHaveLength(20); expect(data.nextCursor).toBe("q19");
    expect(db.model("qaExample").findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { gt: "q0" }, approvedForAnswer: false }) }));
  });
});
