/**
 * «ПОСМОТРЕТЬ КАК УЧЕНИЦА» — режим предпросмотра приложения ученицы.
 *
 * Владелец нажимает кнопку в панели и попадает в это же приложение по адресу
 * /course?preview=<билет>. Билет одноразовый: приложение меняет его на куку
 * предпросмотра (сервер, course/preview.ts) и сразу убирает из адреса — дальше
 * режим держится на /course?mode=preview, а перезагрузка страницы его не теряет.
 *
 * В этом режиме приложение ТОЛЬКО ПОКАЗЫВАЕТ: прогресс, вопросы в чат, имя,
 * сертификат и сохранение уроков в телефон выключены, а в хранилище браузера
 * ничего не пишется — иначе предпросмотр смешался бы с данными настоящей
 * ученицы на этом же телефоне.
 */

const LANG_KEY = "ssb_preview_lang";

function params(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

/** Приложение открыто как предпросмотр владельца. */
export function isPreview(): boolean {
  const p = params();
  return p.get("mode") === "preview" || p.has("preview");
}

/** Одноразовый билет из адреса — только при первом открытии. */
export function previewTicket(): string | null {
  return params().get("preview");
}

/** Убрать билет из адреса: он одноразовый и не должен жить в истории. */
export function forgetPreviewTicket(): void {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?mode=preview`);
}

/** Язык предпросмотра — только в этой вкладке, у ученицы он хранится на сервере. */
export function previewLang(): "ru" | "tg" {
  try {
    return window.sessionStorage.getItem(LANG_KEY) === "ru" ? "ru" : "tg";
  } catch {
    return "tg";
  }
}

export function setPreviewLang(lang: "ru" | "tg"): void {
  try {
    window.sessionStorage.setItem(LANG_KEY, lang);
  } catch {
    // Приватный режим — язык просто не переживёт перезагрузку.
  }
}
