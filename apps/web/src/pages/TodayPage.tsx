import { useState, type ReactNode } from "react";
import { ConversationSheet } from "../components/ConversationSheet";
import { Icons } from "../components/Brand";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { AccessLinkSheet } from "../components/AccessLinkSheet";
import { money, timeAgo } from "../format";
import { useShowEscalations } from "../panel/prefs";
import { activeCards, type Attention, type TodayCardId, type WaitingClient } from "../panel/useAttention";

/**
 * «СЕГОДНЯ» — первый экран панели для человека, который не любит технику.
 *
 * Один вопрос: «что ждёт меня прямо сейчас?». На каждое дело — одна крупная
 * карточка: число, одна строка пояснения и ОДНА главная кнопка с глаголом
 * («Проверить чеки», «Ответить»). Дел нет — спокойное «Всё сделано».
 * Деньги, графики и состояние системы отсюда убраны: они в «Ещё → Сводка дня».
 *
 * Данные приходят готовыми (useAttention): никаких выдуманных цифр.
 */
export type TodayGo = "receipts" | "questions" | "clients" | "recipes" | "summary";

export function TodayPage(props: {
  data: Attention | null;
  error: string | null;
  simple: boolean;
  onRetry: () => void;
  onGo: (tab: TodayGo) => void;
  onOpenStudent: (contactId: string) => void;
}) {
  const { data, error, simple, onRetry, onGo, onOpenStudent } = props;
  const [linkOpen, setLinkOpen] = useState(false);

  return (
    <section className="card today" aria-labelledby="today-title">
      <h2 id="today-title">{Icons.home} Сегодня</h2>
      <p className="hint">{greeting()}. Здесь только то, что нужно сделать сейчас.</p>

      {!data && !error && (
        <div className="today-grid" aria-busy="true" aria-label="Загружаю дела" data-testid="today-skeleton">
          <Skeleton height={168} radius={18} />
          <Skeleton height={168} radius={18} />
        </div>
      )}
      {!data && error && <OfflineState error={error} onRetry={onRetry} />}

      {data && (
        <>
          {error && (
            <div className="msg err" role="status">
              Не получилось обновить. Показано то, что было видно в прошлый раз.{" "}
              <button type="button" className="linklike" onClick={onRetry}>
                Обновить
              </button>
            </div>
          )}
          <Cards data={data} simple={simple} onGo={onGo} onOpenStudent={onOpenStudent} />
        </>
      )}

      <div className="today-tools">
        <button type="button" className="btn ghost wide today-action" onClick={() => setLinkOpen(true)}>
          Выдать ссылку на уроки
        </button>
      </div>
      <AccessLinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} />
    </section>
  );
}

function Cards(props: {
  data: Attention;
  simple: boolean;
  onGo: (t: TodayGo) => void;
  onOpenStudent: (id: string) => void;
}) {
  const { data, simple, onGo, onOpenStudent } = props;
  const showWaiting = useShowEscalations();
  const ids = activeCards(data, simple, showWaiting);

  if (ids.length === 0) {
    return (
      <EmptyState scene="AllDone" title="Всё сделано" hint="Новых чеков и вопросов нет. Можно спокойно пить чай." />
    );
  }
  return (
    <div className="today-grid" data-testid="today-cards">
      {ids.map((id) => (
        <div key={id} className="today-cell">
          {renderCard(id, data, onGo, onOpenStudent)}
        </div>
      ))}
    </div>
  );
}

