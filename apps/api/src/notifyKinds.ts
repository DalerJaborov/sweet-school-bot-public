/**
 * ВИДЫ УВЕДОМЛЕНИЙ В TELEGRAM — ОДИН СПИСОК НА ВСЮ СИСТЕМУ (11.11.2026).
 *
 * Решение владельца: бот не засыпает людей. Шлёт мало и только важное:
 *  • «главное» (деньги, запись на офлайн, итог дня) — владельцу и Ширин;
 *  • всё служебное — только владельцу платформы;
 *  • любой вид выключается: кнопкой «🔕 Не присылать такое» под сообщением,
 *    словами в чате («не присылай мне оплаты») или в панели (Настройки).
 *
 * Здесь только список и подписи простыми словами — никакой логики и импортов
 * (файл читают и telegram.ts, и панель, и разбор команд, цикла быть не должно).
 * Новый вид уведомления сначала заводится тут, иначе sendKind его не отправит.
 */
export const NOTIFY_KINDS = ["payment", "offline", "day", "review", "human", "failure", "security"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Кто вообще может получать вид: «main» — владелец и Ширин, «owner» — только владелец. */
export type NotifyAudience = "main" | "owner";

export type NotifyKindInfo = {
  /** Короткое название для списка тумблеров. */
  label: string;
  /** Одна строка пояснения — когда это приходит. */
  hint: string;
  audience: NotifyAudience;
  /** Слова, по которым вид узнаётся в сообщении владельца («не присылай мне оплаты»). */
  words: RegExp;
  /** Первый значок сообщения — чтобы понять, про какой вид ответ реплаем на сообщение. */
  icons: string[];
};

export const NOTIFY_INFO: Record<NotifyKind, NotifyKindInfo> = {
  payment: {
    label: "Пришла оплата",
    hint: "Кто оплатил, какой курс и сколько сомони.",
    audience: "main",
    words: /оплат|деньг|покупк|продаж|платеж|платёж|сомон/i,
    icons: ["💰"],
  },
  offline: {
    label: "Записались на офлайн-курс",
    hint: "Новая запись и список за день до начала.",
    audience: "main",
    words: /офлайн|оффлайн|очн|запис[ьа]|заявк/i,
    icons: ["📝", "📣"],
  },
  day: {
    label: "Итог дня",
    hint: "Раз в день вечером: написали, оплаты, сомони.",
    audience: "main",
    words: /итог|сводк|вечерн|отчёт|отчет/i,
    icons: ["🌙"],
  },
  review: {
    label: "Чек, который бот не смог проверить",
    hint: "Карточка с кнопками «Подтвердить» и «Отклонить». Только настоящие сомнения.",
    audience: "owner",
    words: /чек|проверк|карточк/i,
    icons: ["🧾"],
  },
  human: {
    label: "Клиент просит живого человека",
    hint: "Человек прямо попросил, чтобы ему написала Ширин.",
    audience: "owner",
    words: /живого|человек|просит|оператор/i,
    icons: ["🙋"],
  },
  failure: {
    label: "Сбои",
    hint: "Instagram или ИИ не работают, маркер истёк. Редко, не чаще раза в 6 часов.",
    audience: "owner",
    words: /сбо[йи]|ошибк|техник|систем|маркер|токен|поломк|не работает/i,
    icons: ["⚠️", "🚨", "🔑"],
  },
  security: {
    label: "Подозрительное с доступом",
    hint: "Чужой вход в закрытую группу, один доступ с разных телефонов.",
    audience: "owner",
    words: /безопасност|подозр|вход|устройств|доступ/i,
    icons: ["🚫", "🔓", "📵"],
  },
};

export function isNotifyKind(v: string): v is NotifyKind {
  return (NOTIFY_KINDS as readonly string[]).includes(v);
}

/** Какой вид у сообщения, по первому значку (ответ реплаем «не присылай такое»). */
export function kindFromMessageText(text: string): NotifyKind | null {
  const t = text.trim();
  for (const k of NOTIFY_KINDS) {
    if (NOTIFY_INFO[k].icons.some((i) => t.startsWith(i))) return k;
  }
  if (/^Чек требует проверки/.test(t)) return "review";
  return null;
}
