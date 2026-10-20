import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { siteHtmlInputs } from "./scripts/build-site-pages.mjs";

/**
 * Одна сборка — три приложения: панель владельца (index.html), платформа
 * ученицы (course.html) и публичный сайт (site.html, online-kurs.html, …,
 * tg/*.html — генерируются из site-content/ скриптом scripts/build-site-pages.mjs
 * перед сборкой, см. package.json → "pages"). Приложения разные — разные
 * люди, разный вход, разный вид, — но собирать их по отдельности значило бы
 * дублировать конфиг, зависимости и Docker-образ.
 */
const siteInputs = Object.fromEntries(
  siteHtmlInputs()
    .filter((f) => existsSync(resolve(__dirname, f)))
    .map((f) => [f.replace(/\.html$/, "").replace(/\//g, "-"), resolve(__dirname, f)]),
);

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        course: resolve(__dirname, "course.html"),
        ...siteInputs,
      },
    },
  },
  server: {
    port: 5180,
    proxy: {
      "/admin": "http://localhost:4100",
      "/api": "http://localhost:4100",
      "/health": "http://localhost:4100",
      "/media": "http://localhost:4100",
    },
  },
});
