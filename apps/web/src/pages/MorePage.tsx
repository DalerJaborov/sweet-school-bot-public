import { Icons } from "../components/Brand";
import { BehaviorSwitches } from "../components/BehaviorSwitches";
import { NotificationSwitches } from "../components/NotificationSwitches";
import { InstallApp } from "../components/InstallApp";
import { Switch } from "../components/Switch";
import { MORE_SECTIONS, type Tab } from "../panel/nav";
import {
  setShowEscalations,
  setSimpleMode,
  setTheme,
  useShowEscalations,
  useSimpleMode,
  useTheme,
} from "../panel/prefs";

/**
 * «ЕЩЁ» — всё, что не нужно каждый день. Сгруппировано по смыслу:
 * «Режим» (простой вид и тема), «Разделы», «Для опытных» (редкое и настроечное),
 * «Установить на телефон», «Выйти». В режиме сестры разделов нет вовсе —
 * остаются только вид, установка и выход.
 */
export function MorePage(props: { onGo: (tab: Tab) => void; onLogout: () => void }) {
  const { onGo, onLogout } = props;
  const simple = useSimpleMode();
  const theme = useTheme();
  const showEscalations = useShowEscalations();
  const main = MORE_SECTIONS.filter((s) => s.group === "main");
  const expert = MORE_SECTIONS.filter((s) => s.group === "expert");

  return (
    <>
      <section className="card" aria-labelledby="more-title">
        <h2 id="more-title">{Icons.more} Ещё</h2>
        <p className="hint">Здесь то, что нужно не каждый день.</p>

        <div className="more-group" role="group" aria-label="Вид">
          <Switch
            checked={simple}
            onChange={setSimpleMode}
            label="Режим сестры"
            hint="Остаются только Сегодня, Чеки и Клиенты. Всё лишнее спрятано."
            testId="switch-simple"
          />
          <Switch
            checked={showEscalations}
            onChange={setShowEscalations}
            label="Показывать клиентов, которым нужен ответ"
            hint="Только тех, кого помощник сам передал вам: просьба позвать Ширин или сбой. Обычные сообщения не показываются."
            testId="switch-escalations"
          />
          <Switch
            checked={theme === "dark"}
            onChange={(on) => setTheme(on ? "dark" : "light")}
            label="Тёмный вид"
            hint="Мягче для глаз вечером."
            testId="switch-dark"
          />
        </div>
      </section>

      {!simple && (
        <section className="card" aria-label="Разделы">
          <h3 className="more-title">Разделы</h3>
          <div className="more-list">
            {main.map((s) => (
              <MoreItem key={s.id} label={s.label} about={s.about} onClick={() => onGo(s.id)} />
            ))}
          </div>
          <details className="more-expert">
            <summary>Для опытных</summary>
            <p className="hint">Редкие и настроечные разделы. Если не уверены — сюда можно не заходить.</p>
            <BehaviorSwitches />
            <div className="more-list">
              {expert.map((s) => (
                <MoreItem key={s.id} label={s.label} about={s.about} onClick={() => onGo(s.id)} />
              ))}
            </div>
          </details>
        </section>
      )}

      <section className="card" aria-label="Уведомления">
        <h3 className="more-title">Уведомления в Telegram</h3>
        <p className="hint">Бот пишет редко: оплаты, записи на офлайн, итог дня и серьёзные сбои. Всё это можно выключить.</p>
        <NotificationSwitches />
      </section>

      <section className="card" aria-label="Приложение">
        <h3 className="more-title">Приложение на телефоне</h3>
        <InstallApp />
      </section>

      <section className="card">
        <button type="button" className="btn quiet wide" onClick={onLogout}>
          <span className="btn-icon">{Icons.exit}</span>
          Выйти из панели
        </button>
      </section>
    </>
  );
}

function MoreItem(props: { label: string; about: string; onClick: () => void }) {
  return (
    <button type="button" className="more-item" onClick={props.onClick}>
      <span className="more-item-text">
        <b>{props.label}</b>
        <span>{props.about}</span>
      </span>
      <span className="more-item-arrow" aria-hidden="true">
        {Icons.arrow}
      </span>
    </button>
  );
}
