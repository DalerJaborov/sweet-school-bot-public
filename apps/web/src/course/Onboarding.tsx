import { useState } from "react";
import { saveProfile } from "./api";
import { LANGUAGES, applyLang, dict, type Lang } from "./i18n";
import { Illustration } from "./components/Illustration";

/**
 * ЗНАКОМСТВО ПЕРЕД ВХОДОМ — два коротких шага, оба обязательны по решению
 * владельца (03.09.2026): сначала язык, потом имя и фамилия.
 *
 * Язык первым не ради красоты: подпись «Как вас зовут?» человек должен читать
 * уже на своём языке, иначе первый экран школы встречает его чужой речью.
 * Поэтому список языков подписан САМОНАЗВАНИЯМИ — «Тоҷикӣ» и «Русский»
 * понятны без перевода, и ошибиться на этом шаге невозможно. Заголовок этого
 * экрана — на обоих языках сразу, из обоих словарей.
 *
 * Фамилия не обязательна: у части учениц её попросту не спрашивают в жизни, и
 * упереться в неё на входе значит потерять человека на пустом месте. Имя —
 * обязательно: оно идёт в водяной знак поверх видео и служит вторым признаком
 * при восстановлении доступа с другого аккаунта.
 */

export function Onboarding({ onDone }: { onDone: (lang: Lang) => void }) {
  const [lang, setLang] = useState<Lang | null>(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // До выбора языка подписи показываем по-русски: это язык, на котором написан
  // весь исходный текст школы. Гадать по стране входа не станем — в Душанбе
  // русскоязычных не меньше.
  const t = dict(lang ?? "ru");

  const choose = (next: Lang) => {
    applyLang(next);
    setLang(next);
  };

  if (!lang) {
    return (
      <div className="center onboarding">
        <Illustration kind="splash" />
        <h1 lang="tg">{dict("tg").chooseLanguage}</h1>
        <p className="sub" lang="ru">
          {dict("ru").chooseLanguage}
        </p>
        <div className="lang-grid">
          {LANGUAGES.map((l) => (
            <button key={l.code} type="button" className="btn" lang={l.code} onClick={() => choose(l.code)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const submit = async () => {
    const firstName = first.trim();
    if (!firstName) {
      setError(t.nameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveProfile({ firstName, lastName: last.trim(), language: lang });
      onDone(lang);
    } catch {
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center onboarding">
      <h1>{t.yourName}</h1>
      <p className="sub">{t.nameHint}</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>{t.firstName}</span>
          <input
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            autoComplete="given-name"
            maxLength={60}
            autoFocus
          />
        </label>
        <label>
          <span>{t.lastName}</span>
          <input value={last} onChange={(e) => setLast(e.target.value)} autoComplete="family-name" maxLength={60} />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {t.enter}
        </button>
        {/* Ошиблась языком — вернуться можно, не перезагружая страницу. */}
        <button className="btn ghost" type="button" onClick={() => setLang(null)} disabled={busy}>
          {t.changeLanguage}
        </button>
      </form>
    </div>
  );
}
