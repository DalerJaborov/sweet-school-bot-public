import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./site.css";
import { dict } from "./i18n";
import { bindLangSwitch, pageLang, syncLangOnEntry } from "./lang";
import { openChat } from "./chat/bus";
import { ChatLauncher } from "./chat/ChatLauncher";
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

  const chatRoot = document.createElement("div");
  chatRoot.id = "chat-root";
  document.body.appendChild(chatRoot);
  createRoot(chatRoot).render(
    <StrictMode>
      <ChatLauncher t={t} lang={lang} />
    </StrictMode>,
  );

  /** Кнопки «Купить онлайн-курс» в статичной разметке: data-chat="prefill text". */
  function bindChatButtons() {
    document.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-chat]");
      if (!target) return;
      e.preventDefault();
      openChat(target.dataset.chat || t.chatPrefillDefault);
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
