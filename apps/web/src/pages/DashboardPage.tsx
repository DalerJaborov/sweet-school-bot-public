import { useCallback, useEffect, useState } from "react";
import { api, type GoodNewsItem, type QueueItem, type Today } from "../api";
import { AssistantBox } from "../components/AssistantBox";
import { Icons } from "../components/Brand";
import { Collapse } from "../components/Collapse";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { Illustration } from "../components/Illustration";
import { Lightbox } from "../components/Lightbox";
import { ReceiptCard } from "../components/ReceiptCard";
import { SkeletonList, SkeletonTiles } from "../components/Skeleton";
import { Sparkline } from "../components/Sparkline";
import { toast } from "../components/Toast";
import { formatNumber, money, plural, timeAgo } from "../format";
import { useCountUp } from "../hooks/useCountUp";
import { useReceiptDecision } from "../hooks/useReceiptDecision";

/**
 * ГЛАВНЫЙ ЭКРАН «СЕГОДНЯ» — утренняя записка от помощницы («Утро Ширин» §1–4).
 *
 * Ширин открывает панель из Telegram за чаем и за 20 секунд видит: сколько
 * денег вчера, сколько чеков и вопросов ждут, кому порадоваться. Каждая
 * карточка очереди — с действием прямо в ней: чек подтверждается свайпом или
 * кнопкой, на вопрос отвечается тут же, битое видео перезапускается. Один
 * экран отвечает на «как дела сегодня?», всё остальное — в один тап.
 *
 * Данные — один запрос GET /admin/today (apps/api/src/today.ts). После любого
 * действия перезапрашиваем с ?fresh=1, чтобы карточка исчезла сразу.
 */
export type GoTab = "money" | "receipts" | "questions" | "clients" | "courses" | "settings" | "recipes";

