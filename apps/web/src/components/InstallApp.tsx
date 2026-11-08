import { useState } from "react";
import { Icons } from "./Brand";
import { isInsideTelegram } from "../telegram";
import { detectPlatform, isStandalone, promptInstall, useCanPromptInstall, type InstallPlatform } from "../panel/pwa";

/**
 * «УСТАНОВИТЬ НА ТЕЛЕФОН» — панель как обычное приложение на главном экране.
 *
 * Android и компьютер: браузер сам даёт окно установки — жмём кнопку.
 * iPhone так не умеет, там три шага руками, поэтому показываем их словами.
 * Если панель уже установлена или открыта внутри Telegram — блока нет.
 */
export function InstallApp() {
  const canPrompt = useCanPromptInstall();
  const [help, setHelp] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (isInsideTelegram() || isStandalone()) return null;
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);

  async function onInstall() {
    if (canPrompt) {
      const outcome = await promptInstall();
      setNote(outcome === "accepted" ? "Готово — значок появится на главном экране." : null);
      return;
    }
    setHelp((v) => !v);
  }

  return (
    <div className="install" data-testid="install-app">
      <button
        type="button"
        className="btn wide"
        onClick={() => void onInstall()}
        aria-expanded={canPrompt ? undefined : help}
      >
        <span className="btn-icon">{Icons.download}</span>
        Установить на телефон
      </button>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {help && !canPrompt && <InstallSteps platform={platform} />}
      {!help && !canPrompt && (
        <p className="hint">Панель откроется как приложение — без адресной строки, одним нажатием.</p>
      )}
    </div>
  );
}

export function InstallSteps({ platform }: { platform: InstallPlatform }) {
  if (platform === "ios") {
    return (
      <ol className="install-steps" aria-label="Как установить на iPhone">
        <li>Откройте эту страницу в Safari (не в Telegram и не в Instagram).</li>
        <li>Внизу нажмите «Поделиться» — квадрат со стрелкой вверх.</li>
        <li>Прокрутите список и выберите «На экран “Домой”».</li>
        <li>Нажмите «Добавить» — значок появится среди ваших приложений.</li>
      </ol>
    );
  }
  if (platform === "android") {
    return (
      <ol className="install-steps" aria-label="Как установить на Android">
        <li>Откройте эту страницу в Chrome.</li>
        <li>Нажмите три точки в правом верхнем углу.</li>
        <li>Выберите «Установить приложение» (или «Добавить на главный экран»).</li>
        <li>Подтвердите — значок появится среди ваших приложений.</li>
      </ol>
    );
  }
  return (
    <ol className="install-steps" aria-label="Как установить на компьютер">
      <li>Откройте панель в Chrome или Edge.</li>
      <li>Справа в адресной строке нажмите значок установки (экран со стрелкой).</li>
      <li>Нажмите «Установить» — панель откроется в отдельном окне.</li>
    </ol>
  );
}
