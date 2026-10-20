/**
 * ГДЕ МЫ ОТКРЫТЫ: платформа, встроенный браузер, режим «с экрана Домой».
 *
 * Зачем это знать (дизайн доступа 03.09.2026): ссылка из директа Instagram
 * открывается во ВСТРОЕННОМ браузере приложения. Там нет установки на экран
 * «Домой», хранилище живёт до закрытия окна, а куки — отдельные от Safari и
 * Chrome. Ученица, «вошедшая» там, назавтра открыла бы обычный браузер и
 * получила бы «нет сессии» — и, хуже того, заняла бы второе место в лимите
 * устройств тем же самым телефоном. Поэтому до входа мы её оттуда выводим
 * (screens/EscapeInAppScreen), а подсказку об установке показываем только в
 * настоящем браузере и только пока приложение ещё не установлено.
 */

export type Platform = "ios" | "android" | "other";
export type Browser = "safari" | "chrome" | "firefox" | "other";

export type Environment = {
  platform: Platform;
  /** Открыто с экрана «Домой» (PWA), а не как вкладка. */
  standalone: boolean;
  /** Встроенный браузер Instagram/Facebook/Line/Telegram или голый WebView. */
  inApp: boolean;
  browser: Browser;
};

type NavigatorWithStandalone = Navigator & { standalone?: boolean };

/**
 * Что считаем встроенным браузером.
 *
 *  - Instagram, FBAN/FBAV/FB_IAB (Facebook, Messenger), Line/ — называют себя
 *    в UA прямо.
 *  - «; wv)» — Android WebView как таковой: так помечен встроенный браузер
 *    Telegram (и любого другого приложения без своего токена).
 *
 * Telegram на Android чаще открывает ссылки в Chrome Custom Tab — это
 * настоящий Chrome с общими куками и установкой, его UA содержит «Telegram»,
 * но не содержит «wv». Такой случай НЕ считаем встроенным: выводить оттуда
 * некуда, всё и так работает.
 */
const IN_APP_TOKENS = /Instagram|FBAN|FBAV|FB_IAB|Line\//i;
const ANDROID_WEBVIEW = /;\s*wv\)/;

export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS притворяется Mac — выдаёт только сенсорный экран.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

export function detectBrowser(ua: string): Browser {
  if (/CriOS|Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return "chrome";
  if (/FxiOS|Firefox\//i.test(ua)) return "firefox";
  if (/Safari\//i.test(ua) && !/Chrome|CriOS|Android/i.test(ua)) return "safari";
  return "other";
}

export function detectInApp(ua: string): boolean {
  return IN_APP_TOKENS.test(ua) || ANDROID_WEBVIEW.test(ua);
}

export function detectStandalone(win: Window = window): boolean {
  try {
    if (typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // Старые движки без matchMedia — смотрим на iOS-флаг ниже.
  }
  return (win.navigator as NavigatorWithStandalone).standalone === true;
}

export function environment(ua: string = navigator.userAgent, win: Window = window): Environment {
  const inApp = detectInApp(ua);
  return {
    platform: detectPlatform(ua, win.navigator.maxTouchPoints ?? 0),
    standalone: detectStandalone(win),
    inApp,
    // Встроенный браузер — не Safari и не Chrome, даже если UA похож.
    browser: inApp ? "other" : detectBrowser(ua),
  };
}

/**
 * Адрес, который выводит из встроенного браузера в настоящий.
 *
 *  - iOS: схема `x-safari-https://` открывает Safari напрямую (iOS 17+); на
 *    старых версиях просто не срабатывает — экран тогда покажет ручные шаги.
 *  - Android: intent:// с `S.browser_fallback_url` — система открывает
 *    браузер по умолчанию, а если intent не понят, идёт по обычной ссылке.
 *
 * Оба варианта работают только по касанию пользователя — поэтому это кнопка,
 * а не автопереход при загрузке.
 */
export function escapeUrl(
  platform: Platform,
  loc: Pick<Location, "host" | "pathname" | "search" | "href">,
): string | null {
  const rest = `${loc.host}${loc.pathname}${loc.search}`;
  if (platform === "ios") return `x-safari-https://${rest}`;
  if (platform === "android") {
    return `intent://${rest}#Intent;scheme=https;S.browser_fallback_url=${encodeURIComponent(loc.href)};end`;
  }
  return null;
}
