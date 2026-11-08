// Exercise the actual Nginx configuration and built pages, without production
// databases, credentials, purchases or outbound messages. Requires Docker.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import http from "node:http";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "../..");
const nginxImage = fs.readFileSync(path.join(web, "Dockerfile"), "utf8").match(/^FROM\s+(nginx:\S+)/m)?.[1];
assert.ok(nginxImage, "Use the same Nginx image as the production Dockerfile");
const name = `shirin-seo-test-${process.pid}-${Date.now()}`;
const api = `${name}-api`;
const nginx = `${name}-web`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }).trim();
let checks = 0;
try {
  docker("network", "create", name);
  docker("run", "-d", "--name", api, "--network", name, "--network-alias", "api",
    "--mount", `type=bind,source=${path.join(root, "apps/api/dist")},target=/compiled,readonly`,
    "--mount", `type=bind,source=${path.join(web, "tests/fixtures")},target=/fixture,readonly`,
    "node:24-alpine", "node", "/fixture/catalog-api.mjs");
  docker("run", "-d", "--name", nginx, "--network", name, "-p", "127.0.0.1::80",
    "--mount", `type=bind,source=${path.join(web, "dist")},target=/usr/share/nginx/html,readonly`,
    "--mount", `type=bind,source=${path.join(web, "nginx.conf")},target=/etc/nginx/conf.d/default.conf,readonly`,
    nginxImage);
  docker("exec", nginx, "nginx", "-t");
  const port = docker("port", nginx, "80/tcp").split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  const request = (route, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(base + route, { headers: { Host: "shirinsweets.online", ...headers }, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Fixture request timed out")));
    req.on("error", reject);
  });
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await request("/health")).status, 200); break; }
    catch (error) { if (attempt >= 30) throw error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  for (const route of ["/", "/online-kurs", "/art-desserty", "/ru/", "/tg/online-kurs", "/tg/art-desserty"]) {
    const response = await request(route, { Cookie: "private-session=fixture", Authorization: "Bearer fixture" });
    const html = await response.text();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(Object.fromEntries(response.headers))}`);
    assert.match(response.headers.get("cache-control") || "", /no-store/, route);
    assert.equal(response.headers.get("x-robots-tag"), null, "fragment noindex must not leak to page");
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("last-modified"), null);
    assert.match(html, /data-server-catalog="ready"/, route);
    assert.doesNotMatch(html, /<!--#|an error occurred while processing/, route);
    assert.match(html, (route === "/" || route.startsWith("/tg/")) ? /83 сомонӣ/ : /83 сомони/, route);
    if (route.endsWith("art-desserty")) assert.doesNotMatch(html, /91 сомон|147 сомон/, route);
    else assert.match(html, /147 сомон/, route);
    checks++;
  }
  // Offline facts from the panel (via /_site/offer-fact), in body, <title> and meta.
  for (const route of ["/kursy-konditera-dushanbe", "/tg/kursy-konditera-dushanbe", "/faq", "/tg/faq", "/"]) {
    const response = await request(route, { Cookie: "private-session=fixture", Authorization: "Bearer fixture" });
    const html = await response.text();
    assert.equal(response.status, 200, route);
    assert.doesNotMatch(html, /<!--#|\{\{offline|an error occurred while processing/, route);
    assert.match(html, /777 сомон/, route);
    if (route.includes("kursy")) {
      assert.match(html, /<title>[^<]*777 сомон[^<]*<\/title>/, `${route}: title`);
      assert.match(html, /09:15/, route);
      assert.match(html, /23 (десерт|ширинӣ|намуд)/, route);
      assert.doesNotMatch(html, /13:40|16:30|700 сомон/, route);
    }
    checks++;
  }
  // Course address (footer, map link, JSON-LD) on every public page, incl. pages without prices.
  for (const route of ["/sertifikat", "/tg/o-shirin", "/politika-konfidentsialnosti", "/"]) {
    const html = await (await request(route)).text();
    assert.doesNotMatch(html, /<!--#|\{\{contact|an error occurred while processing|Додо/, route);
    assert.match(html, /Фикстура, улица 9/, route);
    assert.match(html, /maps\.google\.com\/\?q=fixture%20street%209/, route);
    assert.match(html, /"streetAddress":"улица 9"/, route);
    checks++;
  }
  {
    const missing = await request("/missing-course-page");
    const html = await missing.text();
    assert.equal(missing.status, 404);
    assert.doesNotMatch(html, /<!--#/);
    assert.match(html, /Фикстура, улица 9/);
    checks++;
  }
  assert.equal((await request("/_site/offer-fact?key=offline.price")).status, 404); checks++;
  assert.equal((await request("/tg/")).status, 301); checks++;
  assert.equal((await request("/_site/catalog-fragment?lang=ru")).status, 404); checks++;
  assert.equal((await request("/missing-course-page")).status, 404); checks++;
  for (const route of ["/course", "/panel"]) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /noindex/); checks++;
  }
  await request("/api/site/fixture?mode=updated");
  const changed = await request("/online-kurs", { "If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT" });
  assert.equal(changed.status, 200);
  assert.match(await changed.text(), /97 сомони/); checks++;
  for (const mode of ["empty", "error", "slow"]) {
    await request(`/api/site/fixture?mode=${mode}`);
    const response = await request("/online-kurs");
    const html = await response.text();
    assert.equal(response.status, 200, mode);
    assert.match(html, /WhatsApp/, mode);
    assert.doesNotMatch(html, /83 сомон|91 сомон|97 сомон|147 сомон|an error occurred while processing/, mode);
    checks++;
  }
  // API down: offline facts come from the 30 s micro-cache (stale allowed) or
  // the build-time fallback — never an SSI error or an empty price.
  await request("/api/site/fixture?mode=error");
  {
    const html = await (await request("/kursy-konditera-dushanbe")).text();
    assert.doesNotMatch(html, /<!--#|an error occurred while processing/);
    assert.match(html, /(777|700) сомон/);
    checks++;
  }
  console.log(`Nginx SSI integration: ${checks} scenarios passed (synthetic catalogue only).`);
} catch (error) {
  for (const container of [api, nginx]) {
    try { console.error(docker("logs", "--tail", "20", container)); } catch { /* container may not exist */ }
  }
  throw error;
} finally {
  for (const container of [nginx, api]) {
    try { docker("rm", "-f", container); } catch { /* never remove unrelated containers */ }
  }
  try { docker("network", "rm", name); } catch { /* only this invocation's network */ }
}
