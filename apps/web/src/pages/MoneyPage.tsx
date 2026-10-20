import { useEffect, useState } from "react";
import { api, type FunnelResponse, type RevenueBucket, type RevenueResponse } from "../api";
import { Icons } from "../components/Brand";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { Skeleton, SkeletonTiles } from "../components/Skeleton";
import { money, plural, timeAgo } from "../format";

/**
 * «Деньги» — полная картина продаж: сколько пришло, за какие курсы, кто дошёл до
 * уроков и что ещё ждёт решения. Считается по покупкам, а не по чекам: доступ
 * мог открыть бот, владелец кнопкой в Telegram или живая хозяйка — продажа во
 * всех случаях одна.
 *
 * Волна 2 («Утро Ширин» §9, 10): откуда пришли деньги (Instagram / сайт /
 * Messenger / вручную), сколько часов проходит от первого сообщения до оплаты
 * и воронка от «написали» до сертификата — из /admin/metrics/revenue и
 * /admin/metrics/funnel. Столбики — inline-SVG, без библиотеки графиков, как
 * спарклайн на главной.
 */

type Row = {
  id: string;
  who: string;
  course: string;
  amount: number;
  rawAmount?: number | null;
  currency?: string | null;
  joined: boolean;
  createdAt: string;
};

type Money = {
  days: number;
  total: number;
  count: number;
  byCourse: Record<string, { count: number; sum: number }>;
  byDay: Record<string, number>;
  revoked: number;
  pending: number;
  unchecked: number;
  blocked: number;
  offline: number;
  rows: Row[];
  hasMore: boolean;
};

const COURSE_LABEL: Record<string, string> = {
  COURSE50: "Арт-десерты",
  COURSE70: "21 рецепт",
};

const PERIODS = [
  { days: 1, label: "Сегодня" },
  { days: 7, label: "Неделя" },
  { days: 30, label: "Месяц" },
  { days: 365, label: "Год" },
];

