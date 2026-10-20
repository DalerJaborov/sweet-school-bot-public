import { useCallback, useEffect, useRef, useState } from "react";
import type { Environment } from "../install/detect";
import { escapeUrl } from "../install/detect";
import type { Dict } from "../i18n";

/** Через сколько считаем, что переход в браузер не сработал. */
const ESCAPE_TIMEOUT_MS = 1500;

/**
 * «ОТКРОЙТЕ В БРАУЗЕРЕ» — экран перед входом во встроенном браузере
 * (дизайн доступа 03.09.2026, см. install/detect.ts почему).
 *
 * Токен в адресе НЕ трогаем и /open НЕ зовём: адрес уносится в Safari/Chrome
 * целиком, вход произойдёт там. Кнопка пробует открыть браузер схемой
 * (x-safari-https:// или intent://); если через полторы секунды мы всё ещё
 * на экране — схема не сработала, показываем ручные шаги и «Скопировать».
 */
export function EscapeInAppScreen({
  t,
  env,
  navigate = (url) => {
    window.location.href = url;
  },
}: {
  t: Dict;
  env: Environment;
  /** Подменяется в тестах: jsdom не умеет переходить по чужим схемам. */
  navigate?: (url: string) => void;
}) {
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const revealManual = useCallback(() => {
    // Ушли в браузер — страница скрылась; остались — показываем шаги.
    if (document.visibilityState === "visible") setManual(true);
  }, []);

  const open = useCallback(() => {
    const url = escapeUrl(env.platform, window.location);
    if (!url) {
      setManual(true);
      return;
    }
    navigate(url);
    timer.current = window.setTimeout(revealManual, ESCAPE_TIMEOUT_MS);
  }, [env.platform, navigate, revealManual]);

  const copy = useCallback(async () => {
    const ok = await copyText(window.location.href);
    setCopied(ok);
  }, []);

  const button =
    env.platform === "ios"
      ? t.escapeButtonIos
      : env.platform === "android"
        ? t.escapeButtonAndroid
        : t.escapeButtonOther;
  const manualText =
    env.platform === "ios"
      ? t.escapeManualIos
      : env.platform === "android"
        ? t.escapeManualAndroid
        : t.escapeManualOther;

  return (
    <div className="center escape">
      <EscapeIllustration />
      <h1>{t.escapeTitle}</h1>
      <p>{t.escapeText}</p>
      <button type="button" className="btn btn-big" onClick={open}>
        {button}
      </button>
      {manual && (
        <div className="escape-manual" role="status">
          <p>{manualText}</p>
          <button type="button" className="btn ghost btn-big" onClick={() => void copy()}>
            {copied ? t.copied : t.copyLink}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Копирование: Clipboard API, а без него (встроенные браузеры без HTTPS-
 * доверия, старые WebView) — скрытое поле + execCommand. Возвращает, вышло ли.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Падает без разрешения — идём запасным путём.
  }
  const input = document.createElement("input");
  input.value = text;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  input.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  input.remove();
  return ok;
}

/** Окошко приложения со стрелкой наружу — «выйти в браузер». */
function EscapeIllustration() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true" focusable="false" className="illus">
      <rect x="14" y="20" width="52" height="60" rx="10" className="illus-fill" />
      <rect x="22" y="30" width="36" height="6" rx="3" className="illus-accent" opacity="0.5" />
      <rect x="22" y="42" width="24" height="6" rx="3" className="illus-accent" opacity="0.5" />
      <path
        d="M50 60h28M70 50l10 10-10 10"
        fill="none"
        className="illus-stroke"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
