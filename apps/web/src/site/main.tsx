import { applyTheme, initTheme, THEME_KEY } from "../course/theme";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./site.css";
import { dict } from "./i18n";
import { bindLangSwitch, pageLang, syncLangOnEntry } from "./lang";
import { CoursesIsland } from "./CoursesIsland";
import { OfflineForm } from "./OfflineForm";
import { FreeLesson } from "./FreeLesson";
import { openChat } from "./chat/bus";

/**
 * Точка входа сайта. Страницы — статичный HTML (scripts/build-site-pages.mjs),
 * React оживляет только «островки»: карточки курсов из API, форму записи и
 * чат. Всё остальное — разметка и CSS, чтобы главная открывалась мгновенно
 * и на 2G, и в поиске была с текстом.
 */

initTheme();
document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.addEventListener("click", (event) => {
  const dark = document.documentElement.dataset.theme !== "dark";
  applyTheme(dark ? "dark" : "light");
  (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(dark));
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    /* Storage is optional. */
  }
});
document
  .querySelector("[data-theme-toggle]")
  ?.setAttribute("aria-pressed", String(document.documentElement.dataset.theme === "dark"));

/** Фоновое видео героя: включаем, когда пошёл первый кадр; при «меньше анимации» и экономии трафика остаётся постер. */
(() => {
  const videos = document.querySelectorAll<HTMLVideoElement>("[data-hero-video]");
  if (!videos.length) return;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  videos.forEach((video) => {
    if (saveData || reduce) {
      video.remove();
      return;
    }
    const show = () => video.classList.add("is-playing");
    video.addEventListener("playing", show, { once: true });
    // Видео могло начать играть до загрузки этого скрипта — событие уже прошло.
    if (!video.paused && video.readyState >= 3) show();
    video.play().then(show, () => video.remove());
  });
})();

if (!syncLangOnEntry()) {
  const lang = pageLang();
  const t = dict(lang);
  let chatAvailable = false;
  // Reuse the same school assistant; the server's pause is authoritative.
  void fetch("/api/site/chat-status", { cache: "no-store" }).then(async response => {
    if (!response.ok || !(await response.json()).enabled) return;
    const { ChatLauncher } = await import("./chat/ChatLauncher");
    const mount = document.createElement("div");
    document.body.append(mount);
    createRoot(mount).render(<StrictMode><ChatLauncher t={t} lang={lang} /></StrictMode>);
    chatAvailable = true;
  }).catch(() => { /* Existing course and WhatsApp links remain usable. */ });

  bindLangSwitch();
  bindMobileMenu();
  bindChatButtons();
  const trial = document.getElementById("free-lesson-island");
  if (trial) createRoot(trial).render(<FreeLesson lang={lang} />);

  const courses = document.getElementById("courses-island");
  // Server-rendered catalogue links work without React. Do not replace them
  // with a loading skeleton or an older cached browser response.
  if (courses && !courses.querySelector('[data-server-catalog="ready"]')) {
    const only = courses.dataset.course || undefined;
    courses.replaceChildren();
    createRoot(courses).render(
      <StrictMode>
        <CoursesIsland t={t} only={only} />
      </StrictMode>,
    );
  }

  const offline = document.getElementById("offline-form-island");
  if (offline) {
    const priceFallback = Number(offline.dataset.price) || 700;
    offline.replaceChildren();
    createRoot(offline).render(
      <StrictMode>
        <OfflineForm t={t} lang={lang} priceFallback={priceFallback} />
      </StrictMode>,
    );
  }

  // When the shared assistant is paused, keep the course-selection fallback.
  function bindChatButtons() {
    document.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-chat]");
      if (!target) return;
      e.preventDefault();
      if (chatAvailable) { openChat(target.dataset.prefill); return; }
      const courseSection = document.getElementById("courses-island");
      if (courseSection) {
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        courseSection.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        courseSection.setAttribute("tabindex", "-1");
        courseSection.focus({ preventScroll: true });
      } else {
        location.href = `${lang === "tg" ? "/tg" : ""}/online-kurs#kupit`;
      }
    });
  }
}

function bindMobileMenu() {
  const btn = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
  const nav = document.getElementById("mobile-nav");
  if (!btn || !nav) return;
  btn.addEventListener("click", () => {
    const open = nav.dataset.open !== "true";
    nav.dataset.open = String(open);
    btn.setAttribute("aria-expanded", String(open));
  });
  nav.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) {
      nav.dataset.open = "false";
      btn.setAttribute("aria-expanded", "false");
    }
  });
}
