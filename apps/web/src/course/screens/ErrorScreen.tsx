import { useEffect, useState } from "react";
import { loadSchoolContacts, type SchoolContacts } from "../api";
import { ContactsBlock } from "../components/ContactsBlock";
import { Illustration } from "../components/Illustration";
import type { CourseErrorState } from "../hooks/useCourse";
import type { Dict } from "../i18n";

/**
 * Экраны отказа отличаются подсказкой: «нет места на устройствах» и «доступ
 * закрыт» требуют разных действий от человека, и общая ошибка тут вредна.
 * Сетевую ошибку описываем сами (сервер до нас не дотянулся), остальные —
 * словами сервера плюс подсказка на языке ученицы.
 *
 * ВХОД, А НЕ ТУПИК (ревью 05.09.2026). Раньше здесь была одна кнопка
 * «Попробовать снова». Но сюда попадают двое: непокупательница по кнопке
 * «Мои уроки» с сайта — ей нужен «Купить курс»; и ученица, у которой ссылка
 * умерла (почистила телефон, переслали новую) — ей нужна Ширин, причём в
 * WhatsApp уже с готовой фразой «ссылка не открывается»: восстановление по
 * этим словам делает бот сам (apps/api/src/course/recovery.ts). Контакты без
 * сессии отдаёт публичный /api/course/contacts; их нет — остаётся «Купить».
 */
export function ErrorScreen({
  t,
  error,
  onRetry,
  school,
}: {
  t: Dict;
  error: CourseErrorState;
  onRetry: () => void;
  /** Контакты из уже загруженного /me, если они есть; иначе спросим сами. */
  school?: SchoolContacts | null;
}) {
  const title = error.reason === "network" || !error.message ? t.networkError : error.message;
  const help = t.help[error.reason];
  const [fetched, setFetched] = useState<SchoolContacts | null>(null);
  useEffect(() => {
    if (school) return;
    let alive = true;
    void loadSchoolContacts().then((c) => {
      if (alive && c) setFetched(c);
    });
    return () => {
      alive = false;
    };
  }, [school]);

  const contacts = withPrefilledWhatsapp(school ?? fetched, error.reason === "not_found" ? t.linkBrokenWa : null);

  return (
    <div className="center" role="alert">
      <Illustration kind="empty" />
      <h1>{title}</h1>
      {help && <p>{help}</p>}
      <button type="button" className="btn" onClick={onRetry}>
        {t.retry}
      </button>
      <a className="btn ghost" href={t.buyCourseUrl}>
        {t.buyCourse}
      </a>
      {contacts && <ContactsBlock t={t} school={contacts} />}
    </div>
  );
}

/** Ссылка WhatsApp с готовым текстом — человек не подбирает слова. */
function withPrefilledWhatsapp(school: SchoolContacts | null, text: string | null): SchoolContacts | null {
  if (!school) return null;
  if (!text || !school.whatsapp) return school;
  const joiner = school.whatsapp.includes("?") ? "&" : "?";
  return { ...school, whatsapp: `${school.whatsapp}${joiner}text=${encodeURIComponent(text)}` };
}
