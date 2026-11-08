import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Offer,
  type OfferCheck,
  type OfferHistoryRow,
  type OfferPreview,
  type OfferSnapshot,
  type PriceJump,
} from "../api";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/ConfirmDialog";
import { useUnsavedGuard } from "../components/UnsavedGuard";
import { useTelegramMainButton } from "../telegram";

/**
 * «ЦЕНЫ И ДАТЫ» — всё, что бот и сайт говорят клиентам о цене и наборе, на
 * одном экране (08.11.2026). Хозяйка меняет цифру — под полем сразу видно,
 * как это скажет бот по-русски и по-таджикски. Текст предпросмотра собирает
 * СЕРВЕР теми же функциями, что работают в бою (POST /admin/v1/offer/preview),
 * поэтому экран не может пообещать одно, а бот сказать другое.
 *
 * Защита от ошибок — на сервере (services/offerService.ts): пустая цена,
 * прошедшая дата, время не ЧЧ:ММ, комплект дороже двух курсов. Здесь только
 * показываем её словами и спрашиваем «Точно?», если цена меняется больше
 * чем на 30 %.
 */

/** Черновик: числа строками, чтобы поле можно было очистить. */
type Draft = {
  course50: string;
  course70: string;
  bundle: string;
  price: string;
  startDate: string;
  timeFrom: string;
  timeTo: string;
  address: string;
  seats: string;
  days: string;
  desserts: string;
};

function toDraft(o: Offer): Draft {
  return {
    course50: String(o.prices.course50),
    course70: String(o.prices.course70),
    bundle: String(o.prices.bundle),
    price: String(o.offline.price),
    startDate: o.offline.startDate,
    timeFrom: o.offline.timeFrom,
    timeTo: o.offline.timeTo,
    address: o.offline.address,
    seats: o.offline.seats == null ? "" : String(o.offline.seats),
    days: String(o.offline.days),
    desserts: String(o.offline.desserts),
  };
}

/** Пустое поле уходит как null — сервер ответит «укажите сумму», а не сохранит ноль. */
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

function toOffer(d: Draft) {
  return {
    prices: { course50: num(d.course50), course70: num(d.course70), bundle: num(d.bundle) },
    offline: {
      price: num(d.price),
      startDate: d.startDate,
      timeFrom: d.timeFrom,
      timeTo: d.timeTo,
      address: d.address,
      seats: num(d.seats),
      days: num(d.days),
      desserts: num(d.desserts),
    },
  };
}

const PREVIEW_DEBOUNCE_MS = 350;

export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function jumpText(j: PriceJump): string {
  const sign = j.percent > 0 ? "+" : "";
  return `${j.label}: ${j.before} → ${j.after} сомони (${sign}${j.percent} %)`;
}

