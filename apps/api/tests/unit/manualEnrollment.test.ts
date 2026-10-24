import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { adminRouter } from "../../src/admin.js";
import { env } from "../../src/env.js";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

let server: Server;
let base: string;
const token = jwt.sign({ role: "admin" }, env.jwtSecret);
const input = {
  name: "Мадина",
  phone: "+992 (90) 535-53-55",
  lang: "tg",
  course: "BOTH",
  amount: 100,
  paymentConfirmed: true,
};
const course = (code: string, price: number) => ({
  id: code,
  code,
  price,
  title: code,
  active: true,
  modules: [
    {
      lessons: [
        {
          status: "READY",
          hlsPath: "video/master.m3u8",
          encryptionKey: Buffer.alloc(16).toString("base64"),
          isPreview: false,
        },
      ],
    },
  ],
});
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ error: "test failure" }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
const post = (body: unknown = input, auth: string | null = token) =>
  fetch(`${base}/admin/manual-enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });

describe("admin manual enrollment", () => {
  let db: PrismaMock;
  let customer: Record<string, unknown> | null;
  let purchases: Record<string, unknown>[];
  beforeEach(() => {
    db = mockPrisma();
    customer = null;
    purchases = [];
    db.model("course").findMany.mockResolvedValue([course("COURSE50", 50), course("COURSE70", 70)]);
    db.model("contact").findUnique.mockImplementation(async () => customer);
    db.model("contact").create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        (customer = fakeContact({ ...data, id: "manual-1", accessTokenId: null, accessIssuedAt: null })),
    );
    db.model("contact").update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => (customer = { ...customer, ...data }),
    );
    db.model("purchase").findMany.mockImplementation(async () => purchases);
    db.model("purchase").create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const p = { id: `p${purchases.length}`, ...data };
      purchases.push(p);
      return p;
    });
  });
  afterEach(restorePrisma);

  it("requires the admin role for both mutations and catalog", async () => {
    expect((await post(input, null)).status).toBe(401);
    expect((await post(input, jwt.sign({ kind: "course-session" }, env.jwtSecret))).status).toBe(401);
    expect((await fetch(`${base}/admin/manual-enrollments/catalog`)).status).toBe(401);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.model("course").findMany).not.toHaveBeenCalled();
  });

  it("requires explicit actual-payment confirmation and validates amount, phone and language", async () => {
    for (const patch of [
      { paymentConfirmed: false },
      { paymentConfirmed: undefined },
      { amount: 0 },
      { amount: 1.5 },
      { phone: "+oops" },
      { lang: "en" },
    ]) {
      expect((await post({ ...input, ...patch })).status).toBe(400);
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("atomically creates a manual customer, course purchases and one stable owner-only link; retry adds no revenue", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await post();
    expect(response.status).toBe(200);
    const first = (await response.json()) as { url: string; contactId: string; createdCourses: string[] };
    expect(first).toMatchObject({ contactId: "manual-1", createdCourses: ["COURSE50", "COURSE70"] });
    expect(first.url).toMatch(/\/l\/[a-zA-Z2-9]{10}$/);
    expect(customer).toMatchObject({
      channel: "MANUAL",
      igUserId: "+992905355355",
      name: "Мадина",
      paid: true,
      preferredLanguage: "tg",
    });
    expect(purchases).toHaveLength(2);
    expect(purchases.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(100);
    expect(purchases.every((p) => p.source === "MANUAL" && p.courseId === p.course)).toBe(true);
    const repeat = await post({ ...input, phone: "905355355" });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ url: first.url, alreadyEnrolled: true, createdCourses: [] });
    expect(db.model("purchase").create).toHaveBeenCalledTimes(2);
    expect(db.model("contact").update).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.model("receiptCheck").create).not.toHaveBeenCalled();
    expect(db.model("message").create).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith(base))).toBe(true);
  });

  it("adds only a missing selected purchase and preserves a usable code and issue date", async () => {
    const issued = new Date();
    customer = fakeContact({
      id: "manual-1",
      channel: "MANUAL",
      accessTokenId: "Abcdefgh23",
      accessIssuedAt: issued,
      paid: true,
    });
    purchases = [{ id: "p-old", course: "COURSE50", amount: 50 }];
    const res = await post({ ...input, course: "COURSE70", amount: 70 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: `${env.publicBaseUrl}/l/Abcdefgh23`, createdCourses: ["COURSE70"] });
    expect(purchases).toHaveLength(2);
    expect(customer?.accessIssuedAt).toEqual(issued);
    const update = db.model("contact").update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data).not.toHaveProperty("accessTokenId");
  });

  it.each(["revoked-contact", "revoked-purchase", "expired-link"])("does not restore %s implicitly", async (state) => {
    customer = fakeContact({
      id: "manual-1",
      accessTokenId: "Abcdefgh23",
      accessIssuedAt: new Date(state === "expired-link" ? Date.now() - 8 * 86400000 : Date.now()),
      accessRevokedAt: state === "revoked-contact" ? new Date() : null,
    });
    purchases = state === "revoked-purchase" ? [{ course: "COURSE50", revokedAt: new Date() }] : [];
    expect((await post()).status).toBe(409);
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(db.model("purchase").create).not.toHaveBeenCalled();
  });

  it.each(["empty", "processing", "missing-hls", "missing-key", "inactive", "preview-only"])(
    "rejects %s inventory before any customer write",
    async (state) => {
      const c = course("COURSE50", 50);
      if (state === "empty") c.modules = [];
      if (state === "processing") c.modules[0].lessons[0].status = "PROCESSING";
      if (state === "missing-hls") c.modules[0].lessons[0].hlsPath = "";
      if (state === "missing-key") c.modules[0].lessons[0].encryptionKey = "";
      if (state === "preview-only") c.modules[0].lessons[0].isPreview = true;
      db.model("course").findMany.mockResolvedValue(state === "inactive" ? [] : [c]);
      expect((await post({ ...input, course: "COURSE50" })).status).toBe(409);
      expect(db.model("contact").create).not.toHaveBeenCalled();
      expect(db.model("purchase").create).not.toHaveBeenCalled();
    },
  );
});
