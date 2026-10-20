import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TextsForm, type TextsPreview, type TextsResponse } from "../api";
import { Icons } from "../components/Brand";
import { toast } from "../components/Toast";
import { useUnsavedGuard } from "../components/UnsavedGuard";
import { useTelegramMainButton } from "../telegram";

/**
 * «ТЕКСТЫ И ЦЕНЫ» — одно место для всего, что видит покупательница
 * («Утро Ширин» §12). Цены курсов и комплекта, реквизиты и на чьё имя
 * карта, условие сертификата, язык уроков, «что после оплаты», офлайн-курс
 * (цена, дата, адрес, часы, десерты, свой текст карточки) — RU и TG рядом.
 *
 * Предпросмотр «как увидит покупательница» приходит С СЕРВЕРА
 * (POST /admin/texts/preview) из черновика — теми же функциями, что читают
 * бот и сайт, поэтому не может разойтись с тем, что уйдёт на самом деле.
 * Сохранение пишет и Settings, и Course.price (то, что показывает сайт).
 */
type Pair = { ru: keyof TextsForm["texts"]; tg: keyof TextsForm["texts"]; label: string; hint?: string };

const PAIRS: Pair[] = [
  { ru: "paymentNameNoteRu", tg: "paymentNameNoteTg", label: "Если спросят, почему не Ширин", hint: "Бот сам этого не говорит — только если прямо спросят" },
  { ru: "certificateRuleRu", tg: "certificateRuleTg", label: "Условие сертификата" },
  { ru: "lessonLanguageRu", tg: "lessonLanguageTg", label: "Язык уроков", hint: "Бот честно говорит это один раз до оплаты" },
  { ru: "afterPaymentRu", tg: "afterPaymentTg", label: "Что после оплаты" },
];

const PREVIEW_DEBOUNCE_MS = 400;

