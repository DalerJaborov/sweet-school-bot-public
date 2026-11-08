import { useEffect, useState } from "react";
import { api } from "../api";
import { Switch } from "./Switch";
import { toast } from "./Toast";

/**
 * «Оплаты — в рекламу Meta» (API: /admin/v1/meta-conversions, metaConversions.ts).
 * Рубильник по умолчанию выключен. Поля — набор данных, маркер (секрет), проверочный код.
 */
type Status = {
  enabled: boolean;
  ready: boolean;
  testMode: boolean;
  counts: Record<string, number>;
  lastProblem: { status: string; lastError: string | null; createdAt: string } | null;
  paidWeek: number;
  paidFromAdsWeek: number;
};
type Keys = "metaCapiDatasetId" | "metaCapiToken" | "metaCapiIgAccountId" | "metaCapiTestEventCode" | "metaCapiWabaId";
const FIELDS: { key: Keys; label: string; hint: string }[] = [
  { key: "metaCapiDatasetId", label: "Набор данных (dataset)", hint: "Цифры из Events Manager → Источники данных" },
  { key: "metaCapiToken", label: "Маркер доступа", hint: "Показываем как •••, новое значение заменит старое" },
  {
    key: "metaCapiIgAccountId",
    label: "Instagram: id профессионального аккаунта",
    hint: "Цифры из настроек аккаунта в Meta Business. Без него оплаты из Instagram ждут в очереди",
  },
  {
    key: "metaCapiTestEventCode",
    label: "Проверочный код",
    hint: "Из «Тестовых событий». Пока он задан, настоящие оплаты ждут в очереди. После проверки очистите",
  },
  {
    key: "metaCapiWabaId",
    label: "WhatsApp: id бизнес-аккаунта (WABA)",
    hint: "Только если номер подключён к официальному WhatsApp API. Пусто — оплаты из WhatsApp не передаются",
  },
];

export function MetaPurchaseSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [values, setValues] = useState<Partial<Record<Keys, string>>>({});
  const [busy, setBusy] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; detail: string } | null>(null);

  async function refresh() {
    try {
      const s = await api<Status>("/admin/v1/meta-conversions/status");
      setStatus(s);
      setEnabled(s.enabled);
    } catch {
      setStatus(null);
    }
  }
  useEffect(() => {
    void refresh();
    api<Record<string, string | null>>("/admin/settings")
      .then((s) => setValues(Object.fromEntries(FIELDS.map((f) => [f.key, s[f.key] ?? ""]))))
      .catch(() => undefined);
  }, []);

  async function flip(next: boolean) {
    setEnabled(next);
    try {
      await api("/admin/settings", { method: "PUT", body: { metaCapiEnabled: String(next) } });
    } catch (e) {
      setEnabled(!next);
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api("/admin/settings", {
        method: "PUT",
        body: Object.fromEntries(FIELDS.map((f) => [f.key, values[f.key] ?? ""])),
      });
      toast("Сохранено");
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      // Проверяем сохранённое: сервер шлёт событие с теми значениями, что в базе.
      await api("/admin/settings", {
        method: "PUT",
        body: Object.fromEntries(FIELDS.map((f) => [f.key, values[f.key] ?? ""])),
      });
      setTestNote(
        await api<{ ok: boolean; detail: string }>("/admin/v1/meta-conversions/test", { method: "POST", body: {} }),
      );
    } catch (e) {
      setTestNote({ ok: false, detail: e instanceof Error ? e.message : "Проверка не удалась" });
    } finally {
      setBusy(false);
    }
  }

  const c = status?.counts ?? {};
  return (
    <section
      aria-labelledby="meta-pay-title"
      style={{ marginBlock: 24, paddingBlock: 16, borderBlock: "1px solid #ddd" }}
    >
      <h3 id="meta-pay-title">Оплаты — в рекламу Meta</h3>
      <p>Подтверждённая оплата уходит в Meta: в рекламном кабинете видно, какая реклама приводит покупателей. Учиться искать покупателей реклама может только в Messenger и в официальном WhatsApp.</p>
      <Switch
        checked={enabled}
        onChange={(next) => void flip(next)}
        label={enabled ? "Передавать оплаты в Meta — включено" : "Передавать оплаты в Meta — выключено"}
        hint="Передаются оплаты из Instagram и Messenger. Из WhatsApp — только если номер подключён к официальному WhatsApp API."
        testId="switch-metaCapiEnabled"
      />
      {status && (
        <p role="status">
          Оплат за 7 дней: {status.paidWeek}, из них пришли из рекламы: {status.paidFromAdsWeek}. Передано:{" "}
          {c.sent ?? 0}, в очереди: {c.pending ?? 0}, не передано (сайт, WhatsApp без официального API): {c.skipped ?? 0}, ошибок: {c.failed ?? 0}.
          {status.testMode && " Сейчас проверка: настоящие оплаты ждут в очереди и уйдут в Meta, когда вы очистите проверочный код."}
        </p>
      )}
      {status?.lastProblem?.lastError && (
        <p className="msg err">Оплата не передана: {status.lastProblem.lastError}</p>
      )}
      {FIELDS.map((f) => (
        <label className="field" key={f.key}>
          <span>
            {f.label} — {f.hint}
          </span>
          <input
            type="text"
            autoComplete="off"
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy || !values.metaCapiTestEventCode}
          onClick={() => void test()}
        >
          Отправить проверочную оплату
        </button>
      </div>
      {testNote && (
        <p className={`msg ${testNote.ok ? "" : "err"}`} role="status">
          {testNote.ok ? "Meta приняла проверку. " : "Не прошло: "}
          {testNote.detail}
        </p>
      )}
    </section>
  );
}
