import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
const bridgeRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/whatsapp/client.js", () => ({ bridgeRequest, whatsappConfigured: () => true, BridgeError: class extends Error {} }));
import { adminRouter } from "../../src/admin.js";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(adminRouter);
  server = createServer(app).listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
describe("WhatsApp owner routes use actual parent authentication", () => {
  it.each([
    ["GET", "/admin/v1/whatsapp/status"], ["POST", "/admin/v1/whatsapp/start"],
    ["POST", "/admin/v1/whatsapp/resume"], ["POST", "/admin/v1/whatsapp/logout"],
    ["GET", "/admin/v1/conversations/paused"], ["POST", "/admin/v1/conversations/c/resume"],
    ["POST", "/admin/v1/conversations/c/block"], ["GET", "/admin/v1/conversations/attention"],
    ["POST", "/admin/v1/conversations/c/answered"], ["POST", "/admin/v1/conversations/c/return-to-bot"],
  ])("rejects unauthenticated %s %s before side effects", async (method, path) => {
    const response = await fetch(base + path, { method, headers: { authorization: "Bearer invalid" } });
    expect(response.status).toBe(401);
    expect(bridgeRequest).not.toHaveBeenCalled();
  });
});
