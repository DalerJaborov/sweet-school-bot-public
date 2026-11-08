// Synthetic data only. Runs inside the disposable SSI integration network.
import http from "node:http";
import { renderCatalogFragment } from "/compiled/site/catalogFragment.js";

let mode = "ready";
const catalog = () => ({
  courses: mode === "empty" ? [] : [
    { code: "COURSE50", title: "Арт-десерты", description: null, price: 83, currency: "TJS", coverUrl: null, lessonsCount: 10, durationMin: 59 },
    { code: "COURSE70", title: "21 рецепт", description: null, price: mode === "updated" ? 97 : 91, currency: "TJS", coverUrl: null, lessonsCount: 21, durationMin: 303 },
  ],
  bundle: { price: 147, fullPrice: 174 },
  contacts: { whatsapp: "https://wa.me/992905355355" },
});

http.createServer((req, res) => {
  const url = new URL(req.url, "http://api");
  if (url.pathname === "/health") return res.end("ok");
  if (url.pathname === "/api/site/fixture") {
    mode = url.searchParams.get("mode") || "ready";
    return res.end("ok");
  }
  if (url.pathname === "/api/site/offer-fact") {
    if (req.headers.cookie || req.headers.authorization) { res.statusCode = 500; return res.end("credentials must not reach the SSI request"); }
    if (mode === "error") { res.statusCode = 503; return res.end(""); }
    const facts = { "offline.price": "777", "offline.days": "9", "offline.daysRu": "9 дней", "offline.desserts": "23", "offline.dessertsRu": "23 десерта", "offline.timeFrom": "09:15", "offline.timeTo": "12:45", "offline.hours": "09:15–12:45", "contact.address": "Фикстура, улица 9", "contact.street": "улица 9", "contact.mapsQuery": "fixture%20street%209" };
    const value = facts[url.searchParams.get("key")];
    if (!value) { res.statusCode = 400; return res.end(""); }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(value);
  }
  if (url.pathname === "/api/site/catalog-fragment") {
    if (req.headers.cookie || req.headers.authorization) {
      res.statusCode = 500;
      return res.end("credentials must not reach the SSI request");
    }
    if (mode === "error") { res.statusCode = 503; return res.end("fixture unavailable"); }
    const send = () => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.end(renderCatalogFragment(catalog(), url.searchParams.get("lang"), url.searchParams.get("only") || undefined));
    };
    if (mode === "slow") return setTimeout(send, 4500);
    return send();
  }
  res.statusCode = 404;
  res.end("not found");
}).listen(4100, "0.0.0.0");
