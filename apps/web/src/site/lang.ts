/**
 * Язык сайта. Каждая страница статична и уже на своём языке (<html lang>,
 * /tg/… — таджикские зеркала), поэтому «переключить язык» = перейти на
 * зеркало. Здесь только память выбора: ssb_site_lang в localStorage, и
 * мягкий перевод на выбранный язык, когда человек пришёл извне (из поиска,
 * из рекламы) на страницу не своего языка. Внутри сайта — не дёргаем:
 * переход по ссылке шапки уже означает выбор.
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

function cameFromThisSite(): boolean {
  const ref = document.referrer;
  if (!ref) return false;
  try {
    return new URL(ref).origin === location.origin;
  } catch {
    return false;
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
  const current = pageLang();
  const wanted = storedLang();
  // Запоминаем язык ТОЛЬКО по клику переключателя (bindLangSwitch) — не по
  // первой открытой странице. Раньше первый визит на русский корень навсегда
  // помечался как «предпочтение», и прямая ссылка на /tg/… из поиска или от
  // подруги молча возвращала на русский (найдено дизайн-ревизией 04.09.2026).
  if (!wanted || wanted === current || cameFromThisSite()) return false;
  const href = alternateHref(wanted);
  if (!href) return false;
  location.replace(href);
  return true;
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
