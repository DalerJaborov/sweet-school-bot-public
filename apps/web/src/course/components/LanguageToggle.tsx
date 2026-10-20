import { LANGUAGES, type Dict, type Lang } from "../i18n";

/**
 * Смена языка на виду, а не в настройках: настроек в приложении нет вовсе, и
 * человек, промахнувшийся на входе, должен исправиться сам. Пилюли по 48px —
 * это первое, что нажимают пальцем в муке.
 */
export function LanguageToggle({ t, lang, onChange }: { t: Dict; lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="lang-switch" role="group" aria-label={t.languageLabel}>
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          className={l.code === lang ? "lang-pill on" : "lang-pill"}
          onClick={() => onChange(l.code)}
          aria-pressed={l.code === lang}
          lang={l.code}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
