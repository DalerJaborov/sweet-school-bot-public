/**
 * Нужны ли запросу куки сессии.
 *
 * Куки нужны только нашему серверу (манифест, ключ, прогресс). Сегменты видео
 * и фото рецептов идут подписанными ссылками прямо из хранилища (R2), и оно
 * отвечает `Access-Control-Allow-Origin: <наш сайт>` без
 * `Access-Control-Allow-Credentials`. Запрос в хранилище «с куками» браузер
 * поэтому блокирует целиком — на Android (hls.js) урок крутил спиннер вечно,
 * найдено 16.11.2026 по жалобам учениц. Подпись в ссылке и так даёт доступ,
 * куки там не нужны.
 */
export function isSameOrigin(url: string, base: string = globalThis.location?.href ?? "http://localhost/"): boolean {
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** `credentials` для fetch: свои куки только своему серверу. */
export function credentialsFor(url: string, base?: string): RequestCredentials {
  return isSameOrigin(url, base) ? "include" : "omit";
}
