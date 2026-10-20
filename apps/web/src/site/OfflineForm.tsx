import { useId, useState, type FormEvent } from "react";
import type { Dict, Lang } from "./i18n";
import { api, ApiError } from "./api";
import { useCatalog } from "./catalog";

/**
 * Запись на офлайн-курс: имя + телефон → POST /api/site/offline-signup.
 * Правила валидации повторяют контракт (имя 2–80, телефон 9–20 знаков из
 * цифр, «+» и пробелов), чтобы человек узнал об ошибке до отправки.
 * Цена и дата ближайшего набора — из каталога; пока он грузится, показываем
 * значение по умолчанию из разметки (priceFallback), а про дату молчим.
 *
 * ДАТА (решение 05.09.2026): API отдаёт nextStartDate только пока набор
 * впереди (по Душанбе) — прошедшую дату сервер превращает в null сам, и здесь
 * это единственный признак «показать дату» или «дата уточняется». В статике
 * страницы даты нет вовсе: 4 октября сайт не должен звать на 3 октября.
 */

export const NAME_RE = /^.{2,80}$/s;
export const PHONE_RE = /^[\d+\s()-]{9,20}$/;

export function validateName(v: string): boolean {
  return NAME_RE.test(v.trim());
}
export function validatePhone(v: string): boolean {
  const s = v.trim();
  return PHONE_RE.test(s) && (s.match(/\d/g)?.length ?? 0) >= 9;
}

export function OfflineForm({ t, lang, priceFallback }: { t: Dict; lang: Lang; priceFallback: number }) {
  const ids = useId();
  const { data } = useCatalog();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState({ name: false, phone: false });
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const nameOk = validateName(name);
  const phoneOk = validatePhone(phone);
  const price = data?.offline.price ?? priceFallback;
  const nextStart = data?.offline.nextStartDate ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, phone: true });
    if (!nameOk || !phoneOk || status === "sending") return;
    setStatus("sending");
    setError(null);
    try {
      await api.offlineSignup({ name: name.trim(), phone: phone.trim(), lang });
      setStatus("done");
    } catch (err) {
      setStatus("idle");
      if (err instanceof ApiError && err.status === 429) setError(t.formErrLimit);
      else if (err instanceof ApiError && err.status === 0) setError(t.networkError);
      else setError(t.formErrGeneric);
    }
  };

  if (status === "done") {
    return (
      <div className="card card-soft" role="status">
        <h3 className="h3">{t.formSuccessTitle}</h3>
        <p style={{ marginTop: 8 }}>{t.formSuccessText(name.trim())}</p>
        <button
          type="button"
          className="btn btn-soft"
          style={{ marginTop: 16 }}
          onClick={() => {
            setName("");
            setPhone("");
            setTouched({ name: false, phone: false });
            setStatus("idle");
          }}
        >
          {t.formAgain}
        </button>
      </div>
    );
  }

  return (
    <form className="card form" onSubmit={submit} noValidate aria-labelledby={`${ids}-h`}>
      <h3 className="h3" id={`${ids}-h`}>
        {t.formTitle}
      </h3>
      <p className="muted">{t.formLead}</p>
      <div className="price-tag" data-testid="offline-price">
        {t.offlinePrice(price)}
        <small>{t.offlinePriceNote}</small>
      </div>
      {data &&
        (nextStart ? (
          <p className="chip chip-ok" data-testid="offline-next-start">
            {t.offlineNextStart(t.dayMonth(nextStart))}
          </p>
        ) : (
          <p className="muted" data-testid="offline-date-tbd">
            {t.offlineDateTbd}
          </p>
        ))}

      <div className="field">
        <label htmlFor={`${ids}-name`}>{t.formName}</label>
        <input
          id={`${ids}-name`}
          name="name"
          autoComplete="name"
          placeholder={t.formNamePlaceholder}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, name: true }))}
          aria-invalid={touched.name && !nameOk}
          aria-describedby={touched.name && !nameOk ? `${ids}-name-err` : undefined}
          required
        />
        {touched.name && !nameOk && (
          <span className="field-err" id={`${ids}-name-err`}>
            {t.formErrName}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor={`${ids}-phone`}>{t.formPhone}</label>
        <input
          id={`${ids}-phone`}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder={t.formPhonePlaceholder}
          value={phone}
          maxLength={20}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, phone: true }))}
          aria-invalid={touched.phone && !phoneOk}
          aria-describedby={touched.phone && !phoneOk ? `${ids}-phone-err` : undefined}
          required
        />
        {touched.phone && !phoneOk && (
          <span className="field-err" id={`${ids}-phone-err`}>
            {t.formErrPhone}
          </span>
        )}
      </div>

      {error && (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-lg btn-block" disabled={status === "sending"}>
        {status === "sending" ? t.formSending : t.formSubmit}
      </button>
      <p className="form-note">{t.formPrivacy}</p>
    </form>
  );
}
