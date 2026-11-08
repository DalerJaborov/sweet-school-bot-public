import crypto from "node:crypto";
import { courseTokenSecret, courseVerifySecrets } from "./tokenSecret.js";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { prisma, getSetting, logError, logInfo } from "../db.js";
import { techChatIds, sendTelegramMessage } from "../telegram.js";
import { shouldSendAlert } from "../alertGate.js";
import type { Device, Purchase, Contact } from "@prisma/client";

/**
 * ВХОД НА ПЛАТФОРМУ БЕЗ ПАРОЛЯ (magic link) И ПРИВЯЗКА К УСТРОЙСТВУ.
 *
 * Логина и регистрации нет намеренно: ученица получает ссылку в директе сразу
 * после оплаты и открывает её пальцем. Пароль здесь был бы третьей вещью,
 * которую надо помнить, после Instagram и Telegram — а половина аудитории
 * пришла именно потому, что с Telegram не справилась.
 *
 * Защита строится не на секретности ссылки (её могут переслать), а на
 * устройстве: первое открытие привязывает браузер, дальше пускают только
 * знакомые. Больше Course.deviceLimit устройств — стоп и предложение написать
 * владельцу. Вход из двух далёких мест почти одновременно — блокировка и
 * тревога владельцу: так выглядит проданный доступ, а не забывчивая ученица.
 */

/** Сколько живёт ссылка ДО первого открытия. Дальше доступ держится на
 *  устройстве, и срок ссылки уже ничего не значит. Неделя — с запасом на
 *  «оплатила вечером, открыла в выходные». */
export const LINK_TTL_DAYS = 7;
/** Сколько живёт сессия устройства в куке. Год: это не банк, а курс, который
 *  куплен навсегда; повторный вход по ссылке из переписки всегда доступен. */
const SESSION_TTL_DAYS = 365;
/** На сколько продлевается право открывать СКАЧАННЫЕ уроки при выходе в сеть. */
export const OFFLINE_KEY_DAYS = 30;
/** Как часто отмечаем устройство «живым» в базе (см. currentAccess). */
const TOUCH_INTERVAL_MS = 10 * 60_000;

const SESSION_COOKIE = "ssb_course";
/** Метка устройства, выданная СЕРВЕРОМ. См. registerDevice: именно она, а не
 *  присланный браузером отпечаток, решает, знакомо ли нам это устройство. */
const DEVICE_COOKIE = "ssb_device";

/**
 * ССЫЛКА И СЕССИЯ ПРИНАДЛЕЖАТ ЧЕЛОВЕКУ, А НЕ ПОКУПКЕ (владелец 03.09.2026).
 *
 * Раньше ссылка выдавалась на покупку: купившая оба курса получала две ссылки
 * и два окна, а докупившая второй курс — новую ссылку, которую ещё надо было
 * найти в переписке. Теперь у человека одна ссылка, внутри — все оплаченные
 * курсы, и докупленный появляется в том же окне сам.
 *
 * `purchaseId` в claims оставлен как НАСЛЕДИЕ: ссылки и сессии, выданные до
 * этой правки, продолжают работать — по покупке находим человека. Выкинуть их
 * значило бы выгнать учениц посреди урока.
 */
type LinkClaims = { kind: "course-link"; contactId?: string; purchaseId?: string; jti: string };
type SessionClaims = { kind: "course-session"; contactId?: string; purchaseId?: string; deviceId: string };

/** Алфавит короткого кода: без 0/O, 1/l/I — их путают, диктуя по телефону. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
/** Сколько телефонов открывает курс (владелец 08.11.2026). */
export const ONE_PHONE_LIMIT = 1;

/** Случайный код ссылки. 54^10 ≈ 2·10^17 — перебирать бессмысленно. */
export function shortCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * ССЫЛКА — КОРОТКАЯ (владелец 03.09.2026: «не делай ключи такими длинными»).
 *
 * Раньше в адрес уходил JWT на триста знаков — в директе это выглядело как
 * мусор, а переслать такую ссылку голосом или по СМС невозможно. Теперь код
 * из десяти знаков живёт в базе (Contact.accessTokenId), а адрес — вида
 * https://домен/l/Ab3kQ9xZpm. Проверка — по базе, не по подписи: код и есть
 * ключ. Срок — тот же LINK_TTL_DAYS от accessIssuedAt.
 *
 * `token` оставлен для совместимости вызывающих: это тот же код.
 */
export function issueMagicLink(_contactId: string): { url: string; jti: string; token: string } {
  const code = shortCode();
  const base = env.publicBaseUrl || "";
  return { url: `${base}/l/${code}`, jti: code, token: code };
}

/** Это короткий код, а не JWT? */
export function looksLikeShortCode(token: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(token);
}

