import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";

type Catalog = { courses: { code: string; title: string; price: number }[]; bundlePrice: number };
type Result = { contactId: string; url: string; createdCourses: string[]; alreadyEnrolled: boolean };

export function ManualEnrollment({
  onSaved,
  onOpenStudent,
}: {
  onSaved: () => void;
  onOpenStudent?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [lang, setLang] = useState("tg");
  const [course, setCourse] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    api<Catalog>("/admin/manual-enrollments/catalog")
      .then((data) => {
        if (!active) return;
        setCatalog(data);
        if (data.courses[0]) {
          setCourse(data.courses[0].code);
          setAmount(String(data.courses[0].price));
        }
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Не удалось загрузить курсы");
      });
    return () => {
      active = false;
    };
  }, [open]);

  function selectCourse(value: string) {
    setCourse(value);
    setAmount(
      String(
        value === "BOTH" ? (catalog?.bundlePrice ?? "") : (catalog?.courses.find((c) => c.code === value)?.price ?? ""),
      ),
    );
    setConfirmed(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !confirmed || !course) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await api<Result>("/admin/manual-enrollments", {
        method: "POST",
        body: { name, phone, lang, course, amount: Number(amount), paymentConfirmed: confirmed },
      });
      setResult(data);
      setConfirmed(false);
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось открыть доступ. Проверьте список учениц перед повтором.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button
        className="btn"
        type="button"
        onClick={() => {
          setOpen(true);
          setError("");
          setConfirmed(false);
          setCatalog(null);
          setCourse("");
        }}
      >
        Добавить оплатившую ученицу
      </button>
    );
  if (result)
    return (
      <section className="card" aria-label="Результат ручной продажи">
        <h3>{result.alreadyEnrolled ? "Эти курсы уже открыты" : "Доступ открыт"}</h3>
        <p>
          {result.alreadyEnrolled
            ? "Повторная покупка не создана. Действующая ссылка сохранена."
            : "Оплата записана вручную. Ссылка никому автоматически не отправлялась."}
        </p>
        <label className="field">
          Личная ссылка ученицы
          <input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <p className="hint">
          Скопируйте ссылку и передайте ученице лично в WhatsApp. Срок ссылки — 7 дней с её выдачи. Для продления
          используйте карточку ученицы. Не публикуйте ссылку.
        </p>
        <button
          className="btn"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(result.url);
              setCopied(true);
            } catch {
              setError("Не удалось скопировать. Выделите ссылку в поле и скопируйте вручную.");
            }
          }}
        >
          {copied ? "Скопировано" : "Скопировать ссылку"}
        </button>
        {onOpenStudent && (
          <button type="button" className="btn ghost" onClick={() => onOpenStudent(result.contactId)}>
            Карточка ученицы
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setOpen(false);
            setResult(null);
            setName("");
            setPhone("");
            setCopied(false);
            setCatalog(null);
          }}
        >
          Готово
        </button>
        {error && (
          <p role="alert" className="msg err">
            {error}
          </p>
        )}
      </section>
    );
  return (
    <form className="card" onSubmit={submit} aria-label="Ручная продажа курса">
      <h3>Продажа после проверки оплаты</h3>
      <p className="hint">
        Только после реального поступления денег. Здесь не создаётся чек и не отправляются сообщения. Ученица
        определяется по телефону; используйте её постоянный номер. Для существующего Instagram-аккаунта откройте его
        карточку, чтобы не создать второй профиль.
      </p>
      <label className="field">
        Имя ученицы
        <input
          required
          minLength={2}
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setConfirmed(false);
          }}
          autoComplete="name"
        />
      </label>
      <label className="field">
        Телефон WhatsApp
        <input
          required
          type="tel"
          maxLength={25}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setConfirmed(false);
          }}
          placeholder="+992 90 535 53 55"
          autoComplete="tel"
        />
      </label>
      <label className="field">
        Язык интерфейса
        <select
          value={lang}
          onChange={(e) => {
            setLang(e.target.value);
            setConfirmed(false);
          }}
        >
          <option value="tg">Тоҷикӣ</option>
          <option value="ru">Русский</option>
        </select>
      </label>
      <label className="field">
        Курс
        <select
          value={course}
          onChange={(e) => selectCourse(e.target.value)}
          required
          disabled={!catalog?.courses.length}
        >
          {!catalog && <option value="">Загрузка курсов…</option>}
          {catalog?.courses.map((c) => (
            <option key={c.code} value={c.code}>
              {c.title} — {c.price} сомони
            </option>
          ))}
          {catalog?.courses.some((c) => c.code === "COURSE50") &&
            catalog.courses.some((c) => c.code === "COURSE70") && (
              <option value="BOTH">Оба курса — {catalog.bundlePrice} сомони</option>
            )}
        </select>
      </label>
      {catalog?.courses.length === 0 && (
        <p role="status">Нет готовых курсов для продажи. Проверьте публикацию и видеоуроки.</p>
      )}
      <label className="field">
        Фактически получено, сомони
        <input
          required
          type="number"
          min={1}
          max={100000}
          step={1}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <label className="toggle" style={{ marginBlock: 16 }}>
        <input
          type="checkbox"
          style={{ width: 20, height: 20, flexShrink: 0 }}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{" "}
        Я проверила поступление этой суммы и подтверждаю оплату выбранного курса
      </label>
      <p className="hint">
        При докупке выберите только новый курс. Уже существующие покупки повторно не начисляются; отозванный доступ
        здесь не восстанавливается.
      </p>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
      <button className="btn" disabled={busy || !confirmed || !course} type="submit">
        {busy ? "Сохраняю…" : "Записать оплату и получить ссылку"}
      </button>
      <button className="btn ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>
        Отмена
      </button>
    </form>
  );
}
