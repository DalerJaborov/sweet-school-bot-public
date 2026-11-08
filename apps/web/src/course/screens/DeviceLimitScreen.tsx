import { useEffect, useState } from "react";
import { ContactsBlock } from "../components/ContactsBlock";
import type { DeviceLimitState } from "../hooks/useCourse";
import type { Dict } from "../i18n";
import { loadSchoolContacts, storedRecoveryCode, type SchoolContacts } from "../api";

/**
 * КУРС ОТКРЫТ НА ДРУГОМ ТЕЛЕФОНЕ (политика «один телефон», 08.11.2026).
 * Один телефон — любые его браузеры; на втором телефоне курс не открывается, и
 * кнопок «перенести» и «купить» здесь нет: второй телефон — отдельный доступ на
 * другой аккаунт или номер (пишут Ширин). Смена своего телефона — главная
 * кнопка «написать в чат» с готовым текстом и публичным кодом из ссылки: бот
 * проверяет по базе и сам открывает (раз в 30 дней, старая ссылка аннулируется).
 */
export function DeviceLimitScreen({ t, limit }: { t: Dict; limit: DeviceLimitState }) {
  const [fetched, setFetched] = useState<SchoolContacts | null>(null);
  useEffect(() => {
    if (limit.school) return;
    let alive = true;
    void Promise.resolve()
      .then(() => loadSchoolContacts())
      .then((c) => {
        if (alive && c) setFetched(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [limit.school]);

  const school = limit.school ?? fetched;
  const code = storedRecoveryCode();
  const text = code ? `${t.deviceLimitWa}. ${t.linkBrokenCode}: ${code}` : t.deviceLimitWa;
  const chatUrl = school?.whatsapp
    ? `${school.whatsapp}${school.whatsapp.includes("?") ? "&" : "?"}text=${encodeURIComponent(text)}`
    : null;

  return (
    <div className="center devices-screen" role="alert">
      <h1>{t.deviceLimitTitle}</h1>
      <p>{t.deviceLimitText(limit.phone)}</p>
      <p className="muted">{t.deviceLimitChanged}</p>
      {chatUrl && (
        <a className="btn btn-big" href={chatUrl}>
          {t.deviceLimitWrite}
        </a>
      )}
      {school && <ContactsBlock t={t} school={school} />}
    </div>
  );
}