export function OfferPage() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState("");
  const [snap, setSnap] = useState<OfferSnapshot | null>(null);
  const [preview, setPreview] = useState<OfferPreview | null>(null);
  const [check, setCheck] = useState<OfferCheck | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Номер последнего запроса предпросмотра: ответ на устаревший черновик (пришёл
   *  позже свежего) не должен перезаписать экран старыми цифрами. */
  const previewSeq = useRef(0);

  const apply = useCallback((s: OfferSnapshot) => {
    const d = toDraft(s.offer);
    setSnap(s);
    setDraft(d);
    setSaved(JSON.stringify(d));
    setPreview(s.preview);
    setCheck({ errors: {}, confirm: [], warnings: s.warnings });
    setFieldErrors({});
  }, []);

  useEffect(() => {
    api<OfferSnapshot>("/admin/v1/offer")
      .then(apply)
      .catch((e) => setErr((e as Error).message));
  }, [apply]);

  const dirty = draft != null && JSON.stringify(draft) !== saved;
  useUnsavedGuard(dirty);

  // Живой предпросмотр и проверка — из черновика, без записи.
  useEffect(() => {
    if (!draft || !dirty) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const seq = ++previewSeq.current;
      api<{ preview: OfferPreview; check: OfferCheck }>("/admin/v1/offer/preview", {
        method: "POST",
        body: { offer: toOffer(draft) },
      })
        .then((r) => {
          if (seq !== previewSeq.current) return;
          setPreview(r.preview);
          setCheck(r.check);
          setFieldErrors(r.check.errors);
        })
        .catch((e) => {
          if (seq !== previewSeq.current) return;
          if (e instanceof ApiError && e.status === 400)
            setFieldErrors((e.data as { fields?: Record<string, string> })?.fields ?? {});
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draft, dirty]);

  const save = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setErr(null);
    // Версия — та, с которой экран открыли: если кто-то сохранил раньше нас,
    // сервер ответит «обновите страницу», а не перезапишет чужую правку.
    const send = (confirm: boolean) =>
      api<OfferSnapshot & { ok: boolean }>("/admin/v1/offer", {
        method: "PUT",
        body: { offer: toOffer(draft), confirm, version: snap?.version ?? "" },
      });
    const isStale = (e: unknown) => e instanceof ApiError && e.status === 409 && (e.data as { stale?: boolean })?.stale === true;
    try {
      let result: OfferSnapshot;
      try {
        result = await send(false);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409) || isStale(e)) throw e;
        const jumps = ((e.data as { confirm?: PriceJump[] })?.confirm ?? []).map(jumpText);
        const ok = await confirmDialog({
          title: "Точно меняем цену?",
          message: `Цена меняется больше чем на 30 %:\n${jumps.join("\n")}\nКлиенты сразу услышат новую цену.`,
          confirmLabel: "Да, сохранить",
          cancelLabel: "Проверю ещё раз",
        });
        if (!ok) return;
        result = await send(true);
      }
      apply(result);
      toast("Сохранено. Бот уже говорит новое, на сайте — в течение минуты");
    } catch (e) {
      previewSeq.current++;
      if (isStale(e)) {
        setErr((e as ApiError).message);
      } else if (e instanceof ApiError && e.status === 400) {
        setFieldErrors((e.data as { fields?: Record<string, string> })?.fields ?? {});
        setErr("Проверьте поля, отмеченные красным");
      } else setErr(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }, [draft, busy, apply, snap]);

  useTelegramMainButton({ text: "Сохранить", visible: dirty, disabled: busy, onClick: save });

  if (err && !draft)
    return (
      <div className="card">
        <div className="msg err">{err}</div>
      </div>
    );
  if (!draft || !snap)
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 300 }} />
      </div>
    );

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [key]: e.target.value });
  const bundleFull = (num(draft.course50) ?? 0) + (num(draft.course70) ?? 0);
  // Предупреждения про дату показаны у поля даты; здесь — остальные (например, старые часы текстом).
  const extraWarnings = (check?.warnings ?? []).filter((w) => !/дата уточняется/.test(w));
  const datePast = draft.startDate !== "" && draft.startDate < snap.today;

  return (
    <form
      className="offer-page"
      // Проверяет сервер и подсказки у полей. Встроенная проверка браузера (min у даты)
      // блокировала бы сохранение цены, пока в базе стоит прошедшая дата набора.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="offer-head">
        <h1>Цены и даты</h1>
        <p className="hint">Что бот и сайт говорят клиентам. Под каждым полем — как это прозвучит.</p>
      </div>

      <div className="offer-grid">
        <section className="card offer-card" aria-labelledby="offer-c50">
          <h2 id="offer-c50">
            Арт-десерты <span className="offer-tag">онлайн</span>
          </h2>
          <Money
            label="Цена"
            value={draft.course50}
            onChange={set("course50")}
            error={fieldErrors["prices.course50"]}
          />
          <BotLine says={preview?.course50} />
        </section>

        <section className="card offer-card" aria-labelledby="offer-c70">
          <h2 id="offer-c70">
            21 рецепт <span className="offer-tag">онлайн</span>
          </h2>
          <Money
            label="Цена"
            value={draft.course70}
            onChange={set("course70")}
            error={fieldErrors["prices.course70"]}
          />
          <BotLine says={preview?.course70} />
        </section>

        <section className="card offer-card" aria-labelledby="offer-bundle">
          <h2 id="offer-bundle">Оба курса вместе</h2>
          <Money
            label="Цена"
            value={draft.bundle}
            onChange={set("bundle")}
            error={fieldErrors["prices.bundle"]}
            note={bundleFull > 0 ? `По отдельности — ${bundleFull} сомони` : undefined}
          />
          <BotLine says={preview?.bundle} />
        </section>
      </div>

      <section className="card offer-card" aria-labelledby="offer-offline">
        <h2 id="offer-offline">Очный курс в Душанбе</h2>
        <div className="offer-fields">
          <Money label="Цена" value={draft.price} onChange={set("price")} error={fieldErrors["offline.price"]} />
          <Field
            label="Ближайший набор"
            tone={fieldErrors["offline.startDate"] ? "error" : datePast ? "warn" : "note"}
            hint={
              fieldErrors["offline.startDate"] ??
              (draft.startDate === ""
                ? "Не назначена — клиентам скажем «дата уточняется»"
                : datePast
                  ? "Набор в прошлом — клиентам скажем, что дата уточняется"
                  : formatDay(draft.startDate))
            }
            extra={
              draft.startDate !== "" && (
                <button type="button" className="btn quiet small offer-clear" onClick={() => setDraft({ ...draft, startDate: "" })}>
                  Убрать дату
                </button>
              )
            }
          >
            {(a) => (
              <input
                {...a}
                type="date"
                value={draft.startDate}
                min={snap.today}
                onChange={set("startDate")}
                aria-invalid={Boolean(fieldErrors["offline.startDate"])}
              />
            )}
          </Field>
          <div className="offer-time">
            <Field label="Занятия с" tone="error" hint={fieldErrors["offline.timeFrom"]}>
              {(a) => <input {...a} type="time" value={draft.timeFrom} onChange={set("timeFrom")} aria-invalid={Boolean(fieldErrors["offline.timeFrom"])} />}
            </Field>
            <Field label="до" tone="error" hint={fieldErrors["offline.timeTo"]}>
              {(a) => <input {...a} type="time" value={draft.timeTo} onChange={set("timeTo")} aria-invalid={Boolean(fieldErrors["offline.timeTo"])} />}
            </Field>
          </div>
          <Field label="Адрес" tone="error" hint={fieldErrors["offline.address"]} className="offer-span">
            {(a) => <input {...a} value={draft.address} onChange={set("address")} aria-invalid={Boolean(fieldErrors["offline.address"])} />}
          </Field>
          <Count
            label="Мест в группе"
            value={draft.seats}
            onChange={set("seats")}
            error={fieldErrors["offline.seats"]}
            placeholder="Не говорить"
          />
          <Count label="Дней" value={draft.days} onChange={set("days")} error={fieldErrors["offline.days"]} />
          <Count
            label="Десертов"
            value={draft.desserts}
            onChange={set("desserts")}
            error={fieldErrors["offline.desserts"]}
          />
        </div>
        {preview?.offline.source === "custom" && (
          <p className="offer-warn offer-block">
            В разделе «Тексты» записан свой текст карточки — бот отправит его, а не эти поля. Чтобы поля работали,
            очистите его там.
          </p>
        )}
        <BotLine says={preview?.offline} pre />
      </section>

      {extraWarnings.length > 0 && <div className="msg offer-warn-box">{extraWarnings.join(". ")}</div>}
      {err && (
        <div className="msg err" role="alert">
          {err}
        </div>
      )}

      <History rows={snap.history} />

      <div className="save-bar">
        <button type="submit" className="btn wide offer-save" disabled={!dirty || busy}>
          {busy ? "Сохраняю…" : dirty ? "Сохранить" : "Всё сохранено"}
        </button>
        <p className="offer-after">Бот подхватит сразу, на сайте появится в течение минуты.</p>
      </div>
    </form>
  );
}

