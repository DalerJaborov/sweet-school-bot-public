/**
 * Язык сайта. Каждая страница статична и уже на своём языке (<html lang>,
 * /tg/… — таджикские зеркала), поэтому «переключить язык» = перейти на
 * зеркало. Выбор запоминается при нажатии переключателя. Язык ссылки
 * всегда сохраняется, в том числе при переходе из поиска и закладок.
 */

import { LANG_STORAGE_KEY, isLang, type Lang } from "./i18n";

export function pageLang(): Lang {
  const l = document.documentElement.lang;
  return isLang(l) ? l : "ru";
}

export function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* приватный режим — просто не запомним */
  }
}

/** Ссылка на ту же страницу на другом языке — из <link rel="alternate" hreflang>. */
export function alternateHref(lang: Lang): string | null {
  const link = document.querySelector<HTMLLinkElement>(`link[rel="alternate"][hreflang="${lang}"]`);
  return link?.href ?? null;
}

/**
 * Вызывается один раз при загрузке. Возвращает true, если начат переход на
 * другой язык (дальше страницу можно не оживлять).
 */
export function syncLangOnEntry(): boolean {
  // The URL is an explicit language choice, including links from search,
  // bookmarks and shared messages. Stored preferences must not override it.
  return false;
}

/** Клик по переключателю в шапке: запоминаем язык, переход делает сама ссылка. */
export function bindLangSwitch(root: ParentNode = document): void {
  root.querySelectorAll<HTMLAnchorElement>("a[data-lang]").forEach((a) => {
    a.addEventListener("click", () => {
      const l = a.dataset.lang;
      if (isLang(l)) rememberLang(l);
    });
  });
}
