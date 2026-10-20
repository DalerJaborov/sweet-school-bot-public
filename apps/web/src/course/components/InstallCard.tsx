import { useEffect, useState } from "react";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import type { Dict } from "../i18n";
import { environment, type Environment } from "../install/detect";
import { dismissInstall, loadInstallDismiss, wasLessonOpened } from "../offline";

/** Повторяем подсказку не раньше чем через неделю и не больше трёх раз. */
const RESHOW_AFTER_MS = 7 * 86_400_000;
const MAX_DISMISSALS = 3;

/**
 * КАРТОЧКА «ДОБАВЬТЕ НА ЭКРАН ДОМОЙ» (дизайн 03.09.2026).
 *
 * Когда показываем: после первого открытого урока (человек уже понял, что
 * тут есть ради чего возвращаться), в настоящем браузере, не из установленного
 * приложения. Android — кнопка зовёт системный диалог; iOS Safari диалога
 * нет, показываем три шага с иконкой «Поделиться». Отклонили — молчим неделю,
 * после трёх отказов — навсегда: навязчивая подсказка хуже её отсутствия.
 */
export function InstallCard({
  t,
  env = environment(),
  now = Date.now(),
}: {
  t: Dict;
  env?: Environment;
  now?: number;
}) {
  const { canPrompt, installed, install } = useInstallPrompt();
  const [allowed, setAllowed] = useState(false);
  const [steps, setSteps] = useState(false);

  const isAndroid = env.platform === "android" && canPrompt;
  const isIosSafari = env.platform === "ios" && env.browser === "safari";
  const eligibleEnv = !env.standalone && !env.inApp && !installed && (isAndroid || isIosSafari);

  useEffect(() => {
    if (!eligibleEnv) return;
    let cancelled = false;
    void (async () => {
      const opened = await wasLessonOpened().catch(() => false);
      if (!opened) return;
      const dismissed = await loadInstallDismiss().catch(() => undefined);
      const ok = !dismissed || (dismissed.count < MAX_DISMISSALS && now - dismissed.at >= RESHOW_AFTER_MS);
      if (!cancelled && ok) setAllowed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [eligibleEnv, now]);

  if (!eligibleEnv || !allowed) return null;

  const dismiss = () => {
    setAllowed(false);
    void dismissInstall(now).catch(() => undefined);
  };

  const onInstall = async () => {
    const outcome = await install();
    if (outcome === "accepted") setAllowed(false);
    else if (outcome === "dismissed") dismiss();
  };

  return (
    <section className="install-card" aria-labelledby="install-h">
      <div className="install-head">
        <span className="install-icon" aria-hidden="true">
          <HomeScreenGlyph />
        </span>
        <div>
          <h2 id="install-h">{t.installTitle}</h2>
          <p className="muted">{t.installText}</p>
        </div>
      </div>
      {isAndroid ? (
        <button type="button" className="btn btn-big" onClick={() => void onInstall()}>
          {t.installButton}
        </button>
      ) : steps ? (
        <ol className="install-steps">
          <li>
            <span className="install-step-icon" aria-hidden="true">
              <ShareGlyph />
            </span>
            {t.installStep1}
          </li>
          <li>
            <span className="install-step-icon" aria-hidden="true">
              <PlusSquareGlyph />
            </span>
            {t.installStep2}
          </li>
          <li>
            <span className="install-step-icon" aria-hidden="true">
              <CheckGlyph />
            </span>
            {t.installStep3}
          </li>
        </ol>
      ) : (
        <button type="button" className="btn btn-big" onClick={() => setSteps(true)}>
          {t.installShowSteps}
        </button>
      )}
      <button type="button" className="btn ghost" onClick={dismiss}>
        {t.notNow}
      </button>
    </section>
  );
}

const glyph = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
  focusable: "false" as const,
};

/** Квадрат со стрелкой вверх — так iOS рисует «Поделиться». */
function ShareGlyph() {
  return (
    <svg {...glyph}>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
    </svg>
  );
}

function PlusSquareGlyph() {
  return (
    <svg {...glyph}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg {...glyph}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function HomeScreenGlyph() {
  return (
    <svg {...glyph} width={26} height={26}>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <rect x="9" y="7" width="6" height="6" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
