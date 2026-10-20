import { useEffect, useState } from "react";
import { certificatePngUrl, certificateUrl, requestCertificate, type CourseCertificate, type CourseProfile } from "../api";
import { LANGUAGES, type Dict, type Lang } from "../i18n";
import { shareOrOpenImage } from "../shareImage";

/**
 * СЕРТИФИКАТ — карточка над списком уроков, когда курс пройден целиком.
 *
 * Имя печатается так, как впишет ученица, а не как в профиле: в профиль
 * часто заносят уменьшительное («Мадина» вместо «Мадинахон»), а в документе
 * хотят полное. Поэтому поля предзаполнены, но правятся. Язык сертификата —
 * отдельный выбор, не язык интерфейса: русскую версию нередко просят для
 * работодателя.
 *
 * После выписки показываем номер и дату; «Исправить имя» возвращает форму —
 * бэкенд перевыпишет с тем же номером. PDF открывается новой вкладкой:
 * Content-Disposition: attachment, кука уходит сама (same-origin).
 *
 * Состояние выписки живёт здесь, а не в /me: перечитывать весь курс ради
 * номера сертификата незачем; при следующем /me оно совпадёт с сервером.
 */
export function CertificateCard({
  t,
  lang,
  courseId,
  certificate,
  profile,
}: {
  t: Dict;
  lang: Lang;
  courseId: string;
  certificate: CourseCertificate;
  profile?: CourseProfile;
}) {
  const [issued, setIssued] = useState(() => issuedFrom(certificate));
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(() => splitName(certificate.fullName)?.first ?? profile?.firstName ?? "");
  const [last, setLast] = useState(() => splitName(certificate.fullName)?.last ?? profile?.lastName ?? "");
  const [certLang, setCertLang] = useState<Lang>(certificate.lang ?? lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharingPng, setSharingPng] = useState(false);

  // /me перечитан (смена языка, возврат сети) — подтягиваем свежие данные о
  // выписке. Имя в полях не трогаем: человек мог начать его править.
  useEffect(() => {
    setIssued(issuedFrom(certificate));
  }, [certificate]);

  if (!certificate.eligible) return null;

  const open = (l: Lang) => window.open(certificateUrl(courseId, l), "_blank", "noopener");

  // PNG под ленту Instagram (§6 визуальной системы) — второй, «шаринговый»
  // формат РЯДОМ с PDF, а не вместо него: та же запись, тот же номер, другой
  // файл. shareOrOpenImage сама решает — системный лист «Поделиться» или,
  // если Web Share с файлами не поддержан, честно открыть картинку вкладкой.
  const sharePng = async (l: Lang) => {
    if (sharingPng) return;
    setSharingPng(true);
    try {
      await shareOrOpenImage(certificatePngUrl(courseId, l), `certificate-${l}.png`, {
        title: t.certificate,
        text: t.certificateReady,
      });
    } finally {
      setSharingPng(false);
    }
  };

  const submit = async () => {
    const firstName = first.trim();
    if (!firstName) {
      setError(t.nameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await requestCertificate({ courseId, firstName, lastName: last.trim(), lang: certLang });
      setIssued({ number: res.number, issuedAt: res.issuedAt, lang: res.lang });
      setEditing(false);
      open(res.lang);
    } catch {
      setError(t.certificateFailed);
    } finally {
      setBusy(false);
    }
  };

  const showForm = !issued || editing;

  return (
    <section className="cert-card" aria-labelledby={`cert-h-${courseId}`}>
      <div className="cert-head">
        <span className="cert-badge" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M8.5 14.5 7 22l5-3 5 3-1.5-7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <h2 id={`cert-h-${courseId}`} className="cert-title">
            {t.certificateReady}
          </h2>
          {issued && !editing && (
            <p className="cert-issued">{t.certificateNumber(issued.number, formatDate(issued.issuedAt, lang))}</p>
          )}
        </div>
      </div>

      {showForm ? (
        <form
          className="cert-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="cert-hint">{t.certificateHint}</p>
          <div className="cert-fields">
            <label>
              <span>{t.firstName}</span>
              <input
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                autoComplete="given-name"
                maxLength={60}
              />
            </label>
            <label>
              <span>{t.lastName}</span>
              <input
                value={last}
                onChange={(e) => setLast(e.target.value)}
                autoComplete="family-name"
                maxLength={60}
              />
            </label>
          </div>
          <fieldset className="cert-lang">
            <legend>{t.certificateLanguage}</legend>
            <div className="radio-pills">
              {LANGUAGES.map((l) => (
                <label key={l.code} className={l.code === certLang ? "radio-pill on" : "radio-pill"} lang={l.code}>
                  <input
                    type="radio"
                    name={`cert-lang-${courseId}`}
                    value={l.code}
                    checked={l.code === certLang}
                    onChange={() => setCertLang(l.code)}
                  />
                  {l.label}
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn" type="submit" disabled={busy}>
            {t.downloadCertificate}
          </button>
        </form>
      ) : (
        <div className="cert-actions">
          <button className="btn" type="button" onClick={() => open(issued.lang)}>
            {t.downloadCertificate}
          </button>
          <button className="btn ghost" type="button" onClick={() => void sharePng(issued.lang)} disabled={sharingPng}>
            {t.shareCertificatePng}
          </button>
          <button className="btn ghost" type="button" onClick={() => setEditing(true)}>
            {t.fixName}
          </button>
        </div>
      )}
    </section>
  );
}

type Issued = { number: number; issuedAt: string; lang: Lang };

function issuedFrom(c: CourseCertificate): Issued | null {
  return c.number !== null && c.issuedAt ? { number: c.number, issuedAt: c.issuedAt, lang: c.lang ?? "ru" } : null;
}

/** «Имя Фамилия» → поля. Фамилия — всё после первого пробела: двойные имена
 *  у учениц редки, двойные фамилии — нет. */
function splitName(full: string | null): { first: string; last: string } | null {
  const s = full?.trim();
  if (!s) return null;
  const i = s.indexOf(" ");
  return i < 0 ? { first: s, last: "" } : { first: s.slice(0, i), last: s.slice(i + 1).trim() };
}

/** Дата по локали экрана; таджикской локали в браузере может не быть — тогда русская. */
function formatDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(lang === "tg" ? ["tg-TJ", "ru-RU"] : "ru-RU");
  } catch {
    return d.toLocaleDateString("ru-RU");
  }
}
