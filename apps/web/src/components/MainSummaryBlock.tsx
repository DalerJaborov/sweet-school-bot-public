import { useEffect, useState } from "react";
import { api, type BotState, type MainSummary } from "../api";
import { money, plural, timeAgo } from "../format";
import { Switch } from "./Switch";
import { toast } from "./Toast";

/**
 * «ГЛАВНОЕ» — ВЕРХ ЭКРАНА «СЕГОДНЯ» (11.11.2026).
 *
 * Владелец: «на дашборде самое важное: сколько денег получили, что происходит,
 * кнопка получить ссылку». Поэтому сверху три вещи и больше ничего: деньги
 * сегодня и за неделю с оплатами и записями на офлайн, крупная кнопка «Получить
 * ссылку» и строка «что происходит» (последние оплаты и записи + два тумблера
 * бота). Данные — apps/api/src/todaySummary.ts, тумблеры — /admin/v1/bot-control
 * (те же действия, что кнопки в Telegram).
 */
export function MainSummaryBlock(props: { main: MainSummary; onGetLink: () => void }) {
  const { main, onGetLink } = props;
  const [bot, setBot] = useState<BotState>(main.bot);
  // Свежие данные с сервера (панель опрашивает «Сегодня», бота могли выключить из Telegram)
  // перекрывают локальную копию: иначе тумблеры показывали бы устаревшее состояние.
  const { ai, frozen, comments, funnelsOn, funnelsPaused } = main.bot;
  useEffect(() => {
    setBot({ ai, frozen, comments, funnelsOn, funnelsPaused });
  }, [ai, frozen, comments, funnelsOn, funnelsPaused]);

  async function act(action: string, optimistic: Partial<BotState>) {
    const before = bot;
    setBot({ ...bot, ...optimistic });
    try {
      const r = await api<{ state: BotState }>("/admin/v1/bot-control", { method: "POST", body: { action } });
      setBot(r.state);
    } catch (e) {
      setBot(before);
      toast(e instanceof Error ? e.message : "Не удалось переключить", "error");
    }
  }

  return (
    <div className="main-block" data-testid="main-summary">
      <div className="main-money">
        <div className="main-money-label">Деньги сегодня</div>
        <div className="main-money-value">{money(main.money.today)}</div>
        <div className="main-money-sub">
          {main.money.salesToday} {plural(main.money.salesToday, "оплата", "оплаты", "оплат")} · за неделю {money(main.money.week)} ({main.money.salesWeek})
        </div>
        <div className="main-money-sub">
          Офлайн-курс: записей сегодня {main.offline.today}, за неделю {main.offline.week}
        </div>
      </div>

      <button type="button" className="btn wide today-action main-link" onClick={onGetLink}>
        Получить ссылку
      </button>
      <p className="hint main-link-hint">Ссылка на уроки в Telegram-группу или на сайт (без Telegram). Покажется здесь — перешлёте сами, куда удобно.</p>

      <div className="main-events" aria-label="Что происходит">
        <h3 className="today-title">Что происходит</h3>
        {main.recent.length === 0 ? (
          <p className="today-sub">Пока тихо: новых оплат и записей нет.</p>
        ) : (
          <ul className="main-events-list">
            {main.recent.map((e) => (
              <li key={`${e.kind}:${e.who}:${e.at}`}>
                <span aria-hidden="true">{e.kind === "payment" ? "💰" : "📝"}</span> <b>{e.who}</b> — {e.what}
                <span className="main-events-time"> · {timeAgo(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {main.pendingReceipts > 0 && (
          <p className="today-sub">Чеков, которые бот не смог проверить: {main.pendingReceipts} — ниже, в «Чеки на проверку».</p>
        )}
      </div>

      <div className="main-bot">
        <Switch
          checked={bot.ai}
          onChange={(next) => void act(next ? "ai_on" : "ai_off", { ai: next })}
          label="Бот отвечает людям"
          hint="Выключите — он замолчит в личных сообщениях; автосообщения с рилсов продолжат работать."
          testId="switch-bot-ai"
        />
        <Switch
          checked={!bot.frozen}
          onChange={(next) => void act(next ? "freeze_off" : "freeze_on", { frozen: !next })}
          label="Бот работает полностью"
          hint="Выключите — пауза «всё, кроме воронки»: бот не выдаёт ссылки и не напоминает."
          testId="switch-bot-freeze"
        />
      </div>
    </div>
  );
}