type FieldAttrs = { id: string; "aria-describedby"?: string };

/** Подпись, поле и строка-подсказка под ним. Подсказка связана с полем
 *  (aria-describedby), а не вложена в подпись — имя поля для экранного
 *  диктора остаётся коротким: «Цена, сомони», а не «Цена, сомони Укажите…». */
function Field(props: {
  label: string;
  hint?: string | null;
  tone?: "note" | "warn" | "error";
  className?: string;
  extra?: React.ReactNode;
  children: (attrs: FieldAttrs) => React.ReactNode;
}) {
  const id = useId();
  const hintId = props.hint ? `${id}-hint` : undefined;
  return (
    <div className={`field offer-field ${props.className ?? ""}`}>
      <label htmlFor={id} className="offer-label">
        {props.label}
      </label>
      {props.children({ id, "aria-describedby": hintId })}
      {props.hint && (
        <small id={hintId} className={`offer-${props.tone ?? "note"}`} role={props.tone === "error" ? "alert" : undefined}>
          {props.hint}
        </small>
      )}
      {props.extra}
    </div>
  );
}

function Money(props: { label: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement>; error?: string; note?: string }) {
  const empty = props.value.trim() === "";
  const hint = empty ? "Укажите цену — пустой оставить нельзя" : (props.error ?? props.note);
  return (
    <Field label={`${props.label}, сомони`} hint={hint} tone={empty || props.error ? "error" : "note"}>
      {(a) => (
        <input
          {...a}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={props.value}
          onChange={props.onChange}
          aria-invalid={Boolean(props.error) || empty}
          required
          className="offer-money"
        />
      )}
    </Field>
  );
}

function Count(props: { label: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement>; error?: string; placeholder?: string }) {
  return (
    <Field label={props.label} hint={props.error} tone="error">
      {(a) => (
        <input
          {...a}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={props.value}
          placeholder={props.placeholder}
          onChange={props.onChange}
          aria-invalid={Boolean(props.error)}
        />
      )}
    </Field>
  );
}

function BotLine({ says, pre = false }: { says?: { ru: string; tg: string }; pre?: boolean }) {
  if (!says) return null;
  const Body = pre ? "pre" : "div";
  return (
    <div className="preview offer-preview" data-testid="bot-says">
      <div className="preview-title">Так скажет бот клиенту</div>
      <div className="pair">
        <div>
          <div className="offer-lang">По-русски</div>
          <Body className={pre ? "preview-pre" : "preview-text"}>{says.ru}</Body>
        </div>
        <div>
          <div className="offer-lang">Бо тоҷикӣ</div>
          <Body className={pre ? "preview-pre" : "preview-text"}>{says.tg}</Body>
        </div>
      </div>
    </div>
  );
}

function History({ rows }: { rows: OfferHistoryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="card soft offer-history">
      <summary>Кто и когда менял</summary>
      <ul>
        {rows.map((r, i) => (
          <li key={`${r.at}-${r.field}-${i}`}>
            <span className="offer-history-when">
              {new Date(r.at).toLocaleString("ru-RU", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>{" "}
            <b>{r.label}</b>: {r.before || "пусто"} → {r.after || "пусто"}{" "}
            <span className="offer-history-who">· {r.actor}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