export function MoneyPage() {
  const [data, setData] = useState<Money | null>(null);
  const [revenue, setRevenue] = useState<RevenueResponse | null>(null);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** «Ещё раз» после обрыва сети — тот же эффект, новый ключ. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Тот же приём, что на Главной (DashboardPage): cancelled — быстрое
    // переключение вкладок Сегодня/Неделя/Месяц/Год не даёт устаревшему ответу
    // перезаписать более свежий запрошенный позже период, и err сбрасывается
    // на каждый новый запрос, а не остаётся навсегда после одного сбоя сети.
    let cancelled = false;
    setData(null);
    setRevenue(null);
    setFunnel(null);
    setErr(null);
    api<Money>(`/admin/money?days=${days}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message);
      });
    // Каналы и воронка — отдельными запросами: их сбой не должен прятать
    // главные суммы, поэтому ошибка тут только в консоль.
    api<RevenueResponse>(`/admin/metrics/revenue?days=${days}`)
      .then((r) => !cancelled && setRevenue(r))
      .catch((e) => console.error("metrics/revenue", e));
    api<FunnelResponse>(`/admin/metrics/funnel?days=${days}`)
      .then((f) => !cancelled && setFunnel(f))
      .catch((e) => console.error("metrics/funnel", e));
    return () => {
      cancelled = true;
    };
  }, [days, attempt]);

  function loadMoreRows() {
    if (!data) return;
    setLoadingMore(true);
    api<Money>(`/admin/money?days=${days}&rowsSkip=${data.rows.length}`)
      .then((d) => setData({ ...data, rows: [...data.rows, ...d.rows], hasMore: d.hasMore }))
      .catch((e) => setErr(e instanceof Error ? e.message : "Ошибка"))
      .finally(() => setLoadingMore(false));
  }

  const notJoined = data ? data.rows.filter((r) => !r.joined).length : 0;
  const maxDay = data ? Math.max(1, ...Object.values(data.byDay)) : 1;
  const lastDays = data ? Object.entries(data.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-14) : [];

  return (
    <div className="card">
      <h2>{Icons.money} Деньги</h2>
      <p className="hint">
        Суммы в сомони: чеки из России пересчитаны по курсу.
      </p>

      <div className="seg" style={{ marginBottom: 16 }}>
        {PERIODS.map((p) => (
          <button key={p.days} className={days === p.days ? "active" : ""} onClick={() => setDays(p.days)}>
            {p.label}
          </button>
        ))}
      </div>

      {err && !data && <OfflineState error={err} onRetry={() => setAttempt((a) => a + 1)} />}
      {err && data && <div className="msg err">{err}</div>}
      {!data && !err && (
        <>
          <SkeletonTiles hero={false} count={4} />
          <Skeleton height={72} className="skeleton-bars" />
        </>
      )}

      {data && (
        <>
          <div className="tiles" style={{ marginBottom: 16 }}>
            <Tile value={money(data.total)} label="пришло всего" big />
            <Tile value={String(data.count)} label="продаж" />
            {Object.entries(data.byCourse).map(([course, v]) => (
              <Tile key={course} value={money(v.sum)} label={`${COURSE_LABEL[course] ?? course} · ${v.count} ${plural(v.count, "продажа", "продажи", "продаж")}`} />
            ))}
            <Tile value={String(data.offline)} label="записей на офлайн" />
          </div>

          {(data.pending > 0 || data.unchecked > 0 || notJoined > 0 || data.revoked > 0 || data.blocked > 0) && (
            <div className="tiles fit" style={{ marginBottom: 16 }}>
              {data.pending > 0 && <Tile value={String(data.pending)} label="чеков ждут решения" warn />}
              {data.unchecked > 0 && <Tile value={String(data.unchecked)} label="чеков в перепроверке" warn />}
              {notJoined > 0 && <Tile value={String(notJoined)} label="оплатили, но не вошли" warn />}
              {data.revoked > 0 && <Tile value={String(data.revoked)} label="доступ отобран" />}
              {data.blocked > 0 && <Tile value={String(data.blocked)} label="в чёрном списке" />}
            </div>
          )}

          {lastDays.length > 1 && (
            <div style={{ marginBottom: 20 }}>
              <div className="funnel-meta" style={{ marginBottom: 6 }}>По дням, сомони</div>
              <div className="bars">
                {lastDays.map(([day, sum]) => (
                  <div key={day} style={{ flex: 1, textAlign: "center" }} title={`${day}: ${sum} сомони`}>
                    <div className="bar" style={{ height: `${Math.round((sum / maxDay) * 72)}px` }} />
                    <div className="bar-day">{day.slice(8)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {revenue && revenue.count > 0 && (
            <section className="metrics-block" data-testid="revenue-channels">
              <h3 className="metrics-title">Откуда пришли деньги</h3>
              <div className="bento" style={{ marginBottom: 12 }}>
                {revenue.byChannel.slice(0, 3).map((b) => (
                  <Tile key={b.key} value={money(b.sum)} label={`${b.title} · ${b.count} ${plural(b.count, "продажа", "продажи", "продаж")}`} />
                ))}
                <Tile
                  value={revenue.timeToPay.medianHours != null ? hoursLabel(revenue.timeToPay.medianHours) : "—"}
                  label={
                    revenue.timeToPay.sample > 0
                      ? `от первого сообщения до оплаты (в среднем ${hoursLabel(revenue.timeToPay.averageHours ?? 0)})`
                      : "срок до оплаты — пока не по чему считать"
                  }
                />
              </div>
              <BarRows rows={revenue.byChannel} label="Выручка по каналам" />
              <BarRows rows={revenue.byCourse} label="Выручка по курсам" />
            </section>
          )}

          {funnel && (
            <section className="metrics-block" data-testid="funnel">
              <h3 className="metrics-title">Воронка за {funnel.days} {plural(funnel.days, "день", "дня", "дней")}</h3>
              <Funnel steps={funnel.steps} />
            </section>
          )}

          <div className="list">
            {data.rows.map((r) => (
              <div className="list-row" key={r.id}>
                <div className="list-main">
                  <div className="list-title">{r.who}</div>
                  <div className="list-sub">
                    {COURSE_LABEL[r.course] ?? r.course} · {timeAgo(r.createdAt)}
                    {r.currency && r.currency !== "TJS" && r.rawAmount != null && ` · ${r.rawAmount} ${r.currency}`}
                  </div>
                </div>
                <div className="list-actions" style={{ alignItems: "center", gap: 10 }}>
                  {!r.joined && <span className="chip chip-warn">не вошёл</span>}
                  <div className="list-amount">{money(r.amount)}</div>
                </div>
              </div>
            ))}
            {data.rows.length === 0 && (
              <EmptyState scene="QuietMorning" title="Тихо — продаж не было" hint="За этот период никто не оплатил. Иногда так бывает: посмотрите период длиннее." />
            )}
          </div>

          {data.hasMore && (
            <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMoreRows}>
              {loadingMore ? "Загружаю…" : "Показать ещё"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** «3 ч», «2 дня», «40 мин» — часы в человеческую длительность. */
export function hoursLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} мин`;
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} ${plural(h, "час", "часа", "часов")}`;
  }
  const d = Math.round(hours / 24);
  return `${d} ${plural(d, "день", "дня", "дней")}`;
}

/**
 * Горизонтальные столбики — один inline-SVG на строку: подпись слева, сумма
 * справа, длина от самой большой корзины. Цвета — токены, как у спарклайна.
 */
function BarRows({ rows, label }: { rows: RevenueBucket[]; label: string }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.sum));
  return (
    <div className="bar-rows" role="img" aria-label={`${label}: ${rows.map((r) => `${r.title} ${money(r.sum)}`).join(", ")}`}>
      <div className="bar-rows-title">{label}</div>
      {rows.map((r) => (
        <div key={r.key} className="bar-row">
          <span className="bar-row-label">{r.title}</span>
          <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="bar-row-svg" aria-hidden="true">
            <rect x="0" y="0" width="100" height="10" rx="5" fill="var(--accent)" opacity="0.12" />
            <rect x="0" y="0" width={Math.max(2, (r.sum / max) * 100)} height="10" rx="5" fill="var(--accent)" />
          </svg>
          <span className="bar-row-value">{money(r.sum)}</span>
        </div>
      ))}
    </div>
  );
}

/** Воронка: ступени сужаются к сертификату; под каждой — процент от предыдущей. */
function Funnel({ steps }: { steps: FunnelResponse["steps"] }) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <ol className="funnel-steps">
      {steps.map((s) => (
        <li key={s.key} className="funnel-step">
          <div className="funnel-step-head">
            <span className="funnel-step-title">{s.title}</span>
            <span className="funnel-step-count">{s.count}</span>
          </div>
          <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="funnel-step-svg" aria-hidden="true">
            <rect x="0" y="0" width="100" height="8" rx="4" fill="var(--accent)" opacity="0.1" />
            <rect x="0" y="0" width={Math.max(s.count > 0 ? 2 : 0, (s.count / max) * 100)} height="8" rx="4" fill="var(--accent)" />
          </svg>
          {s.conversion != null && <div className="funnel-step-conv">{s.conversion}% от предыдущего шага</div>}
        </li>
      ))}
    </ol>
  );
}

function Tile({ value, label, big, warn }: { value: string; label: string; big?: boolean; warn?: boolean }) {
  return (
    <div className={`tile${big ? " hero" : ""}${warn ? " warn" : ""}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}
