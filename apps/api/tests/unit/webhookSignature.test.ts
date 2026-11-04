import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/funnel.js", () => ({
  upsertContact: vi.fn(async () => fakeContact()),
  handleIncomingDm: vi.fn(),
  handleComment: vi.fn(),
}));
vi.mock("../../src/ai.js", () => ({ aiReply: vi.fn(), registerOfflineIfAsked: vi.fn(), rescueIncomingImages: vi.fn() }));
vi.mock("../../src/debounce.js", () => ({ debounceMessage: vi.fn() }));
vi.mock("../../src/ai/personalContact.js", () => ({ looksPersonal: () => false }));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: vi.fn() }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn() }));
vi.mock("../../src/ownMedia.js", () => ({ findOwnMedia: vi.fn(), viewableUrl: vi.fn() }));
vi.mock("../../src/ai/media.js", () => ({ fetchAttachment: vi.fn() }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn() }));

import { webhookRouter } from "../../src/webhook.js";
import * as database from "../../src/db.js";
import { upsertContact, handleIncomingDm, handleComment } from "../../src/funnel.js";
import { fetchAttachment } from "../../src/ai/media.js";
import { rememberOwnerReply } from "../../src/ai/styleLearning.js";

let server: Server;
let base: string;
let db: PrismaMock;
let settings: Record<string, string>;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: (req, _res, raw) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = raw;
  } }));
  app.use(webhookRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db = mockPrisma();
  settings = { appSecret: "", verifyToken: "test-verify-token", botFrozen: "true" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key in settings ? { key: where.key, value: settings[where.key] } : null);
});
afterEach(restorePrisma);

function post(path: string, body: string, signature?: string) {
  return fetch(base + path, {
    method: "POST", body,
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
  });
}
function sign(body: string) {
  return "sha256=" + createHmac("sha256", settings.appSecret).update(body).digest("hex");
}
function expectNoProcessing() {
  expect(upsertContact).not.toHaveBeenCalled();
  expect(db.model("message").create).not.toHaveBeenCalled();
  expect(db.model("contact").update).not.toHaveBeenCalled();
  expect(handleIncomingDm).not.toHaveBeenCalled();
  expect(handleComment).not.toHaveBeenCalled();
  expect(fetchAttachment).not.toHaveBeenCalled();
  expect(rememberOwnerReply).not.toHaveBeenCalled();
}

describe.each([
  ["/webhooks/instagram", "instagram"],
  ["/webhooks/messenger", "page"],
])("Meta signature boundary %s", (path, object) => {
  const empty = JSON.stringify({ object, entry: [] });
  it.each([false, true])("rejects unsigned messages with no app secret, including frozen bot echo=%s", async (echo) => {
    const body = JSON.stringify({ object, entry: [{ id: "test-page", messaging: [{
      sender: { id: echo ? "test-page" : "test-contact" },
      recipient: { id: echo ? "test-contact" : "test-page" },
      message: { mid: "test-mid", text: "Курс чанд пул?", is_echo: echo,
        attachments: [{ type: "image", payload: { url: "https://example.invalid/test.jpg" } }] },
    }] }] });
    expect((await post(path, body)).status).toBe(403);
    expectNoProcessing();
  });
  it("keeps verification challenge available before app secret is configured", async () => {
    const response = await fetch(`${base}${path}?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=test-challenge`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test-challenge");
    expectNoProcessing();
  });
  it("accepts correctly signed delivery once the secret is configured", async () => {
    settings.appSecret = "test-app-secret";
    expect((await post(path, empty, sign(empty))).status).toBe(200);
  });
  it("rejects missing, malformed and tampered signatures with a configured secret", async () => {
    settings.appSecret = "test-app-secret";
    for (const signature of [undefined, "sha256=short", sign(empty + " ")]) {
      expect((await post(path, empty, signature)).status).toBe(403);
    }
    expectNoProcessing();
  });
});
