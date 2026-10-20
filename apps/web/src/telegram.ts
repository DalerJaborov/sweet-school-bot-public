import { useEffect } from "react";
import { api, setToken } from "./api";

/**
 * Вход в панель, когда она открыта ВНУТРИ Telegram (мини-приложение).
 *
 * Telegram кладёт в страницу объект `window.Telegram.WebApp` с подписанной
 * строкой `initData`. Мы отдаём её серверу, тот проверяет подпись ключом бота и
 * возвращает обычный токен панели — дальше всё работает ровно как на сайте, теми
 * же запросами. Пароль не нужен: кто ты, подтверждает сам Telegram.
 *
 * Открыто в обычном браузере — объекта нет, и остаётся привычный вход паролем.
 *
 * ЗДЕСЬ ЖЕ — «родные» кнопки мини-приложения (MainButton, BackButton, expand).
 * Всё через проверку наличия: в браузере объекта нет, и панель обязана
 * работать ровно так же, просто без них. Ничего из этого не требуется.
 */

type TelegramButton = {
  show: () => void;
  hide: () => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
  setText?: (text: string) => void;
  setParams?: (params: { text?: string; is_active?: boolean; is_visible?: boolean }) => void;
  showProgress?: (leaveActive?: boolean) => void;
  hideProgress?: () => void;
  enable?: () => void;
  disable?: () => void;
};

type TelegramWebApp = {
  initData?: string;
  ready: () => void;
  expand: () => void;
  isVersionAtLeast?: (version: string) => boolean;
  requestFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  MainButton?: TelegramButton;
  BackButton?: TelegramButton;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
    selectionChanged?: () => void;
  };
};

function webApp(): TelegramWebApp | null {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null;
}

export function isInsideTelegram(): boolean {
  return Boolean(webApp()?.initData);
}

/** Есть ли вообще объект мини-приложения (для UI: показывать ✕ или полагаться
 *  на кнопку «Назад» в шапке Telegram). */
export function hasTelegramWebApp(): boolean {
  return webApp() !== null;
}

/**
 * Красим рамку самого окна Telegram (шапку и фон) в крем панели. ПАНЕЛЬ ВСЕГДА
 * СВЕТЛАЯ — решение владельца: раньше тема бралась из системы и Telegram, и на
 * его телефоне панель открывалась чёрной; теперь тёмной темы у панели нет
 * вовсе, а мессенджеру говорим наш цвет, иначе сверху и снизу остаются
 * полосы чужого оттенка.
 */
export function applyTelegramChrome(): void {
  const tg = webApp();
  if (!tg) return;
  // Именно наш токен, а не themeParams: тема панели одна и светлая, а
  // themeParams у половины пользователей тёмные — окно бы пришло в разнобой.
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) {
    try {
      tg.setHeaderColor?.(bg);
      tg.setBackgroundColor?.(bg);
    } catch {
      // Старый клиент без этих методов — цвет рамки остаётся его собственным.
    }
  }
  prepareTelegramViewport();
}

/**
 * ОКНО МИНИ-ПРИЛОЖЕНИЯ ВО ВЕСЬ ЭКРАН («Утро Ширин» §20). expand() растягивает
 * до полной высоты в любом клиенте; с Bot API 8.0 есть настоящий полный
 * экран — просим его. Вертикальный свайп-закрытие выключаем: свайп по чеку
 * (подтвердить/отклонить) начинается тем же жестом, и без этого панель
 * схлопывалась посреди движения пальца. Идемпотентно — можно звать дважды.
 */
export function prepareTelegramViewport(): void {
  const tg = webApp();
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    if (tg.isVersionAtLeast?.("8.0")) tg.requestFullscreen?.();
  } catch {
    // Клиент старее, чем метод, — работаем в том окне, какое дали.
  }
}

export type HapticKind = "light" | "medium" | "rigid" | "success" | "warning" | "error" | "selection";

/**
 * ОТДАЧА В ПАЛЕЦ: impact — на жест (свайп, отмена), notification — на исход
 * (ссылка ушла / отказ), selection — на выбор из списка. Вне Telegram и в
 * клиенте без HapticFeedback — молча ничего; ошибка клиента не должна ронять
 * действие, ради которого вибрируем.
 */
export function haptic(kind: HapticKind = "light"): void {
  const h = webApp()?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "light" || kind === "medium" || kind === "rigid") h.impactOccurred?.(kind);
    else if (kind === "selection") h.selectionChanged?.();
    else h.notificationOccurred?.(kind);
  } catch {
    // см. выше
  }
}

/**
 * «ТОЧНО ЗАКРЫТЬ?» ОТ САМОГО TELEGRAM, пока в форме есть несохранённое.
 * beforeunload мини-приложение не показывает, поэтому браузерная защита
 * (useUnsavedGuard) внутри мессенджера не работала — свайп вниз по шапке
 * закрывал панель вместе с набранным рецептом. Ставить рядом с useUnsavedGuard.
 */
export function useTelegramClosingGuard(dirty: boolean): void {
  useEffect(() => {
    const tg = webApp();
    if (!tg?.enableClosingConfirmation || !tg.disableClosingConfirmation) return;
    if (!dirty) return;
    try {
      tg.enableClosingConfirmation();
    } catch {
      return;
    }
    return () => {
      try {
        tg.disableClosingConfirmation?.();
      } catch {
        // клиент уже закрывается — неважно
      }
    };
  }, [dirty]);
}

/**
 * Пробует войти. Возвращает true, если токен получен. Ошибку не бросает: если
 * аккаунт не имеет доступа, панель просто покажет обычную форму входа.
 */
export async function loginViaTelegram(): Promise<boolean> {
  const tg = webApp();
  if (!tg?.initData) return false;

  // Растягиваем окно на всю высоту — иначе мини-приложение открывается узкой
  // полосой снизу и таблицами пользоваться невозможно.
  prepareTelegramViewport();

  try {
    const { token } = await api<{ token: string }>("/admin/telegram-login", {
      method: "POST",
      body: { initData: tg.initData },
      noAuth: true,
    });
    setToken(token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Кнопка «Назад» Telegram вместо крестика: пока `active`, стрелка в шапке
 * мессенджера закрывает лист/окно. Вне Telegram — ничего не делает.
 */
export function useTelegramBackButton(active: boolean, onBack: () => void): void {
  useEffect(() => {
    const button = webApp()?.BackButton;
    if (!active || !button) return;
    button.onClick(onBack);
    button.show();
    return () => {
      button.offClick(onBack);
      button.hide();
    };
  }, [active, onBack]);
}

/**
 * Главная кнопка Telegram для главного действия экрана («Отправить»,
 * «Сохранить»). Показывается, пока `visible`; `disabled` гасит её, но не
 * прячет — человек видит, что действие есть, но пока нельзя.
 */
export function useTelegramMainButton(opts: { text: string; visible: boolean; disabled?: boolean; onClick: () => void }): void {
  const { text, visible, disabled = false, onClick } = opts;
  useEffect(() => {
    const button = webApp()?.MainButton;
    if (!visible || !button) return;
    button.setParams?.({ text, is_visible: true, is_active: !disabled });
    if (!button.setParams) button.setText?.(text);
    if (disabled) button.disable?.();
    else button.enable?.();
    button.onClick(onClick);
    button.show();
    return () => {
      button.offClick(onClick);
      button.hide();
    };
  }, [text, visible, disabled, onClick]);
}
