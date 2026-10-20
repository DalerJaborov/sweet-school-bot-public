/**
 * РАЗБОР СТРАНИЦЫ CLOUDFLARE, ВСТАВЛЕННОЙ ЦЕЛИКОМ.
 *
 * Владелец 03.09.2026: «с Cloudflare не получилось, не понял что куда
 * копировать». И это не его вина. Чтобы подключить хранилище, надо было найти
 * на чужой англоязычной странице несколько разных кусков, скопировать каждый по
 * отдельности и не перепутать поля — несколько шансов ошибиться там, где ошибка
 * ничего внятного не скажет, просто видео не загрузится.
 *
 * Поэтому здесь принимается ВЕСЬ текст страницы разом: выделить всё, скопировать,
 * вставить. Куски находим сами — они опознаются по виду, а не по подписи рядом:
 *
 *   • ключ доступа   — 32 шестнадцатеричных знака;
 *   • секретный ключ — 64 шестнадцатеричных знака;
 *   • адрес          — https://<32 знака>.r2.cloudflarestorage.com.
 *
 * Опознание по длине надёжнее, чем по соседней подписи: подписи Cloudflare
 * переводит и меняет местами, а длина ключа задана самим протоколом S3.
 *
 * ИМЯ БАКЕТА ЗДЕСЬ НЕ ИЩЕТСЯ — НАРОЧНО. Сначала искалось, по строке вида
 * «Bucket: имя», и подвело в первый же живой прогон (03.09.2026): на странице
 * стояло «Specify bucket(s)», в настройку уехало слово «buckets», и хранилище
 * стало отвечать «NoSuchBucket» при совершенно верных ключах — по такой ошибке
 * не догадаться, что дело в имени. Имя бакета — единственное, что можно узнать
 * точно, а не угадать: о нём спрашивают само хранилище (s3.ts listBuckets).
 *
 * ВАЖНО: наружу отсюда не возвращается ни одного секретного знака — только
 * «нашли/не нашли». Ключ идёт из буфера обмена владельца прямо в его же базу.
 */

export type ParsedCredentials = {
  endpoint?: string;
  accessKeyId?: string;
  secretKey?: string;
};

/** Что удалось найти — без самих значений, для показа человеку. */
export type ParseSummary = {
  endpoint: boolean;
  accessKeyId: boolean;
  secretKey: boolean;
};

const ENDPOINT_RE = /https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com/i;
/** Ровно 64 знака: границы обязательны, иначе внутри секрета нашёлся бы и «ключ доступа». */
const SECRET_RE = /(?<![0-9a-z])[0-9a-f]{64}(?![0-9a-z])/i;
const ACCESS_RE = /(?<![0-9a-z])[0-9a-f]{32}(?![0-9a-z])/i;

export function parsePastedCredentials(raw: string): ParsedCredentials {
  const text = raw.slice(0, 20_000);
  const out: ParsedCredentials = {};

  const endpoint = ENDPOINT_RE.exec(text)?.[0];
  if (endpoint) out.endpoint = endpoint.toLowerCase();

  const secret = SECRET_RE.exec(text)?.[0];
  if (secret) out.secretKey = secret.toLowerCase();

  // Ключ доступа ищем в тексте БЕЗ адреса и БЕЗ секрета: в адресе тоже стоят
  // ровно 32 знака (идентификатор аккаунта), и без этой чистки в поле ключа
  // легко уехал бы кусок ссылки. Ошибка была бы тихой: хранилище просто
  // отвечало бы «доступ запрещён», ничего не объясняя.
  let rest = text;
  if (endpoint) rest = rest.split(endpoint).join(" ");
  if (secret) rest = rest.split(secret).join(" ");
  const access = ACCESS_RE.exec(rest)?.[0];
  if (access) out.accessKeyId = access.toLowerCase();

  return out;
}

export function summarize(parsed: ParsedCredentials): ParseSummary {
  return {
    endpoint: Boolean(parsed.endpoint),
    accessKeyId: Boolean(parsed.accessKeyId),
    secretKey: Boolean(parsed.secretKey),
  };
}

/** Чего не хватает — человеческим языком, чтобы было понятно, что переделать. */
export function missingParts(parsed: ParsedCredentials): string[] {
  const missing: string[] = [];
  if (!parsed.endpoint) missing.push("адрес хранилища");
  if (!parsed.accessKeyId) missing.push("ключ доступа");
  if (!parsed.secretKey) missing.push("секретный ключ");
  return missing;
}