export function DashboardPage({
  onGo,
  onOpenStudent,
}: {
  onGo: (tab: GoTab) => void;
  /** Тап по нику в очереди/новостях — карточка ученицы (StudentPage). */
  onOpenStudent?: (contactId: string) => void;
}) {
  const [d, setD] = useState<Today | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback((fresh = false) => {
    let cancelled = false;
    setErr(null);
    api<Today>(`/admin/today${fresh ? "?fresh=1" : ""}`)
      .then((data) => !cancelled && setD(data))
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);
  const refresh = useCallback(() => void load(true), [load]);

  const decision = useReceiptDecision({ onSettled: refresh });

  if (err && !d) {
    return (
      <div className="card">
        <OfflineState error={err} onRetry={() => void load()} />
      </div>
    );
  }

  if (!d) {
    return (
      <>
        <div className="card">
          <SkeletonTiles />
        </div>
        <div className="card">
          <SkeletonList rows={2} />
        </div>
      </>
    );
  }

  // Чек с отложенным решением остаётся в списке, но «уезжает» (Collapse):
  // если в тосте нажали «Отменить», карточка раскрывается обратно на месте.
  const queue = d.queue;
  const visibleCount = queue.filter((q) => !(q.kind === "receipt" && decision.pending.has(q.id))).length;
  const quiet = d.money.yesterday === 0 && d.money.salesYesterday === 0;

  return (
    <>
      <section className="card">
        <h2>{Icons.home} Сегодня</h2>
        <p className="hint">{greeting()}. Вот как дела — и что можно сделать прямо сейчас.</p>
        <div className="bento">
          <div className="tile hero" data-testid="tile-money">
            {quiet && <Illustration scene="QuietMorning" size={64} />}
            <div className="tile-label">{quiet ? "вчера было тихо" : "деньги за вчера"}</div>
            <div className="tile-value">
              <CountUp value={d.money.yesterday} /> с.
            </div>
            <div className="tile-deltas">
              <Delta now={d.money.yesterday} was={d.money.dayBefore} label="к позавчера" />
              <Delta now={d.money.week} was={d.money.prevWeek} label="неделя к неделе" />
            </div>
          </div>
          <StatTile
            tone="orange"
            icon={Icons.money}
            value={d.money.salesYesterday}
            label={plural(d.money.salesYesterday, "оплата вчера", "оплаты вчера", "оплат вчера")}
            onClick={() => onGo("money")}
          />
          <StatTile
            tone="pink"
            icon={Icons.comment}
            value={d.unansweredQuestions}
            label={plural(d.unansweredQuestions, "вопрос без ответа", "вопроса без ответа", "вопросов без ответа")}
            onClick={() => onGo("questions")}
            urgent={d.unansweredQuestions > 0}
          />
          <StatTile
            tone="teal"
            icon={Icons.receipts}
            value={d.pendingReceipts}
            label={plural(d.pendingReceipts, "чек в ожидании", "чека в ожидании", "чеков в ожидании")}
            onClick={() => onGo("receipts")}
            urgent={d.pendingReceipts > 0}
          />
        </div>
        <div className="spark-row">
          <Sparkline points={d.sparkline} label="Деньги за 14 дней" />
          <div className="spark-caption">
            <span>14 дней</span>
            <b>{money(d.money.week)} за неделю</b>
          </div>
        </div>
      </section>

      <AssistantBox onOpenQuestions={() => onGo("questions")} />

      <section className="card">
        <h2>{Icons.pulse} Сделать сейчас</h2>
        {visibleCount === 0 && <EmptyState scene="AllDone" title="Всё разобрано" hint="Чеки подтверждены, вопросы отвечены — можно спокойно пить чай." />}
        {queue.length > 0 && (
          <div className="queue" data-testid="queue">
            {queue.map((item) => (
              <Collapse key={queueKey(item)} open={!(item.kind === "receipt" && decision.pending.has(item.id))}>
                <QueueCard
                  item={item}
                  onGo={onGo}
                  onOpenStudent={onOpenStudent}
                  onZoom={setZoom}
                  onApprove={(r) => void decision.approve(r)}
                  onReject={(r) => void decision.reject(r)}
                  onChanged={refresh}
                />
              </Collapse>
            ))}
          </div>
        )}
      </section>

      {d.goodNews.length > 0 && (
        <section className="card">
          <h2>{Icons.style} Хорошие новости</h2>
          {/* Курс — часть ключа: комплект из двух курсов открывается в одну
              секунду, и без него две новости одной ученицы получают один ключ. */}
          <div className="news-strip">
            {d.goodNews.map((n) => (
              <GoodNewsCard key={`${n.kind}:${n.who.contactId}:${n.course ?? ""}:${n.at}`} item={n} onOpenStudent={onOpenStudent} />
            ))}
          </div>
        </section>
      )}

      <SystemLine system={d.system} onGo={onGo} />
      <Lightbox src={zoom} label="Фото чека целиком" alt="Чек целиком, увеличено" onClose={() => setZoom(null)} />
    </>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

function queueKey(item: QueueItem): string {
  switch (item.kind) {
    case "receipt":
    case "question":
      return `${item.kind}:${item.id}`;
    case "notOpened":
      return `notOpened:${item.who.contactId}`;
    case "transcodeFailed":
      return `transcode:${item.lessonId}`;
    case "recipesToReview":
      return "recipesToReview";
    case "gemini":
      return "gemini";
  }
}

/** Дельта «стало / было»: стрелка и проценты; при нуле «было» — просто «+N с.». */
function Delta({ now, was, label }: { now: number; was: number; label: string }) {
  const diff = now - was;
  const pct = was > 0 ? Math.round((diff / was) * 100) : null;
  const tone = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  // Ноль сегодня при ненулевом «было» — не «−100%», а спокойное «было 100 с.»:
  // проценты от нуля пугают, а сумма позавчера — просто факт.
  const text =
    now === 0 && was > 0
      ? `было ${money(was)}`
      : pct != null
        ? `${diff > 0 ? "+" : ""}${pct}%`
        : diff === 0
          ? "без изменений"
          : `${diff > 0 ? "+" : ""}${money(diff)}`;
  return (
    <span className={`delta ${tone}`}>
      <b>{text}</b> {label}
    </span>
  );
}

/** Число плитки «пересчитывается» при смене значения (hooks/useCountUp.ts). */
function CountUp({ value }: { value: number }) {
  return <>{formatNumber(useCountUp(value))}</>;
}

function StatTile({
  icon,
  tone,
  value,
  label,
  onClick,
  urgent = false,
}: {
  icon: JSX.Element;
  tone: "teal" | "orange" | "pink";
  value: number;
  label: string;
  onClick: () => void;
  urgent?: boolean;
}) {
  return (
    <button type="button" className={`tile stat ${tone} tappable ${urgent ? "urgent" : ""}`} onClick={onClick}>
      <span className={`icon-circle ${tone}`}>{icon}</span>
      <div className="tile-text">
        <div className="tile-label">{label}</div>
        <div className="tile-value">
          <CountUp value={value} />
        </div>
      </div>
    </button>
  );
}

/** Ник как кнопка в карточку ученицы — если панели передали, куда открывать. */
function Who({ who, onOpenStudent }: { who: { contactId: string; handle: string }; onOpenStudent?: (id: string) => void }) {
  if (!onOpenStudent) return <>{who.handle}</>;
  return (
    <button type="button" className="linklike" onClick={() => onOpenStudent(who.contactId)} aria-label={`Открыть карточку ${who.handle}`}>
      {who.handle}
    </button>
  );
}

function QueueCard({
  item,
  onGo,
  onOpenStudent,
  onZoom,
  onApprove,
  onReject,
  onChanged,
}: {
  item: QueueItem;
  onGo: (tab: GoTab) => void;
  onOpenStudent?: (contactId: string) => void;
  onZoom: (url: string) => void;
  onApprove: (r: { id: string; handle: string; amount: number | null }) => void;
  onReject: (r: { id: string; handle: string; amount: number | null }) => void;
  onChanged: () => void;
}) {
  if (item.kind === "receipt") {
    const r = { id: item.id, handle: item.who.handle, amount: item.amount };
    return (
      <ReceiptCard
        compact
        receipt={{ ...item, handle: item.who.handle }}
        onApprove={() => onApprove(r)}
        onReject={() => onReject(r)}
        onZoom={onZoom}
      />
    );
  }
  if (item.kind === "question") return <QuestionCard item={item} onChanged={onChanged} onOpenStudent={onOpenStudent} />;
  if (item.kind === "notOpened") {
    return (
      <div className="queue-card">
        <div className="queue-title">
          <Who who={item.who} onOpenStudent={onOpenStudent} /> оплатила {item.daysAgo} {plural(item.daysAgo, "день", "дня", "дней")} назад, но уроки не открыла
        </div>
        <div className="queue-sub">Напомните — ссылка у неё в переписке, ей нужно просто нажать.</div>
        <div className="queue-actions">
          {item.who.instagramUrl ? (
            <a className="btn small" href={item.who.instagramUrl} target="_blank" rel="noreferrer">
              Написать в Instagram
            </a>
          ) : (
            <button type="button" className="btn small" onClick={() => (onOpenStudent ? onOpenStudent(item.who.contactId) : onGo("clients"))}>
              Открыть карточку
            </button>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "transcodeFailed") return <TranscodeCard item={item} onChanged={onChanged} onGo={onGo} />;
  if (item.kind === "recipesToReview") {
    return (
      <div className="queue-card">
        <div className="queue-title">Рецепты с карточек ждут проверки — {item.count}</div>
        <div className="queue-sub">Ученицы уже видят их в приложении. Фото карточки и текст рядом — исправьте, если что-то прочиталось не так.</div>
        <div className="queue-actions">
          <button type="button" className="btn small" onClick={() => onGo("recipes")}>
            Проверить
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="queue-card warn">
      <div className="queue-title">Gemini на {item.percent}% суточного лимита</div>
      <div className="queue-sub">
        {item.calls} из {item.limit} ходов. На 100% бот замолчит до полуночи — можно поднять лимит в настройках.
      </div>
      <div className="queue-actions">
        <button type="button" className="btn small" onClick={() => onGo("settings")}>
          Открыть настройки
        </button>
      </div>
    </div>
  );
}

function QuestionCard({
  item,
  onChanged,
  onOpenStudent,
}: {
  item: Extract<QueueItem, { kind: "question" }>;
  onChanged: () => void;
  onOpenStudent?: (contactId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      await api(`/admin/course-chat/${item.id}/reply`, { method: "POST", body: { text: draft.trim() } });
      toast(`Ответ ушёл ${item.who.handle}`);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось отправить", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="queue-card">
      <div className="queue-head">
        <span className="queue-who">
          <Who who={item.who} onOpenStudent={onOpenStudent} />
        </span>
        {item.lesson && <span className="chip">{item.lesson}</span>}
        <span className="queue-time">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="queue-question">{item.text}</div>
      {open ? (
        <div className="reply-box">
          <textarea
            className="reply-input"
            value={draft}
            autoFocus
            rows={3}
            placeholder="Ответ ученице…"
            aria-label={`Ответ для ${item.who.handle}`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="queue-actions">
            <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={() => void send()}>
              {busy ? "Отправляю…" : "Отправить"}
            </button>
            <button type="button" className="btn quiet" disabled={busy} onClick={() => setOpen(false)}>
              Позже
            </button>
          </div>
        </div>
      ) : (
        <div className="queue-actions">
          <button type="button" className="btn small" onClick={() => setOpen(true)}>
            Ответить
          </button>
        </div>
      )}
    </div>
  );
}

function TranscodeCard({
  item,
  onChanged,
  onGo,
}: {
  item: Extract<QueueItem, { kind: "transcodeFailed" }>;
  onChanged: () => void;
  onGo: (tab: GoTab) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    try {
      const r = await api<{ note: string }>(`/admin/lessons/${item.lessonId}/retranscode`, { method: "POST" });
      toast(r.note || "Видео готовится, ~10 мин");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось перезапустить", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="queue-card warn">
      <div className="queue-title">Видео урока «{item.title}» не собралось</div>
      <div className="queue-sub">Обычно помогает запустить ещё раз. Если нет — загрузите файл заново в «Курсах».</div>
      <div className="queue-actions">
        <button type="button" className="btn small" disabled={busy} onClick={() => void retry()}>
          {busy ? "Запускаю…" : "Ещё раз"}
        </button>
        <button type="button" className="btn quiet small" onClick={() => onGo("courses")}>
          Открыть курсы
        </button>
      </div>
    </div>
  );
}

const NEWS_TITLE: Record<GoodNewsItem["kind"], string> = {
  certificate: "получила сертификат",
  finished: "прошла курс целиком",
  openedSameDay: "открыла первый урок в день покупки",
};

function GoodNewsCard({ item, onOpenStudent }: { item: GoodNewsItem; onOpenStudent?: (contactId: string) => void }) {
  async function askReview() {
    try {
      await navigator.clipboard?.writeText(item.reviewText);
      toast("Текст просьбы скопирован — вставьте в сообщение");
    } catch {
      toast("Не удалось скопировать текст", "error");
    }
  }
  return (
    <div className="news-card">
      <div className="news-title">
        <b>
          <Who who={item.who} onOpenStudent={onOpenStudent} />
        </b>{" "}
        {NEWS_TITLE[item.kind]}
      </div>
      <div className="news-sub">
        {item.course ?? "курс"} · {timeAgo(item.at)}
      </div>
      {item.who.instagramUrl ? (
        <a className="btn ghost small" href={item.who.instagramUrl} target="_blank" rel="noreferrer" onClick={() => void askReview()}>
          Попросить отзыв
        </a>
      ) : (
        <button type="button" className="btn ghost small" onClick={() => void askReview()}>
          Попросить отзыв
        </button>
      )}
    </div>
  );
}

function SystemLine({ system, onGo }: { system: Today["system"]; onGo: (tab: GoTab) => void }) {
  const disk = system.diskFreePct != null ? `диск ${100 - system.diskFreePct}%` : "диск ?";
  const diskBad = system.diskFreePct != null && system.diskFreePct < 10;
  const geminiPct = system.gemini.limit > 0 ? Math.round((system.gemini.calls / system.gemini.limit) * 100) : 0;
  return (
    <div className="system-line" role="status" aria-label="Состояние системы">
      <Status ok={system.bot} label={system.bot ? "бот отвечает" : "бот выключен"} onClick={() => onGo("settings")} />
      <Status ok={system.instagram} label={system.instagram ? "Instagram подключён" : "Instagram не подключён"} onClick={() => onGo("settings")} />
      <Status ok={system.storage} label={system.storage ? "хранилище ок" : "хранилище не настроено"} onClick={() => onGo("settings")} />
      <Status ok={!diskBad} label={disk} />
      <Status ok={geminiPct < 80} label={`Gemini ${system.gemini.calls}/${system.gemini.limit}`} />
      {system.problems.map((p) => (
        <Status key={p} ok={false} label={p} />
      ))}
    </div>
  );
}

function Status({ ok, label, onClick }: { ok: boolean; label: string; onClick?: () => void }) {
  const cls = `status-dot ${ok ? "ok" : "bad"}`;
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {label}
      </button>
    );
  }
  return <span className={cls}>{label}</span>;
}
