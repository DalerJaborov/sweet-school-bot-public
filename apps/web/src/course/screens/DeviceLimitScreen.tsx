import { ContactsBlock } from "../components/ContactsBlock";
import type { DeviceLimitState } from "../hooks/useCourse";
import { formatLastSeen, type Dict } from "../i18n";

/**
 * ЛИМИТ УСТРОЙСТВ (дизайн доступа 03.09.2026). Раньше 429 был тупиком с
 * подсказкой «напишите нам» — а самый частый случай простой: человек сменил
 * телефон. Показываем, что занято, и даём заменить самое старое одним
 * нажатием, пока сервер разрешает замены (swapsLeft). Кончились — остаётся
 * написать школе; контакты берём из сохранённого /me, если он есть.
 */
export function DeviceLimitScreen({
  t,
  limit,
  onReplace,
}: {
  t: Dict;
  limit: DeviceLimitState;
  onReplace: () => void;
}) {
  const canSwap = limit.swapsLeft > 0;
  return (
    <div className="center devices-screen" role="alert">
      <h1>{t.deviceLimitTitle}</h1>
      <p>{t.deviceLimitText(limit.devices.length)}</p>
      <ul className="devices">
        {limit.devices.map((d) => {
          const seen = formatLastSeen(d.lastSeenAt, t);
          return (
            <li key={d.id} className="device">
              <span className="device-icon" aria-hidden="true">
                <DeviceGlyph label={d.label} />
              </span>
              <span className="device-body">
                <span className="device-title">
                  {t.deviceLabel(d.label)}
                  {d.city ? ` · ${d.city}` : ""}
                </span>
                <span className="device-sub">
                  {seen && t.deviceLastSeen(seen)}
                  {d.blocked && <span className="chip chip-danger">{t.deviceBlocked}</span>}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {canSwap ? (
        <>
          <button type="button" className="btn btn-big" onClick={onReplace} disabled={limit.busy}>
            {t.replaceOldest}
          </button>
          <p className="muted">{t.swapsLeft(limit.swapsLeft)}</p>
        </>
      ) : (
        <>
          <p>{t.noSwapsLeft}</p>
          {limit.school ? (
            <ContactsBlock t={t} school={limit.school} />
          ) : (
            <p className="muted">{t.help.device_limit}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Телефон или монитор — по подписи сервера; неизвестное — телефон. */
function DeviceGlyph({ label }: { label: string }) {
  // Подписи сервера по-русски, сравнивать их тут нельзя (i18n-тест); телефон
  // узнаём по латинским «iPhone»/«Android», всё остальное рисуем монитором.
  const desktop = !/iphone|android|phone/i.test(label);
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 };
  if (desktop) {
    return (
      <svg {...common} aria-hidden="true" focusable="false">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true" focusable="false">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18h2" strokeLinecap="round" />
    </svg>
  );
}
