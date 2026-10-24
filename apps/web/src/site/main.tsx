import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./site.css";
import { dict } from "./i18n";
import { bindLangSwitch, pageLang, syncLangOnEntry } from "./lang";
import { CoursesIsland } from "./CoursesIsland";
import { OfflineForm } from "./OfflineForm";

/**
 * Точка входа сайта. Страницы — статичный HTML (scripts/build-site-pages.mjs),
 * React оживляет только «островки»: карточки курсов из API, форму записи и
 * чат. Всё остальное — разметка и CSS, чтобы главная открывалась мгновенно
 * и на 2G, и в поиске была с текстом.
 */

if (!syncLangOnEntry()) {
  const lang = pageLang();
  const t = dict(lang);

  bindLangSwitch();
  bindMobileMenu();
  bindChatButtons();

  const courses = document.getElementById("courses-island");
  if (courses) {
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

  // Продажи ведёт человек: старые CTA ведут к выбору курса, без запуска бота.
  function bindChatButtons() {
    document.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-chat]");
      if (!target) return;
      e.preventDefault();
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