function renderCard(
  id: TodayCardId,
  a: Attention,
  onGo: (t: TodayGo) => void,
  onOpenStudent: (id: string) => void,
): ReactNode {
  switch (id) {
    case "receipts": {
      const first = a.queue.find((q) => q.kind === "receipt");
      const sub =
        first && first.kind === "receipt"
          ? `Первый — ${first.who.handle}${first.amount != null ? `, ${money(first.amount)}` : ""}, ${timeAgo(first.createdAt)}.`
          : "Посмотрите фото и подтвердите оплату — клиент получит доступ.";
      return (
        <TodayCard
          tone="teal"
          icon={Icons.receipts}
          count={a.receipts}
          title="Чеки на проверку"
          sub={sub}
          action="Проверить чеки"
          onAction={() => onGo("receipts")}
        />
      );
    }
    case "waiting": {
      return <WaitingCard waiting={a.waiting} />;
    }
    case "questions":
      return (
        <TodayCard
          tone="pink"
          icon={Icons.comment}
          count={a.questions}
          title="Вопросы без ответа"
          sub="Ученицы спросили в приложении с уроками. Ответ придёт им туда же."
          action="Ответить"
          onAction={() => onGo("questions")}
        />
      );
    case "notOpened": {
      const first = a.queue.find((q) => q.kind === "notOpened");
      return (
        <TodayCard
          tone="orange"
          icon={Icons.clients}
          count={a.notOpened}
          title="Оплатили, но не открыли уроки"
          sub="Напомните им — достаточно нажать на ссылку, которую они уже получили."
          action={first && first.kind === "notOpened" && a.notOpened === 1 ? "Напомнить" : "Открыть список"}
          onAction={() =>
            first && first.kind === "notOpened" && a.notOpened === 1
              ? onOpenStudent(first.who.contactId)
              : onGo("clients")
          }
        />
      );
    }
    case "recipes": {
      const item = a.queue.find((q) => q.kind === "recipesToReview");
      const count = item && item.kind === "recipesToReview" ? item.count : 0;
      return (
        <TodayCard
          tone="orange"
          icon={Icons.media}
          count={count}
          title="Рецепты на проверку"
          sub="Ученицы их уже видят. Сверьте граммы с фото карточки."
          action="Проверить рецепты"
          onAction={() => onGo("recipes")}
        />
      );
    }
    case "problems":
      return (
        <TodayCard
          tone="pink"
          icon={Icons.settings}
          count={a.problems.length}
          title="Что-то работает не так"
          sub={
            <>
              Помощник или сайт сообщили:
              <ul className="today-problems">
                {a.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              Покажите это тому, кто всё настраивал.
            </>
          }
          action="Открыть сводку"
          onAction={() => onGo("summary")}
        />
      );
  }
}

function TodayCard(props: {
  tone: "teal" | "orange" | "pink";
  icon: JSX.Element;
  count: number;
  title: string;
  sub: ReactNode;
  action: string;
  onAction: () => void;
}) {
  const { tone, icon, count, title, sub, action, onAction } = props;
  return (
    <article className={`today-card ${tone}`}>
      <div className="today-head">
        <span className={`icon-circle ${tone}`}>{icon}</span>
        <div className="today-count">{count}</div>
      </div>
      <h3 className="today-title">{title}</h3>
      <div className="today-sub">{sub}</div>
      <button type="button" className="btn wide today-action" onClick={onAction}>
        {action}
      </button>
    </article>
  );
}

/** Сколько ждущих показываем сразу; остальные появятся, как только эти получат ответ. */
const WAITING_SHOWN = 3;

function WaitingCard(props: { waiting: WaitingClient[] }) {
  const { waiting } = props;
  const [open, setOpen] = useState<WaitingClient | null>(null);
  const shown = waiting.slice(0, WAITING_SHOWN);
  const hidden = waiting.length - shown.length;
  return (
    <article className="today-card pink">
      <div className="today-head">
        <span className="icon-circle pink">{Icons.comment}</span>
        <div className="today-count">{waiting.length}</div>
      </div>
      <h3 className="today-title">Клиенты ждут ответа</h3>
      <ul className="today-people">
        {shown.map((c) => (
          <li key={c.contactId} className="today-person">
            <p className="today-sub">
              <b>{c.name}</b> · {c.channelLabel} · {timeAgo(c.at)}
              <br />
              {c.reason}
            </p>
            {c.replyUrl ? (
              <a
                className="btn wide today-action"
                href={c.replyUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Ответить: ${c.name}`}
              >
                Ответить
              </a>
            ) : (
              <button
                type="button"
                className="btn wide today-action"
                onClick={() => setOpen(c)}
                aria-label={`Прочитать переписку: ${c.name}`}
              >
                Прочитать переписку
              </button>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="today-sub">И ещё {hidden} — появятся здесь, когда вы ответите этим.</p>}
      <ConversationSheet contactId={open?.contactId ?? null} name={open?.name ?? ""} onClose={() => setOpen(null)} />
    </article>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}
