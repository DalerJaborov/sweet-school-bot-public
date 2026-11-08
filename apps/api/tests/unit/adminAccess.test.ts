import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { adminAccessConfig, createAdminAccessGuard, verifyAdminAccess } from "../../src/adminAccess.js";

const config = { issuer: "https://school-test.cloudflareaccess.com", audience: "a".repeat(64),
  email: "owner@example.com", origins: ["https://school.example.com"] };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let otherPair: Awaited<ReturnType<typeof generateKeyPair>>;
let server: Server;
let base: string;
let ownerToken: string;
const revoked = new Set<string>();
let databaseFails = false;
const now = () => Math.floor(Date.now() / 1000);
async function sign(overrides: JWTPayload = {}, signingKey = pair.privateKey) {
  return new SignJWT({ iss: config.issuer, aud: config.audience, sub: "owner-id", email: config.email,
    iat: now(), exp: now() + 3600, ...overrides }).setProtectedHeader({ alg: "RS256" }).sign(signingKey);
}
const keys = () => Promise.resolve(pair.publicKey);
const store = {
  async has(hash: string) { if (databaseFails) throw new Error("unavailable"); return revoked.has(hash); },
  async add(hash: string) { if (databaseFails) throw new Error("unavailable"); revoked.add(hash); },
};
async function start() {
  const app = express();
  app.use(["/admin", "/admin-form"], createAdminAccessGuard(config, store, keys));
  app.use(express.json());
  // A formerly unguarded early router must never run before the Access gate.
  app.post("/admin/telegram-login", (_req, res) => res.json({ token: "legacy-token" }));
  app.all("/admin/*", (_req, res) => res.json({ protected: true }));
  app.post("/admin-form/setting", (_req, res) => res.json({ written: true }));
  app.get("/api/course", (_req, res) => res.json({ student: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
beforeAll(async () => {
  pair = await generateKeyPair("RS256"); otherPair = await generateKeyPair("RS256");
  ownerToken = await sign(); await start();
});
afterAll(stop);

describe("school Access assertion validation", () => {
  it("accepts only the configured owner and application", async () => {
    expect(await verifyAdminAccess(ownerToken, config, keys)).toMatchObject({ email: config.email });
  });
  it.each([
    { email: "previous-admin@example.com" }, { aud: "other-app" }, { iss: "https://attacker.example" },
    { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 100 }, { sub: "" }, { email: undefined },
    { exp: Math.floor(Date.now() / 1000) + 86400 }, { iat: 1 },
  ])("rejects invalid claims %j", async claims => {
    expect(await verifyAdminAccess(await sign(claims), config, keys)).toBeNull();
  });
  it("rejects a forged signature and HMAC substitution", async () => {
    expect(await verifyAdminAccess(await sign({}, otherPair.privateKey), config, keys)).toBeNull();
    const hmac = await new SignJWT({ email: config.email }).setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("synthetic-test-secret-only"));
    expect(await verifyAdminAccess(hmac, config, keys)).toBeNull();
  });
  it("rejects missing/oversized assertions and key lookup failure", async () => {
    expect(await verifyAdminAccess("", config, keys)).toBeNull();
    expect(await verifyAdminAccess("a".repeat(16385), config, keys)).toBeNull();
    expect(await verifyAdminAccess(ownerToken, config, async () => { throw new Error("offline"); })).toBeNull();
  });
  it("fails closed for missing production configuration", () => {
    expect(() => adminAccessConfig({ NODE_ENV: "production" })).toThrow();
    expect(() => adminAccessConfig({ SCHOOL_ACCESS_REQUIRED: "yes" })).toThrow();
    expect(() => adminAccessConfig({ SCHOOL_ACCESS_REQUIRED: "1" })).toThrow();
    const source = { SCHOOL_ACCESS_REQUIRED: "1", SCHOOL_ACCESS_TEAM_DOMAIN: "school-test.cloudflareaccess.com",
      SCHOOL_ACCESS_AUDIENCE: config.audience, SCHOOL_ADMIN_EMAIL: config.email, SCHOOL_ADMIN_ORIGINS: config.origins[0] };
    expect(adminAccessConfig(source)).toEqual(config);
    expect(() => adminAccessConfig({ ...source, SCHOOL_ADMIN_ORIGINS: "https://school.example.com/path" })).toThrow();
    expect(() => adminAccessConfig({ ...source, SCHOOL_ACCESS_TEAM_DOMAIN: "attacker.example" })).toThrow();
  });
});

describe("HTTP boundary before every legacy route", () => {
  it.each(["/admin/settings", "/ADMIN/settings", "/admin/courses", "/admin/lessons/1/video-uploads", "/admin/session", "/admin/v1/waiting"])
    ("rejects anonymous and email/header impersonation at %s", async path => {
      const res = await fetch(base + path, { headers: {
        "Cf-Access-Authenticated-User-Email": config.email, Authorization: "Bearer old-admin-token" } });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  it.each(["/admin/login", "/admin/telegram-login", "/admin-form/setting"])
    ("disables legacy route %s even for an authenticated owner", async path => {
      const res = await fetch(base + path, { method: "POST", headers: { "cf-access-jwt-assertion": ownerToken,
        Origin: config.origins[0], "Content-Type": "application/json" }, body: JSON.stringify({ password: "old", auth: "old" }) });
      expect(res.status).toBe(403);
    });
  it.each([undefined, "null", "https://attacker.example", "https://school.example.com.attacker.example"])
    ("blocks writes with invalid Origin %s", async origin => {
      const res = await fetch(base + "/admin/settings", { method: "POST", headers: {
        "cf-access-jwt-assertion": ownerToken, ...(origin ? { Origin: origin } : {}) } });
      expect(res.status).toBe(403);
    });
  it("permits owner reads and same-origin chunk uploads", async () => {
    const session = await fetch(base + "/admin/session", { headers: { "cf-access-jwt-assertion": ownerToken } });
    expect(await session.json()).toEqual({ mode: "access", email: config.email });
    const upload = await fetch(base + "/admin/lessons/1/video-uploads/1/chunks/0", { method: "PUT",
      headers: { "cf-access-jwt-assertion": ownerToken, Origin: config.origins[0], "Content-Type": "application/octet-stream" },
      body: new Uint8Array(4096) });
    expect(upload.status).toBe(200);
  });
  it("does not put student routes or health behind admin auth", async () => {
    expect((await fetch(base + "/api/course")).status).toBe(200);
    expect((await fetch(base + "/health")).status).toBe(200);
  });
  it("fails closed when revocation storage is unavailable", async () => {
    databaseFails = true;
    try { expect((await fetch(base + "/admin/session", { headers: { "cf-access-jwt-assertion": ownerToken } })).status).toBe(503); }
    finally { databaseFails = false; }
  });
  it("logout blocks replay, including after recreating the HTTP server", async () => {
    const headers = { "cf-access-jwt-assertion": ownerToken, Origin: config.origins[0] };
    expect((await fetch(base + "/admin/logout", { method: "POST", headers })).status).toBe(200);
    await stop(); await start();
    expect((await fetch(base + "/admin/session", { headers })).status).toBe(401);
    expect((await fetch(base + "/admin/settings", { headers })).status).toBe(401);
  });
});