export function TextsPage() {
  const [form, setForm] = useState<TextsForm | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [preview, setPreview] = useState<TextsPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api<TextsResponse>("/admin/texts")
      .then((d) => {
        const { defaults: _d, preview: p, ...f } = d;
        setForm(f);
        setSaved(JSON.stringify(f));
        setPreview(p);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const dirty = form != null && JSON.stringify(form) !== saved;
  useUnsavedGuard(dirty);

  // Живой предпросмотр: сервер считает из черновика, с задержкой, чтобы не
  // дёргать его на каждую букву.
  useEffect(() => {
    if (!form || !dirty) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      api<TextsPreview>("/admin/texts/preview", { method: "POST", body: form })
        .then(setPreview)
        .catch(() => undefined);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [form, dirty]);

  const save = useCallback(async () => {
    if (!form || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const d = await api<TextsResponse & { ok: boolean }>("/admin/texts", { method: "PUT", body: form });
      const { defaults: _d, preview: p, ok: _ok, ...f } = d;
      setForm(f);
      setSaved(JSON.stringify(f));
      setPreview(p);
      toast("Сохранено — бот и сайт уже читают новое");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }, [form, busy]);

  useTelegramMainButton({ text: "Сохранить", visible: dirty, disabled: busy, onClick: save });

  if (err && !form) return <div className="card"><div className="msg err">{err}</div></div>;
  if (!form) return <div className="card"><div className="skeleton" style={{ height: 300 }} /></div>;

  const setPrice = (key: keyof TextsForm["prices"], value: string) =>
    setForm({ ...form, prices: { ...form.prices, [key]: Number(value) || 0 } });
  const setText = (key: keyof TextsForm["texts"], value: string) => setForm({ ...form, texts: { ...form.texts, [key]: value } });
  const setOffline = <K extends keyof TextsForm["offline"]>(key: K, value: TextsForm["offline"][K]) =>
    setForm({ ...form, offline: { ...form.offline, [key]: value } });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="card">
        <h2>{Icons.money} Цены</h2>
        <p className="hint">Одно место: бот, проверка чека, выдача доступа и сайт читают отсюда.</p>
        <div className="row">
          <label className="field">
            <span>Арт-десерты, сомони</span>
            <input type="number" inputMode="numeric" min={1} value={form.prices.course50} onChange={(e) => setPrice("course50", e.target.value)} />
          </label>
          <label className="field">
            <span>21 рецепт, сомони</span>
            <input type="number" inputMode="numeric" min={1} value={form.prices.course70} onChange={(e) => setPrice("course70", e.target.value)} />
          </label>
          <label className="field">
            <span>Оба курса вместе</span>
            <input type="number" inputMode="numeric" min={1} value={form.prices.bundle} onChange={(e) => setPrice("bundle", e.target.value)} />
          </label>
        </div>
        {preview && (
          <Preview title="Как скажет бот">
            <div>{preview.priceLine}</div>
          </Preview>
        )}
      </div>

      <div className="card">
        <h2>{Icons.receipts} Реквизиты</h2>
        <div className="row">
          <label className="field">
            <span>Номер для перевода</span>
            <input value={form.texts.paymentPhone} onChange={(e) => setText("paymentPhone", e.target.value)} />
          </label>
          <label className="field">
            <span>Получатель (как в банке)</span>
            <input value={form.texts.paymentRecipient} onChange={(e) => setText("paymentRecipient", e.target.value)} />
          </label>
          <label className="field">
            <span>Банки</span>
            <input value={form.texts.paymentBanks} onChange={(e) => setText("paymentBanks", e.target.value)} />
          </label>
        </div>
        <PairField pair={PAIRS[0]} form={form} onChange={setText} />
        {preview && <Preview title="Как увидит покупательница" ru={preview.payment.ru} tg={preview.payment.tg} />}
      </div>

      <div className="card">
        <h2>{Icons.style} Условия курса</h2>
        {PAIRS.slice(1).map((p) => (
          <PairField key={p.ru} pair={p} form={form} onChange={setText} />
        ))}
        {preview && (
          <>
            <Preview title="Сертификат" ru={preview.certificate.ru} tg={preview.certificate.tg} />
            <Preview title="После оплаты" ru={preview.afterPayment.ru} tg={preview.afterPayment.tg} />
          </>
        )}
      </div>

      <div className="card">
        <h2>{Icons.journal} Офлайн-курс в Душанбе</h2>
        <div className="row">
          <label className="field">
            <span>Цена, сомони</span>
            <input type="number" inputMode="numeric" min={1} value={form.offline.price} onChange={(e) => setOffline("price", Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <span>Дата начала</span>
            <input type="date" value={form.offline.startDate} onChange={(e) => setOffline("startDate", e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>Дней</span>
            <input type="number" inputMode="numeric" min={1} value={form.offline.days} onChange={(e) => setOffline("days", Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <span>Часы</span>
            <input value={form.offline.hours} placeholder="14:00 до 17:00" onChange={(e) => setOffline("hours", e.target.value)} />
          </label>
          <label className="field">
            <span>Десертов</span>
            <input type="number" inputMode="numeric" min={1} value={form.offline.desserts} onChange={(e) => setOffline("desserts", Number(e.target.value) || 0)} />
          </label>
        </div>
        <label className="field">
          <span>Адрес</span>
          <input value={form.offline.address} onChange={(e) => setOffline("address", e.target.value)} />
        </label>
        <div className="pair">
          <label className="field">
            <span>Свой текст карточки — RU</span>
            <textarea value={form.offline.infoRu} placeholder="Пусто — соберём из полей выше" onChange={(e) => setOffline("infoRu", e.target.value)} />
          </label>
          <label className="field">
            <span>Свой текст карточки — TG</span>
            <textarea value={form.offline.infoTg} placeholder="Холӣ — аз майдонҳои боло месозем" onChange={(e) => setOffline("infoTg", e.target.value)} />
          </label>
        </div>
        {preview && <Preview title="Карточка, которую отправит бот" ru={preview.offlineCard.ru} tg={preview.offlineCard.tg} pre />}
      </div>

      {preview && (
        <div className="card soft">
          <button type="button" className="btn quiet small" onClick={() => setShowRules((v) => !v)}>
            {showRules ? "Скрыть правила бота" : "Показать правила бота целиком"}
          </button>
          {showRules && <pre className="preview-pre" style={{ marginTop: 10 }}>{preview.botRules}</pre>}
        </div>
      )}

      {err && <div className="msg err">{err}</div>}
      <div className="save-bar">
        <button type="submit" className="btn wide" disabled={!dirty || busy}>
          {busy ? "Сохраняю…" : dirty ? "Сохранить" : "Всё сохранено"}
        </button>
      </div>
    </form>
  );
}

function PairField({
  pair,
  form,
  onChange,
}: {
  pair: Pair;
  form: TextsForm;
  onChange: (key: keyof TextsForm["texts"], value: string) => void;
}) {
  return (
    <div className="pair-block">
      <div className="pair-label">
        {pair.label}
        {pair.hint && <span className="pair-hint">{pair.hint}</span>}
      </div>
      <div className="pair">
        <label className="field">
          <span>По-русски</span>
          <textarea rows={3} value={form.texts[pair.ru]} onChange={(e) => onChange(pair.ru, e.target.value)} />
        </label>
        <label className="field">
          <span>Бо тоҷикӣ</span>
          <textarea rows={3} value={form.texts[pair.tg]} onChange={(e) => onChange(pair.tg, e.target.value)} />
        </label>
      </div>
    </div>
  );
}

function Preview({ title, ru, tg, pre = false, children }: { title: string; ru?: string; tg?: string; pre?: boolean; children?: React.ReactNode }) {
  const Body = pre ? "pre" : "div";
  return (
    <div className="preview" data-testid="preview">
      <div className="preview-title">{title}</div>
      {children}
      {ru != null && tg != null && (
        <div className="pair">
          <Body className={pre ? "preview-pre" : "preview-text"}>{ru}</Body>
          <Body className={pre ? "preview-pre" : "preview-text"}>{tg}</Body>
        </div>
      )}
    </div>
  );
}
