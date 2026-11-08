import { useEffect, useState } from "react";
import { loadSchoolContacts, type SchoolContacts } from "../api";
import { Illustration } from "../components/Illustration";
import type { LinkExpiredState } from "../hooks/useCourse";
import type { Dict } from "../i18n";

/**
 * ССЫЛКА УСТАРЕЛА — НЕ ТУПИК (аудит пути ученицы 08.11.2026).
 *
 * Ссылка из директа живёт неделю. Раньше ученица, открывшая её на восьмой день
 * в новом браузере, видела «Ссылка недействительна» и кнопку «Попробовать
 * снова», которая ничего не меняла. Теперь одна главная кнопка — «Получить
 * новую ссылку»: сервер сам отправляет её в переписку (Instagram, WhatsApp,
 * чат сайта), без хозяйки. Ссылку на экран мы не выводим намеренно: старую
 * могли переслать подруге.
 *
 * Экран по правилу владельца: 1 заголовок + 1 строка + главная кнопка. Исход
 * меняет слова и кнопку, а не добавляет блоки:
 *   sent        → «уже у вас» + «Открыть переписку»;
 *   write_first → Instagram не даёт писать первыми через сутки: «напишите нам»;
 *   escalated   → «передали Ширин» + «Написать нам»;
 *   revoked / unknown → честно, куда идти дальше.
 * Живая сессия до сюда не доходит: её сервер сам пускает в кабинет.
 */
export function LinkExpiredScreen({
  t,
  state,
  onRequest,
}: {
  t: Dict;
  state: LinkExpiredState;
  onRequest: () => void;
}) {
  const [fetched, setFetched] = useState<SchoolContacts | null>(null);
  useEffect(() => {
    if (state.school) return;
    let alive = true;
    void loadSchoolContacts().then((c) => {
      if (alive && c) setFetched(c);
    });
    return () => {
      alive = false;
    };
  }, [state.school]);
  const school = state.school ?? fetched;
  const channel = state.result?.channel ?? null;
  const outcome = state.result?.outcome ?? null;

  // Куда писать: в тот же канал, откуда человек покупал; иначе любой живой.
  const writeUrl = chatUrl(school, channel, outcome === "write_first" ? t.linkAskText : null);

  const view =
    outcome === "sent"
      ? { title: t.linkSentTitle, text: t.linkSentText, label: t.openChat, href: chatUrl(school, channel, null) }
      : outcome === "write_first"
        ? { title: t.linkWriteFirstTitle, text: t.linkWriteFirstText, label: t.writeUs, href: writeUrl }
        : outcome === "escalated"
          ? { title: t.linkEscalatedTitle, text: t.linkEscalatedText, label: t.writeUs, href: writeUrl }
          : outcome === "revoked"
            ? { title: t.linkRevokedTitle, text: t.help.revoked, label: t.writeUs, href: writeUrl }
            : outcome === "unknown"
              ? { title: t.linkReplacedTitle, text: t.linkReplacedText, label: t.writeUs, href: writeUrl }
              : null;

  return (
    <div className="center" role="alert" aria-live="polite">
      <Illustration kind="empty" />
      {view ? (
        <>
          <h1>{view.title}</h1>
          <p>{view.text}</p>
          {view.href && (
            <a className="btn btn-big" href={view.href} target="_blank" rel="noreferrer noopener">
              {view.label}
            </a>
          )}
        </>
      ) : (
        <>
          <h1>{t.linkExpiredTitle}</h1>
          <p>{state.failed ? t.linkRequestFailed : t.linkExpiredText}</p>
          <button type="button" className="btn btn-big" onClick={onRequest} disabled={state.busy}>
            {state.busy ? t.gettingLink : t.getNewLink}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Адрес переписки со школой. WhatsApp — с готовой фразой, если она нужна
 * (по ней бот сам пришлёт ссылку); в Instagram текст заранее не вставить.
 * Экспортирована для теста.
 */
export function chatUrl(school: SchoolContacts | null, channel: string | null, text: string | null): string | null {
  // Купившую через чат сайта в чат сайта НЕ ведём (ревью PR 59): он привязан к
  // старому браузеру, в новом пуст. Её ссылку шлёт хозяйка — значит, писать
  // хозяйке туда, где она отвечает: WhatsApp, затем Instagram.
  if (!school) return null;
  const wa = school.whatsapp
    ? text
      ? `${school.whatsapp}${school.whatsapp.includes("?") ? "&" : "?"}text=${encodeURIComponent(text)}`
      : school.whatsapp
    : null;
  if (channel === "WHATSAPP" || channel === "WEB") return wa ?? school.instagram ?? school.telegram;
  return school.instagram ?? wa ?? school.telegram;
}
