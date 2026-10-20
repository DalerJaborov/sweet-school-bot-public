import { useEffect, useState } from "react";
import { api } from "../api";

type FunnelStats = {
  days: number;
  wrote: number;
  askedPrice: number;
  gotRequisites: number;
  sentReceipt: number;
  bought: number;
  droppedAfter: { greeting: number; price: number; requisites: number; other: number };
  requisitesDropoff: { total: number; buckets: { bucket: string; count: number }[] };
};

type QualityCase = {
  contactId: string;
  clientText: string;
  botText: string;
  humanText: string;
  at: string;
};

/**
 * «Качество» — где бот ответил плохо и как надо было.
 *
 * Отмечать ничего не нужно: список собирается сам. Каждый раз, когда Ширин
 * отвечает клиентке следом за ботом, это и значит «бот сказал не то». Кнопку
 * «плохой ответ» пришлось бы нажимать ей, а она читает переписки в самом
 * Instagram и в панель ради этого не заходит — кнопка висела бы неиспользованной.
 *
 * Зачем смотреть. Во-первых, видно повторяющиеся промахи: если бот трижды за
 * неделю не понял вопрос про оплату, дело не в случайности, а в промте.
 * Во-вторых, по длине списка видно, помогла ли правка: меньше вмешательств —
 * значит бот справляется сам.
 */
export function QualityPage() {
  const [cases, setCases] = useState<QualityCase[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [funnel, setFunnel] = useState<FunnelStats | null>(null);

  useEffect(() => {
    api<{ cases: QualityCase[]; hasMore: boolean }>("/admin/quality")
      .then((d) => {
        setCases(d.cases);
        setHasMore(d.hasMore);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Ошибка"))
      .finally(() => setLoading(false));
    // Пустой catch маскировал сетевой сбой под штатное «блок просто не нужен
    // показывать» — теперь хотя бы видно в консоли, что запрос не удался.
    api<FunnelStats>("/admin/funnel-stats")
      .then(setFunnel)
      .catch((e) => {
        console.error("funnel-stats", e);
        setFunnel(null);
      });
  }, []);

  // Курсор по времени, не skip — список не строка таблицы, а производные тройки
  // сообщений (см. /admin/quality). Раньше всегда были одни и те же 50
  // последних случаев, старые увидеть было нельзя вообще.
  function loadMore() {
    const last = cases[cases.length - 1];
    if (!last) return;
    setLoadingMore(true);
    api<{ cases: QualityCase[]; hasMore: boolean }>(`/admin/quality?before=${encodeURIComponent(last.at)}`)
      .then((d) => {
        setCases((prev) => [...prev, ...d.cases]);
        setHasMore(d.hasMore);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Ошибка"))
      .finally(() => setLoadingMore(false));
  }

  return (
    <div className="card">
      <h2>Качество ответов</h2>
      <p className="hint">
        Здесь случаи, когда после ответа бота в разговор вошла Ширин — значит бот ответил не так.
        Отмечать ничего не нужно, список собирается сам.
      </p>
      {err && <div className="msg err">{err}</div>}
      {funnel && funnel.wrote > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Воронка за {funnel.days} дней</h3>
          <p className="hint" style={{ margin: "0 0 8px" }}>
            Считается по следам в переписке — отмечать ничего не нужно.
          </p>
          {(
            [
              ["Написали", funnel.wrote],
              ["Спросили цену", funnel.askedPrice],
              ["Получили реквизиты", funnel.gotRequisites],
              ["Прислали чек", funnel.sentReceipt],
              ["Купили", funnel.bought],
            ] as const
          ).map(([label, value]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ minWidth: 150, fontSize: 14 }}>{label}</span>
              <span
                style={{
                  height: 10,
                  borderRadius: 5,
                  background: "var(--accent)",
                  // Ширина — доля от первого шага: воронка читается глазом, без счёта.
                  width: `${Math.max(2, Math.round((value / funnel.wrote) * 100))}%`,
                  maxWidth: "60%",
                }}
              />
              <span className="hint" style={{ margin: 0 }}>
                {value} · {Math.round((value / funnel.wrote) * 100)}%
              </span>
            </div>
          ))}
          <p className="hint" style={{ marginTop: 8 }}>
            Ушли молча: после приветствия {funnel.droppedAfter.greeting}, после разговора о цене{" "}
            {funnel.droppedAfter.price}, после реквизитов {funnel.droppedAfter.requisites}, в другом месте{" "}
            {funnel.droppedAfter.other}.
          </p>
          {funnel.requisitesDropoff && funnel.requisitesDropoff.total > 0 && (
            <div style={{ marginTop: 14 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>
                Получили реквизиты и не заплатили: {funnel.requisitesDropoff.total}
              </h3>
              <p className="hint" style={{ margin: "0 0 8px" }}>
                Сгруппировано по последнему сообщению бота (цена и номер убраны, чтобы одинаковые
                рассылки считались вместе) — видно, на каком именно вопросе чаще всего пропадают.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {funnel.requisitesDropoff.buckets.map((b, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "6px 8px 6px 0", fontSize: 14 }}>{b.bucket}</td>
                      <td style={{ padding: "6px 0", fontSize: 14, textAlign: "right", whiteSpace: "nowrap" }}>
                        {b.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {loading && <p className="hint">Загружаю…</p>}
      {!loading && cases.length === 0 && (
        <p className="hint">Пока пусто — бот справляется сам. Это хорошая новость.</p>
      )}
      {cases.map((c, i) => (
        <div key={`${c.contactId}-${i}`} className="field" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          {c.clientText && (
            <p style={{ margin: "0 0 6px" }}>
              <span className="hint" style={{ margin: 0 }}>Клиент:</span> {c.clientText}
            </p>
          )}
          <p style={{ margin: "0 0 6px", color: "var(--err)" }}>
            <span className="hint" style={{ margin: 0 }}>Бот ответил:</span> {c.botText}
          </p>
          <p style={{ margin: 0, color: "var(--ok)" }}>
            <span className="hint" style={{ margin: 0 }}>Ширин поправила:</span> {c.humanText}
          </p>
          <p className="hint" style={{ margin: "6px 0 0" }}>{new Date(c.at).toLocaleString("ru-RU")}</p>
        </div>
      ))}
      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}
    </div>
  );
}