export function verifyMagicLink(token: string): LinkClaims | null {
  // Короткий код: личность найдём по базе в openByLink; jti — сам код.
  if (looksLikeShortCode(token)) return { kind: "course-link", jti: token };
  for (const secret of courseVerifySecrets()) {
    try {
      const claims = jwt.verify(token, secret) as LinkClaims;
      if (claims?.kind === "course-link" && (claims.contactId || claims.purchaseId) && claims.jti) return claims;
    } catch {
      // Не этим секретом — пробуем следующий (переход на отдельный секрет,
      // см. tokenSecret.ts). Ни один не подошёл — ссылка недействительна.
    }
  }
  return null;
}

function cookie(name: string, value: string): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_DAYS * 86400}`];
  // Secure только на https: на локальной машине по http кука с Secure не
  // сохранится вовсе, и разработка встанет.
  if ((env.publicBaseUrl || "").startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

function issueSession(res: Response, contactId: string, deviceId: string, deviceSecret: string): void {
  const token = jwt.sign({ kind: "course-session", contactId, deviceId } satisfies SessionClaims, courseTokenSecret(), {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
  // Две куки: сессия (кто и на каком устройстве) и метка самого устройства.
  // Метка переживает выход из сессии и повторное открытие ссылки — благодаря
  // ей человек, открывший курс заново, остаётся ТЕМ ЖЕ устройством, а не
  // занимает новое место в лимите.
  res.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, token), cookie(DEVICE_COOKIE, deviceSecret)]);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Отпечаток УСТРОЙСТВА, а не браузера.
 *
 * ВАЖНАЯ ПОПРАВКА. Сначала сюда подмешивалась строка User-Agent, и получалось,
 * что один телефон считается двумя разными устройствами: ссылка из директа
 * открывается во ВСТРОЕННОМ браузере Instagram, а смотреть человек уходит в
 * обычный Chrome. Живая ученица упиралась в лимит на своём единственном
 * телефоне — ровно тот случай, ради которого платформа и делалась.
 *
 * Поэтому берём только то, что описывает сам аппарат: разрешение экрана,
 * глубину цвета, часовой пояс, число ядер, платформу. Такой отпечаток
 * переживает смену браузера.
 *
 * Плата за это — «слипание»: два одинаковых телефона в одном часовом поясе
 * дадут один отпечаток. Это осознанный размен. Отпечаток сравнивается ТОЛЬКО
 * внутри одной покупки, поэтому слипание делает проверку мягче (два своих
 * телефона зачтутся как один), а не открывает чужим дверь. А мягкая ошибка
 * здесь дешевле жёсткой: заблокированная покупательница — это возврат денег и
 * испорченная репутация, лишнее устройство у своей же ученицы — мелочь,
 * которую всё равно ловят гео-тревога и отзыв доступа.
 *
 * Хэшируем: в базе не должно лежать ничего, что описывает человека напрямую.
 */
export function deviceFingerprint(req: Request, clientHint: string | undefined): string {
  // Платформу берём грубо (Android / iPhone / Windows), а не всю строку
  // User-Agent: версия браузера меняется сама и превратила бы знакомое
  // устройство в новое после ближайшего обновления.
  const ua = req.header("user-agent") ?? "";
  const platform = /android/i.test(ua)
    ? "android"
    : /iphone|ipad|ipod/i.test(ua)
      ? "ios"
      : /windows/i.test(ua)
        ? "windows"
        : /mac os/i.test(ua)
          ? "mac"
          : "other";
  return crypto
    .createHash("sha256")
    .update([clientHint ?? "", platform].join("|"))
    .digest("hex")
    .slice(0, 32);
}

/** Экспортирован: тот же адрес нужен лимитеру чата на сайте (site/router.ts). */
export function clientIp(req: Request): string | null {
  // За Cloudflare и nginx настоящий адрес приходит заголовком; req.ip покажет
  // адрес прокси и склеит всех учениц в одно «устройство по IP».
  const forwarded = req.header("cf-connecting-ip") ?? req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.ip || null;
}

/** Страна по данным Cloudflare, если запрос идёт через него. Это не геолокация
 *  ради слежки, а единственный дешёвый признак «ссылку открывают из двух
 *  стран разом». Нет заголовка — проверка молча пропускается. */
function clientCountry(req: Request): string | null {
  return req.header("cf-ipcountry") || null;
}

export type AccessResult =
  | {
      ok: true;
      contact: Contact;
      /** Все действующие покупки — по одной на курс. */
      purchases: Purchase[];
      /** Якорная (самая ранняя действующая) — для кода, которому нужна одна. */
      purchase: Purchase;
      device: Device;
    }
  | {
      ok: false;
      reason: "not_found" | "revoked" | "device_limit" | "blocked" | "no_session" | "offline_expired";
      message: string;
    };

/**
 * Действует ли ещё право открывать СКАЧАННЫЕ уроки.
 *
 * Проверка обязана стоять на выдаче ключа и списка сегментов. Раньше поле
 * offlineKeyExpiresAt писалось в трёх местах и не читалось НИ В ОДНОМ — то
 * есть обещание «через месяц офлайн-копия перестанет открываться» не
 * выполнялось вовсе: отозванный доступ продолжал играть в телефоне.
 *
 * Честная граница: уже скачанные шестнадцать байт ключа отобрать у чужого
 * телефона нельзя никакими средствами. Проверка гасит доступ у того, кто хоть
 * раз выйдет в сеть, и не даёт скачать НОВЫЕ уроки. Это ограничение записано в
 * документации как ограничение, а не как гарантия.
 */
export function offlineAllowed(device: Device): boolean {
  return Boolean(device.offlineKeyExpiresAt && device.offlineKeyExpiresAt.getTime() > Date.now());
}

/**
 * Открытие ссылки: находим покупку, регистрируем или узнаём устройство,
 * выдаём сессию. Здесь же продлевается офлайн-ключ.
 */
export async function openByLink(
  req: Request,
  res: Response,
  token: string,
  clientHint?: string
): Promise<AccessResult> {
  const claims = verifyMagicLink(token);
  if (!claims) {
    return { ok: false, reason: "not_found", message: "Ссылка недействительна или устарела" };
  }
  const resolved = await resolveOwner(claims);
  if (!resolved) return { ok: false, reason: "not_found", message: "Курс не найден" };
  const { contact, expectedJti } = resolved;
  // jti сверяем, чтобы старая ссылка перестала работать после перевыдачи
  // (например, доступ отозвали и вернули — прежняя ссылка не должна ожить).
  if (expectedJti && expectedJti !== claims.jti) {
    return { ok: false, reason: "not_found", message: "Ссылка устарела — попросите новую" };
  }
  const purchases = await activePurchases(contact.id);
  if (purchases.length === 0) {
    return { ok: false, reason: "revoked", message: "Доступ к курсу закрыт. Напишите нам, если это ошибка" };
  }

  const result = await registerDevice(req, contact, purchases, clientHint);
  if (!result.ok) return result;

  // Метка есть у всех устройств, созданных этим кодом. Старые записи (до
  // введения метки) её не имеют — выдаём при первом же входе, иначе такое
  // устройство навсегда осталось бы неопознаваемым и каждый раз занимало
  // новое место в лимите.
  const secret = result.device.secret ?? crypto.randomUUID();
  if (!result.device.secret) {
    await prisma.device
      .update({ where: { id: result.device.id }, data: { secret } })
      .catch((err) => logError("course:issueDeviceSecret", err));
  }
  issueSession(res, contact.id, result.device.id, secret);
  // Первое открытие отмечаем на всех действующих покупках разом: окно одно, и
  // «не открыла уроки» для второго курса означало бы ложное напоминание.
  await prisma.purchase.updateMany({
    where: { contactId: contact.id, revokedAt: null, firstOpenedAt: null },
    data: { firstOpenedAt: new Date() },
  });
  return result;
}

/**
 * Кому принадлежит токен. Новые несут contactId; старые — purchaseId, по
 * которому находим человека. jti для сверки берём там же, где он хранился при
 * выдаче: у новых — на контакте, у старых — на покупке.
 */
async function resolveOwner(
  claims: { contactId?: string; purchaseId?: string; jti?: string }
): Promise<{ contact: Contact; expectedJti: string | null } | null> {
  // Короткий код: контакт — тот, у кого этот код записан как действующий.
  // Код старше LINK_TTL_DAYS не пускает: как и JWT со сроком.
  if (!claims.contactId && !claims.purchaseId && claims.jti && looksLikeShortCode(claims.jti)) {
    const contact = await prisma.contact.findUnique({ where: { accessTokenId: claims.jti } });
    if (!contact) return null;
    const issued = contact.accessIssuedAt?.getTime() ?? 0;
    if (Date.now() - issued > LINK_TTL_DAYS * 86_400_000) return null;
    return { contact, expectedJti: contact.accessTokenId };
  }
  if (claims.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: claims.contactId } });
    return contact ? { contact, expectedJti: contact.accessTokenId } : null;
  }
  if (claims.purchaseId) {
    const purchase = await prisma.purchase.findUnique({ where: { id: claims.purchaseId } });
    if (!purchase) return null;
    const contact = await prisma.contact.findUnique({ where: { id: purchase.contactId } });
    // Новая выдача пишет jti на контакт — после неё старая ссылка на покупку
    // должна погаснуть, как и обещают «прошлая перестаёт работать» в /ссылка,
    // возврате доступа и самовосстановлении (ревью 03.09.2026).
    return contact ? { contact, expectedJti: contact.accessTokenId ?? purchase.accessTokenId } : null;
  }
  return null;
}

/** Действующие покупки человека, от ранней к поздней — якорная первая. */
export async function activePurchases(contactId: string): Promise<Purchase[]> {
  return prisma.purchase.findMany({ where: { contactId, revokedAt: null }, orderBy: { createdAt: "asc" } });
}

/** Покупка, которой принадлежит курс, или null — курс не куплен. */
export function purchaseFor(purchases: Purchase[], courseId: string | null | undefined): Purchase | null {
  if (!courseId) return null;
  return purchases.find((p) => p.courseId === courseId) ?? null;
}

/**
 * Лимит устройств покупки. ОДНО место на всю систему: recovery.ts раньше
 * считал по-своему (запас 3 против 2 здесь, и без заблокированных) — и
 * самовосстановление доступа не освобождало место, а бот бодро отвечал «вот
 * новая ссылка», по которой ученица упиралась в тот же отказ (разбор
 * безопасности 03.09.2026). Запас 3, как в схеме: браузер внутри Instagram
 * считается отдельным устройством.
 */
/**
 * ПОЛИТИКА «ОДИН ТЕЛЕФОН» (владелец 08.11.2026: «нельзя на двух устройствах;
 * один телефон — с него в любом браузере можно открывать, а с другого
 * телефона надо аннулировать старый телефон; максимум один раз в месяц»).
 *
 * Перенос на другой телефон = аннулирование старого: удаляются ВСЕ записи
 * устройств человека (а с ними сессии, метки и офлайн-ключи — сервер больше
 * не узнаёт ни один браузер старого телефона). Не чаще одного раза в 30 дней.
 */
export const MAX_DEVICE_SWAPS_PER_MONTH = 1;
export const SWAP_WINDOW_MS = 30 * 86_400_000;

/** Сколько переносов уже сделано в окне 30 дней. */
export function recentTransfers(contact: Pick<Contact, "deviceSwaps" | "deviceSwapAt">): number {
  const at = contact.deviceSwapAt?.getTime() ?? 0;
  return at > Date.now() - SWAP_WINDOW_MS ? (contact.deviceSwaps ?? 0) : 0;
}

/** Можно ли сейчас перенести доступ на другой телефон. */
export function canTransferNow(contact: Pick<Contact, "deviceSwaps" | "deviceSwapAt">): boolean {
  return recentTransfers(contact) < MAX_DEVICE_SWAPS_PER_MONTH;
}

/**
 * «ЭТО МОЙ НОВЫЙ ТЕЛЕФОН» — перенос доступа. Возвращает:
 *  - "transferred" — старые устройства удалены, месячный перенос потрачен;
 *  - "nothing" — переносить нечего (ничего не открывали), перенос НЕ тратится;
 *  - "limit" — в этом месяце перенос уже был, решает владелец.
 * Заблокированные владельцем устройства не удаляем: их блокировка — его решение.
 */
export async function transferToNewPhone(
  contact: Contact,
  includeBlocked = false
): Promise<"transferred" | "nothing" | "limit"> {
  if (!canTransferNow(contact)) return "limit";
  const old = await prisma.device.findMany({ where: { contactId: contact.id, ...(includeBlocked ? {} : { blockedAt: null }) }, select: { id: true } });
  if (old.length === 0) return "nothing";
  await prisma.device.deleteMany({ where: { id: { in: old.map((d) => d.id) } } });
  const used = recentTransfers(contact);
  await prisma.contact.update({
    where: { id: contact.id },
    data: { deviceSwaps: used + 1, deviceSwapAt: new Date() },
  });
  logInfo("course:deviceSwap", `контакт ${contact.id}: перенос на новый телефон, снято устройств: ${old.length}`);
  return "transferred";
}

/** Устройства человека для экрана «какое заменить» — без секретов. */
export async function listDevicesFor(contactId: string): Promise<
  { id: string; label: string; city: string | null; lastSeenAt: Date; blocked: boolean }[]
> {
  const devices = await prisma.device.findMany({ where: { contactId }, orderBy: { lastSeenAt: "asc" } });
  return devices.map((d) => ({
    id: d.id,
    label: describeDevice(d.userAgent),
    city: d.lastCity,
    lastSeenAt: d.lastSeenAt,
    blocked: Boolean(d.blockedAt),
  }));
}

/** «iPhone», «Android», «Компьютер» — понятнее, чем строка User-Agent. */
export function describeDevice(ua: string | null): string {
  if (!ua) return "Устройство";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone";
  if (/android/i.test(ua)) return "Android";
  if (/windows|mac os|linux/i.test(ua)) return "Компьютер";
  return "Устройство";
}

/**
 * Как назвать занятый телефон человеку: модель Android из User-Agent, «iPhone»
 * или null, если модель неизвестна (тогда в тексте «ваш основной телефон»).
 */
export function phoneLabel(ua: string | null | undefined): string | null {
  if (!ua) return null;
  if (/iphone|ipod/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua)) return "iPad";
  if (/android/i.test(ua)) {
    const m = /Android[^;)]*;\s*([^;)]+?)\s*(?:Build\/|[;)])/i.exec(ua);
    const model = m?.[1]?.trim();
    return model && model.length >= 3 && !/^(k|mobile|wv|linux)$/i.test(model) ? model : null;
  }
  return null;
}

/** Метка телефона, на котором курс открыт сейчас (последний заходивший). */
export async function occupiedPhoneLabel(contactId: string): Promise<string | null> {
  const rows = await prisma.device.findMany({ where: { contactId }, orderBy: { lastSeenAt: "desc" }, take: 1 });
  return phoneLabel(rows[0]?.userAgent);
}

/** Сообщение «курс открыт на другом телефоне» (русский запасной текст сервера). */
export function devicePhoneMessage(label: string | null): string {
  return `Этот курс открывается на ${label ? `телефоне ${label}` : "вашем основном телефоне"}. Чтобы смотреть на другом телефоне, купите курс для него`;
}

export async function deviceLimitFor(_contactId: string): Promise<number> {
  // Политика «один телефон» одна на всех. Столбец Course.deviceLimit больше не
  // читается: прежний «запас 2–3» как раз и позволял пользоваться вдвоём.
  return ONE_PHONE_LIMIT;
}

/** Занятые места. Заблокированные СЧИТАЮТСЯ: иначе блокировка освобождала бы место. */
export function deviceCountFor(contactId: string): Promise<number> {
  return prisma.device.count({ where: { contactId } });
}

/** Регистрация или узнавание устройства + продление офлайн-ключа. */
export async function registerDevice(
  req: Request,
  contact: Contact,
  purchases: Purchase[],
  clientHint?: string
): Promise<AccessResult> {
  const purchase = purchases[0];
  const fingerprint = deviceFingerprint(req, clientHint);
  const ip = clientIp(req);
  const country = clientCountry(req);
  const offlineKeyExpiresAt = new Date(Date.now() + OFFLINE_KEY_DAYS * 86_400_000);

  /**
   * УСТРОЙСТВО УЗНАЁТСЯ ПО НАШЕЙ МЕТКЕ, А НЕ ПО ОТПЕЧАТКУ БРАУЗЕРА.
   *
   * Отпечаток собирает и присылает сам клиент (apps/web/src/course/api.ts). На
   * этом строилась вся защита от раздачи — и обходилась она одной строкой:
   * покупательница смотрит своё значение в консоли, диктует подругам, и десять
   * человек считаются ОДНИМ устройством. Лимит не тратится, тревоги не будет,
   * в панели видно одно устройство. Зеркально: заблокированному устройству
   * достаточно поменять один символ, чтобы получить новый слот.
   *
   * Метку выдаём мы сами и кладём в httpOnly-куку — прочитать её из
   * JavaScript нельзя, подделать без нашего секрета тоже. Отпечаток остаётся,
   * но только как СВЕДЕНИЕ для владельца («похоже, тот же аппарат»), а не как
   * ключ.
   *
   * Плата: очистка данных браузера означает новое устройство. Это честно — мы
   * действительно больше не можем узнать этот телефон, — и покрыто
   * восстановлением доступа (course/recovery.ts), которое освобождает место.
   */
  const presented = readCookie(req, DEVICE_COOKIE);
  let known = presented ? await prisma.device.findFirst({ where: { contactId: contact.id, secret: presented } }) : null;

  /**
   * ТОТ ЖЕ ТЕЛЕФОН В ДРУГОМ БРАУЗЕРЕ. Ссылка из директа открывается во
   * встроенном браузере Instagram или Telegram, а смотреть человек уходит в
   * Chrome или Safari — куки у них разные, метки нет, и тот же аппарат занимал
   * бы второе место. Живой случай 03.09.2026: владелец за один вечер «занял»
   * три места одним телефоном и ноутбуком и упёрся в лимит. Отпечаток аппарата
   * (экран, ядра, платформа — без строки браузера) у обоих браузеров одинаков,
   * и внутри ОДНОГО человека этого достаточно, чтобы считать их одним
   * устройством: чужому это дверь не открывает, а своей ученице не мешает.
   * Метка этого устройства уедет в куку нового браузера ниже.
   */
  if (!known) {
    known = await prisma.device.findFirst({ where: { contactId: contact.id, fingerprint } });
  }

  if (known) {
    if (known.blockedAt) {
      return { ok: false, reason: "blocked", message: known.blockedReason || "Устройство заблокировано" };
    }
    await maybeAlertGeoAnomaly(contact, known, country);
    const device = await prisma.device.update({
      where: { id: known.id },
      data: {
        lastSeenAt: new Date(),
        lastIp: ip,
        lastCity: country ?? known.lastCity,
        // Отпечаток обновляем: браузер обновился, экран сменился. Он ни на что
        // не влияет, но помогает владельцу понять, тот же это аппарат или нет.
        fingerprint,
        offlineKeyExpiresAt,
      },
    });
    return { ok: true, contact, purchases, purchase, device };
  }

  const limit = await deviceLimitFor(contact.id);
  // Заблокированные СЧИТАЮТСЯ занятыми: иначе блокировка сама освобождала бы
  // место, и обойти лимит можно было бы, просто нарвавшись на блокировку.
  const used = await deviceCountFor(contact.id);

  // Место занято. Прежде чем отказать, выясняем, не тот ли это телефон в другом
  // браузере (см. samePhoneVerdict). Сомнительное НЕ блокируем — пускаем на
  // запись того же устройства и сообщаем владельцу.
  if (used >= limit) {
    const existing = await prisma.device.findMany({ where: { contactId: contact.id, blockedAt: null } });
    const sure = existing.find((d) => samePhoneVerdict(d, req, ip) === "same");
    const doubtful = sure ?? existing.find((d) => samePhoneVerdict(d, req, ip) === "unsure");
    if (doubtful) {
      // Уверенное совпадение — тихо, как будто ничего не произошло; только
      // сомнительное идёт владельцу сводкой.
      if (!sure) await alertUnsurePhone(contact, doubtful);
      const device = await prisma.device.update({
        where: { id: doubtful.id },
        data: { lastSeenAt: new Date(), lastIp: ip, lastCity: country ?? doubtful.lastCity, offlineKeyExpiresAt },
      });
      return { ok: true, contact, purchases, purchase, device };
    }
  }

  if (used >= limit) {
    // Второй телефон не пускаем и сами не переносим: смена телефона идёт только
    // через бота с доказательством (recovery.ts), а второй телефон — это
    // отдельная покупка (владелец 08.11.2026).
    logInfo("course:deviceLimit", `контакт ${contact.id}: попытка входа с другого телефона`);
    const label = await occupiedPhoneLabel(contact.id);
    return { ok: false, reason: "device_limit", message: devicePhoneMessage(label) };
  }

  const device = await prisma.device.create({
    data: {
      // Настоящая принадлежность — человек; якорная покупка остаётся на
      // переходный релиз, пока колонка purchaseId обязательна.
      contactId: contact.id,
      purchaseId: purchase.id,
      // Метка случайная и живёт только у нас и в куке этого браузера.
      secret: crypto.randomUUID(),
      fingerprint,
      userAgent: req.header("user-agent") ?? null,
      lastIp: ip,
      lastCity: country,
      offlineKeyExpiresAt,
    },
  });
  return { ok: true, contact, purchases, purchase, device };
}

/**
 * ТОТ ЖЕ ТЕЛЕФОН ИЛИ ДРУГОЙ — по тому, что реально видит сервер.
 *
 * Знакомое устройство уже узнаётся по метке в куке и по отпечатку аппарата
 * (экран, ядра, часовой пояс, платформа — см. deviceFingerprint). Сюда мы
 * попадаем, когда ни то ни другое не совпало и место занято. Чего у сервера
 * НЕТ: модели iPhone (в User-Agent её нет), стабильной модели Android (Chrome
 * режет её до «K»), постоянного IP (Wi-Fi и мобильная сеть меняют адрес).
 *
 * Правило:
 *  - другая ОС (Android / iOS / Windows / Mac) — "different", точно;
 *  - у обоих Android известна модель и она разная — "different";
 *  - модель Android совпала, а отпечаток нет, ЛИБО тот же сегмент сети (/24,
 *    /64 для IPv6), что при прошлом заходе, меньше 30 минут назад — "unsure":
 *    это похоже на тот же телефон в другом браузере или в другой сети. Не
 *    блокируем, а пускаем на то же устройство и сообщаем владельцу;
 *  - всё остальное — "different".
 */
export type PhoneVerdict = "same" | "unsure" | "different";
/** Тот же сегмент сети и заход не старше этого — один и тот же телефон. */
const SAME_NET_WINDOW_MS = 6 * 3_600_000;

function osFamily(ua: string | null | undefined): string {
  const u = ua ?? "";
  if (/android/i.test(u)) return "android";
  if (/iphone|ipad|ipod/i.test(u)) return "ios";
  if (/windows/i.test(u)) return "windows";
  if (/mac os/i.test(u)) return "mac";
  return "other";
}

/** Модель Android из User-Agent; «K», пустое и общие слова — неизвестна. */
export function androidModel(ua: string | null | undefined): string | null {
  const m = /Android[^;)]*;\s*([^;)]+?)\s*(?:Build\/|[;)])/i.exec(ua ?? "");
  const model = m?.[1]?.trim();
  if (!model || model.length < 3 || /^(k|mobile|wv|linux)$/i.test(model)) return null;
  return model.toLowerCase();
}

function subnetOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":");
  const parts = ip.split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : null;
}

export function samePhoneVerdict(
  known: Pick<Device, "userAgent" | "lastIp" | "lastSeenAt">,
  req: Request,
  ip: string | null
): PhoneVerdict {
  const ua = req.header("user-agent");
  if (osFamily(known.userAgent) !== osFamily(ua)) return "different";
  const a = androidModel(known.userAgent);
  const b = androidModel(ua);
  const net = subnetOf(ip);
  const sameNet = net !== null && net === subnetOf(known.lastIp);
  if (a && b) {
    if (a !== b) return "different";
    // Та же модель: в той же сети — тот же телефон; в другой (Wi-Fi и
    // мобильный интернет) — вероятно тот же, но сообщаем владельцу.
    return sameNet ? "same" : "unsure";
  }
  // Модель неизвестна (iPhone, Android с урезанным User-Agent): та же ОС и
  // та же сеть недавно — тот же телефон; иначе отпечаток аппарата уже не
  // совпал, и это другой телефон.
  const fresh = Date.now() - known.lastSeenAt.getTime() < SAME_NET_WINDOW_MS;
  // Не «same»: модель телефона неизвестна, значит это может быть и чужой
  // телефон в той же сети (дом, офис). Пускаем (сомнение = пускаем), владельцу сводка.
  return sameNet && fresh ? "unsure" : "different";
}

async function alertUnsurePhone(contact: Contact, device: Device): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0];
  if (!botToken || !chatId) return;
  if (!(await shouldSendAlert(`phone-unsure:${contact.id}`, { cooldownMs: 24 * 3_600_000 }))) return;
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  await sendTelegramMessage(
    botToken,
    chatId,
    `Возможно, второй телефон у ${who}: вход не по метке и не по отпечатку, но похож на то же устройство ` +
      `(${describeDevice(device.userAgent)}, ${device.lastCity ?? "страна неизвестна"}). Пустили без блокировки. ` +
      `Если это не она, заблокируйте устройство в панели.`
  ).catch((err) => logError("course:unsurePhoneAlert", err));
}

/**
 * Одна и та же покупка открылась из другой страны меньше чем за час — так
 * выглядит переданная ссылка, а не переезд. Не блокируем автоматически (ученица
 * могла включить VPN, а из России без него половина сайтов не работает), но
 * владелец должен об этом узнать и решить сам.
 */
const GEO_WINDOW_MS = 60 * 60_000;

async function maybeAlertGeoAnomaly(contact: Contact, device: Device, country: string | null): Promise<void> {
  if (!country || !device.lastCity || device.lastCity === country) return;
  if (Date.now() - device.lastSeenAt.getTime() > GEO_WINDOW_MS) return;

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0]; // личный чат владельца, иначе чат сводок (telegram.ts)
  if (!botToken || !chatId) return;
  // Один и тот же покупатель — не чаще раза в сутки (08.11.2026).
  if (!(await shouldSendAlert(`geo:${contact.id}`, { cooldownMs: 24 * 3_600_000 }))) return;

  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  await sendTelegramMessage(
    botToken,
    chatId,
    `👀 Курс ${who} открыли из ${device.lastCity} и ${country} почти одновременно.\n` +
      `Похоже, ссылку передали. Отобрать доступ можно в панели, раздел «Клиенты».`
  ).catch((err) => logError("course:geoAlert", err));
}

/**
 * PAIR-ТОКЕН — ВХОД УСТАНОВЛЕННОГО ПРИЛОЖЕНИЯ БЕЗ ССЫЛКИ (дизайн PWA 03.09.2026).
 *
 * На iPhone приложение с экрана «Домой» живёт в отдельном хранилище: куки
 * Safari ему недоступны, а ссылку из директа iOS всё равно откроет в Safari.
 * Единственный канал через эту границу — адрес, с которого приложение
 * стартует. Поэтому манифест отдаётся с персональным start_url, куда вшит
 * pair-токен, привязанный к КОНКРЕТНОМУ устройству: приложение обменивает его
 * на те же куки для того же Device и не занимает второго места.
 *
 * Отзыв: заблокировали устройство — 403; ротировали секрет устройства —
 * токен мёртв (sv не совпадает); отобрали доступ — 403 revoked.
 */
type PairClaims = { kind: "course-pair"; contactId: string; deviceId: string; sv: string };

function secretStamp(secret: string | null): string {
  return crypto.createHash("sha256").update(secret ?? "").digest("hex").slice(0, 16);
}

export function issuePairToken(contactId: string, device: Device): string {
  return jwt.sign(
    { kind: "course-pair", contactId, deviceId: device.id, sv: secretStamp(device.secret) } satisfies PairClaims,
    courseTokenSecret(),
    { expiresIn: "365d" }
  );
}

export async function pairDevice(req: Request, res: Response, token: string): Promise<AccessResult> {
  let claims: PairClaims | null = null;
  try {
    claims = jwt.verify(token, courseTokenSecret()) as PairClaims;
  } catch {
    return { ok: false, reason: "not_found", message: "Код привязки устарел — откройте ссылку из переписки" };
  }
  if (claims?.kind !== "course-pair") return { ok: false, reason: "not_found", message: "Код привязки недействителен" };
  const [contact, device] = await Promise.all([
    prisma.contact.findUnique({ where: { id: claims.contactId } }),
    prisma.device.findUnique({ where: { id: claims.deviceId } }),
  ]);
  if (!contact || !device || device.contactId !== contact.id) {
    return { ok: false, reason: "not_found", message: "Устройство не найдено — откройте ссылку из переписки" };
  }
  if (secretStamp(device.secret) !== claims.sv) {
    return { ok: false, reason: "not_found", message: "Устройство было отвязано — откройте ссылку из переписки" };
  }
  if (device.blockedAt) return { ok: false, reason: "blocked", message: device.blockedReason || "Устройство заблокировано" };
  const purchases = await activePurchases(contact.id);
  if (purchases.length === 0) return { ok: false, reason: "revoked", message: "Доступ к курсу закрыт" };

  await maybeAlertGeoAnomaly(contact, device, clientCountry(req));
  const refreshed = await prisma.device.update({
    where: { id: device.id },
    data: {
      lastSeenAt: new Date(),
      lastIp: clientIp(req),
      lastCity: clientCountry(req) ?? device.lastCity,
      offlineKeyExpiresAt: new Date(Date.now() + OFFLINE_KEY_DAYS * 86_400_000),
    },
  });
  issueSession(res, contact.id, device.id, device.secret ?? crypto.randomUUID());
  return { ok: true, contact, purchases, purchase: purchases[0], device: refreshed };
}

/** Текущая сессия из куки. Здесь же продлевается офлайн-ключ: любое обращение
 *  к API означает, что телефон в сети, и ученице не нужно ничего нажимать. */
export async function currentAccess(req: Request): Promise<AccessResult> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return { ok: false, reason: "no_session", message: "Откройте курс по ссылке из переписки" };

  let claims: SessionClaims | null = null;
  for (const secret of courseVerifySecrets()) {
    try {
      claims = jwt.verify(token, secret) as SessionClaims;
      break;
    } catch {
      // см. verifyMagicLink выше — тот же переход на отдельный секрет
    }
  }
  if (!claims) {
    return { ok: false, reason: "no_session", message: "Сессия устарела — откройте ссылку заново" };
  }
  if (claims.kind !== "course-session") {
    return { ok: false, reason: "no_session", message: "Сессия недействительна" };
  }

  const resolved = await resolveOwner(claims);
  const device = await prisma.device.findUnique({ where: { id: claims.deviceId } });
  if (!resolved || !device) return { ok: false, reason: "not_found", message: "Курс не найден" };
  const { contact } = resolved;
  // Устройство должно принадлежать этому человеку: сессия одного с меткой
  // другого — это не наш случай, а подделка.
  if (device.contactId && device.contactId !== contact.id) {
    return { ok: false, reason: "not_found", message: "Сессия недействительна" };
  }
  const purchases = await activePurchases(contact.id);
  if (purchases.length === 0) return { ok: false, reason: "revoked", message: "Доступ к курсу закрыт" };
  const purchase = purchases[0];
  if (device.blockedAt) {
    return { ok: false, reason: "blocked", message: device.blockedReason || "Устройство заблокировано" };
  }

  // ЗАПИСЫВАЕМ НЕ ЧАЩЕ РАЗА В ДЕСЯТЬ МИНУТ. Эта функция вызывается на каждый
  // запрос ученицы: список уроков, манифест, каждая дорожка, ключ, прогресс раз
  // в 15 секунд, чат. Обновлять устройство каждый раз значило бы десятки записей
  // в секунду в единственный писатель SQLite — прямая конкуренция с ботом,
  // который в этот же момент сохраняет сообщение клиентки. На срок офлайн-ключа
  // это не влияет: он и так продлевается на 30 дней вперёд.
  const stale = Date.now() - device.lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
  if (!stale) return { ok: true, contact, purchases, purchase, device };

  const refreshed = await prisma.device.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(), offlineKeyExpiresAt: new Date(Date.now() + OFFLINE_KEY_DAYS * 86_400_000) },
  });
  return { ok: true, contact, purchases, purchase, device: refreshed };
}

/** HTTP-код для отказа. Разные причины — разные коды: фронт по ним показывает
 *  разные экраны, а не одну общую ошибку. */
export function statusFor(reason: Exclude<AccessResult, { ok: true }>["reason"]): number {
  if (reason === "no_session") return 401;
  if (reason === "device_limit") return 429;
  if (reason === "revoked" || reason === "blocked" || reason === "offline_expired") return 403;
  return 404;
}
