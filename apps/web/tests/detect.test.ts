import { describe, it, expect } from "vitest";
import { detectBrowser, detectInApp, detectPlatform, environment, escapeUrl } from "../src/course/install/detect";

const UA = {
  instagramIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 Instagram 325.0.0.0.0",
  instagramAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-A525F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 325.0.0.0.0",
  telegramCustomTab:
    "Mozilla/5.0 (Linux; Android 13; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Telegram-Android/10.9.1",
  telegramWebView:
    "Mozilla/5.0 (Linux; Android 13; SM-A525F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Telegram-Android/10.9.1",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  facebookIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 [FBAN/FBIOS;FBAV/450.0.0;FBBV/1;FBDV/iPhone14,2]",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

function fakeWindow(standaloneMedia: boolean, iosStandalone = false): Window {
  return {
    matchMedia: (q: string) => ({ matches: q.includes("standalone") && standaloneMedia }),
    navigator: { maxTouchPoints: 0, standalone: iosStandalone },
  } as unknown as Window;
}

/**
 * Таблица UA (дизайн доступа 03.09.2026): ошибка в любую сторону дорога.
 * Не распознали Instagram — ученица «вошла» во встроенном браузере и заняла
 * место в лимите телефоном, с которого нельзя смотреть. Приняли Chrome Custom
 * Tab из Telegram за встроенный — прогнали человека из работающего браузера.
 */
describe("environment(): где мы открыты", () => {
  it.each([
    ["Instagram iOS", UA.instagramIos, "ios", true],
    ["Instagram Android (wv)", UA.instagramAndroid, "android", true],
    ["Facebook iOS (FBAN)", UA.facebookIos, "ios", true],
    ["Telegram Android — Chrome Custom Tab, НЕ встроенный", UA.telegramCustomTab, "android", false],
    ["Telegram Android — WebView (wv)", UA.telegramWebView, "android", true],
    ["Safari iOS", UA.safari, "ios", false],
    ["Chrome Android", UA.chromeAndroid, "android", false],
    ["Chrome на компьютере", UA.desktopChrome, "other", false],
  ])("%s", (_name, ua, platform, inApp) => {
    expect(detectPlatform(ua)).toBe(platform);
    expect(detectInApp(ua)).toBe(inApp);
    const env = environment(ua, fakeWindow(false));
    expect(env.platform).toBe(platform);
    expect(env.inApp).toBe(inApp);
    expect(env.standalone).toBe(false);
  });

  it("браузер: Safari отличаем от Chrome, встроенный — всегда other", () => {
    expect(detectBrowser(UA.safari)).toBe("safari");
    expect(detectBrowser(UA.chromeAndroid)).toBe("chrome");
    expect(environment(UA.instagramIos, fakeWindow(false)).browser).toBe("other");
  });

  it("standalone: по display-mode (Android) и по navigator.standalone (iOS)", () => {
    expect(environment(UA.chromeAndroid, fakeWindow(true)).standalone).toBe(true);
    expect(environment(UA.safari, fakeWindow(false, true)).standalone).toBe(true);
  });

  it("iPad притворяется Mac — узнаём по сенсорному экрану", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 0)).toBe("other");
  });
});

describe("escapeUrl(): адрес выхода в настоящий браузер", () => {
  const loc = {
    host: "school.tj",
    pathname: "/course",
    search: "?token=abc",
    href: "https://school.tj/course?token=abc",
  };

  it("iOS — схема x-safari-https с тем же путём и токеном", () => {
    expect(escapeUrl("ios", loc)).toBe("x-safari-https://school.tj/course?token=abc");
  });

  it("Android — intent:// c запасным https-адресом", () => {
    expect(escapeUrl("android", loc)).toBe(
      "intent://school.tj/course?token=abc#Intent;scheme=https;S.browser_fallback_url=https%3A%2F%2Fschool.tj%2Fcourse%3Ftoken%3Dabc;end",
    );
  });

  it("на компьютере выводить некуда", () => {
    expect(escapeUrl("other", loc)).toBeNull();
  });
});
