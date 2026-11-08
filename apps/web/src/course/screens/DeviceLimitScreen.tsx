import { ContactsBlock } from "../components/ContactsBlock";
import type { DeviceLimitState } from "../hooks/useCourse";
import type { Dict } from "../i18n";

/**
 * КУРС ОТКРЫТ НА ДРУГОМ ТЕЛЕФОНЕ (политика «один телефон», 08.11.2026).
 * Один телефон — любые его браузеры; на втором телефоне курс не открывается, и
 * кнопки «перенести» здесь нет: для другого телефона курс покупается отдельно.
 * Настоящая смена телефона идёт только через бота в чате покупки (с
 * доказательством, раз в 30 дней), поэтому экран лишь подсказывает, куда писать.
 */
export function DeviceLimitScreen({ t, limit }: { t: Dict; limit: DeviceLimitState }) {
  return (
    <div className="center devices-screen" role="alert">
      <h1>{t.deviceLimitTitle}</h1>
      <p>{t.deviceLimitText(limit.phone)}</p>
      <a className="btn btn-big" href={`${t.buyCourseUrl}#kupit`}>
        {t.deviceLimitBuy}
      </a>
      <p className="muted">{t.deviceLimitChanged}</p>
      {limit.school && <ContactsBlock t={t} school={limit.school} />}
    </div>
  );
}
