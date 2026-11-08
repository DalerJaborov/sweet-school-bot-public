import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TextsForm, type TextsPreview, type TextsResponse } from "../api";
import { Icons } from "../components/Brand";
import { toast } from "../components/Toast";
import { useUnsavedGuard } from "../components/UnsavedGuard";
import { useTelegramMainButton } from "../telegram";

/**
 * «ТЕКСТЫ» — реквизиты и на чьё имя карта, условие сертификата, язык уроков,
 * «что после оплаты», свой текст карточки очного курса — RU и TG рядом
 * («Утро Ширин» §12). Цены и даты набора с 08.11.2026 — отдельный экран
 * «Цены и даты» (OfferPage): одна дверь записи, проверки и журнал.
 *
 * Предпросмотр «как увидит покупательница» приходит С СЕРВЕРА
 * (POST /admin/texts/preview) из черновика — теми же функциями, что читают
 * бот и сайт, поэтому не может разойтись с тем, что уйдёт на самом деле.
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
      <p className="hint">Цены курсов и дата набора — в разделе «Цены и даты».</p>

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
        <h2>{Icons.journal} Карточка очного курса</h2>
        <p className="hint">Пусто — бот соберёт карточку сам из «Цены и даты». Свой текст уходит дословно, и цены с датой в нём вы обновляете сами.</p>
        <div className="pair">
          <label className="field">
            <span>Свой текст карточки — RU</span>
            <textarea value={form.offline.infoRu} placeholder="Пусто — соберём из «Цены и даты»" onChange={(e) => setOffline("infoRu", e.target.value)} />
          </label>
          <label className="field">
            <span>Свой текст карточки — TG</span>
            <textarea value={form.offline.infoTg} placeholder="Холӣ — аз «Нарх ва сана» месозем" onChange={(e) => setOffline("infoTg", e.target.value)} />
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
