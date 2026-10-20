import { useState } from "react";
import { api, type ReceiptCheck } from "../api";
import { Icons } from "../components/Brand";
import { Collapse } from "../components/Collapse";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { Lightbox } from "../components/Lightbox";
import { Person, personTitle } from "../components/Person";
import { ReceiptCard } from "../components/ReceiptCard";
import { toast } from "../components/Toast";
import { money, timeAgo } from "../format";
import { usePaged } from "../hooks/usePaged";
import { useReceiptDecision } from "../hooks/useReceiptDecision";

/**
 * INBOX ЧЕКОВ «ОДНИМ ПАЛЬЦЕМ» («Утро Ширин» §5, §19).
 *
 * Ждущие решения чеки — карточками с фото во всю ширину: свайп вправо
 * подтверждает, влево отклоняет, кнопки на месте для ПК. Вместо окна
 * «Точно?» — тост «Ссылка ушла @ника · Отменить» на 5 секунд
 * (hooks/useReceiptDecision.ts); сама операция на сервере — та же, что у
 * кнопок в Telegram (receiptDecision.ts). Решённые чеки — ниже, историей.
 */
type Filter = "pending" | "all" | "sent";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "pending", label: "Ждут решения" },
  { id: "all", label: "Все" },
  { id: "sent", label: "Ссылка ушла" },
];

export function ReceiptsPage() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [zoom, setZoom] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { rows, hasMore, loadingMore, err, loadMore, reload } = usePaged<ReceiptCheck>("/admin/receipts", "");
  const decision = useReceiptDecision({ onSettled: reload });

  async function unpay(contactId: string) {
    setBusyId(contactId);
    try {
      await api(`/admin/contacts/${contactId}/unpay`, { method: "POST" });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось снять отметку", "error");
    } finally {
      setBusyId(null);
    }
  }

  const all = rows ?? [];
  const isPending = (r: ReceiptCheck) => r.ownerDecision === "PENDING" || r.kind === "unchecked";
  const visible = all.filter((r) => {
    if (filter === "pending") return isPending(r);
    if (filter === "sent") return r.linkSent;
    return true;
  });

  return (
    <div className="card">
      <h2>{Icons.receipts} Чеки</h2>
      <p className="hint">Похож на настоящий — ссылка уходит сама. Что-то не сходится — смотрите и решайте: свайп вправо «да», влево «нет».</p>

      <div className="seg" style={{ marginBottom: 14 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {err && !rows && <OfflineState error={err} onRetry={reload} />}
      {err && rows && <div className="msg err">{err}</div>}
      {!rows && !err && <SkeletonList rows={2} height={200} />}
      {rows && visible.filter((r) => !decision.pending.has(r.id)).length === 0 && (
        <EmptyState
          scene="AllDone"
          title={filter === "pending" ? "Все чеки разобраны" : "Здесь пусто"}
          hint={filter === "pending" ? "Новые появятся сами, как только кто-то пришлёт фото оплаты." : filter === "all" ? "Сюда попадают присланные фото, похожие на чек." : "Ссылка ещё никому не уходила."}
        />
      )}

      <div className="queue">
        {visible.map((r) =>
          r.ownerDecision === "PENDING" ? (
            <Collapse key={r.id} open={!decision.pending.has(r.id)}>
            <ReceiptCard
              receipt={{
                id: r.id,
                handle: personTitle(r.contact),
                imageUrl: r.imageUrl ?? null,
                amount: r.amount ?? null,
                courseGuess: r.courseGuess ?? null,
                reason: r.reason,
                confidence: r.confidence,
                createdAt: r.createdAt,
              }}
              onApprove={() => void decision.approve({ id: r.id, handle: personTitle(r.contact), amount: r.amount ?? null })}
              onReject={() => void decision.reject({ id: r.id, handle: personTitle(r.contact), amount: r.amount ?? null })}
              onZoom={setZoom}
            />
            </Collapse>
          ) : (
            <div className="list-row" key={r.id}>
              <div className="list-main" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                {r.imageUrl && (
                  <img className="thumb" src={r.imageUrl} alt="Чек" onClick={() => setZoom(r.imageUrl as string)} loading="lazy" />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Person person={r.contact} note={timeAgo(r.createdAt)} />
                  <div className="list-chips" style={{ marginTop: 6 }}>
                    <span className={`chip ${r.kind === "valid" ? "chip-ok" : r.kind === "unchecked" ? "" : "chip-warn"}`}>
                      {r.kind === "valid" ? "похож на настоящий" : r.kind === "unchecked" ? "перепроверяется" : "подозрительный"}
                    </span>
                    {r.amount != null && <span className="chip">{money(r.amount)}</span>}
                    {r.linkSent && <span className="chip chip-ok">ссылка ушла</span>}
                    {r.ownerDecision === "REJECTED" && <span className="chip chip-err">отклонён</span>}
                  </div>
                  {r.reason && <div className="list-sub" style={{ marginTop: 4 }}>{r.reason}</div>}
                </div>
              </div>
              {r.contact.paid && (
                <div className="list-actions">
                  <button className="btn danger small" disabled={busyId === r.contact.id} onClick={() => void unpay(r.contact.id)}>
                    Снять «оплатил»
                  </button>
                </div>
              )}
            </div>
          )
        )}
      </div>

      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}

      <Lightbox src={zoom} label="Фото чека целиком" alt="Чек целиком, увеличено" onClose={() => setZoom(null)} />
    </div>
  );
}
