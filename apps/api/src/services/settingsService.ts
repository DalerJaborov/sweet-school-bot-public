import { getSetting, setSetting } from "../db.js";

/**
 * Настройки панели: какие ключи вообще существуют, какие из них секреты, и
 * как их читать/писать. Вынесено из admin.ts, чтобы роутер занимался только
 * HTTP (разбор запроса, коды ответа), а список ключей и правило маскирования
 * жили в одном месте — оба пути записи (JSON из панели и HTML-форма для
 * маркеров Meta) проверяют ключ одним и тем же isSettingKey().
 */

export const SETTING_KEYS = [
  "igToken",
  "appSecret",
  "verifyToken",
  "geminiKey",
  "geminiKeysExtra",
  "aiEnabled",
  // Ответ ИИ на комментарий под роликом (aiReplyToComment) — раньше делил
  // флаг с обычным aiEnabled, из-за чего его нельзя было выключить/включить
  // отдельно от переписки в директ (владелец 13.09.2026: нужно было заглушить
  // директ, но оставить живыми ответы под комментариями). Свой ключ, по
  // умолчанию как было — включён, только если владелец явно поставил "true".
  "aiCommentRepliesEnabled",
  // Экстренная пауза «всё, кроме воронки» (владелец 13.09.2026): глушит выдачу
  // ссылок на курс, отзывы-скриншоты и напоминания об офлайн-курсе/приглашении
  // в группу/чек-ине ученицы — см. ai.ts::aiReply, index.ts. Воронка
  // (funnel.ts: комментарии, директ-триггеры, разносчик отложенных шагов) и
  // ответ на комментарии (aiCommentRepliesEnabled выше) НЕ гасятся этим флагом.
  "botFrozen",
  "aiPrompt",
  "aiModel",
  // Голосовая модель читалась кодом (ai.ts), но в этом списке её не было — то есть
  // настройка существовала только на бумаге: сменить её через админку было нельзя.
  "aiModelVoice",
  "courseAccessLink",
  "telegramBotToken",
  "telegramChatId50",
  "telegramChatId70",
  "telegramOwnerChatId",
  "telegramReportChatId",
  // Постоянные ссылки, которые владелец рассылает САМ (не через бота) — вход по
  // ним не должен пугать "непонятным входом"/"слитой ссылкой" (см. groupAccess.ts
  // alertUnexplainedJoin). По одной на строку. Не секрет уровня пароля, но и не
  // для коммита в код — владелец вставляет сам.
  "manualInviteLinks",
  // Учебная группа Telegram (владелец 24.08.2026) — chat_id группы и Telegram
  // user_id самой Ширин, чтобы отличать её ответы от вопросов учениц.
  // См. qaGroup.ts: без обеих настроек только сырой лог, пары не строятся.
  "telegramQaGroupId",
  // Секрет заголовка, которым Telegram подписывает свои вебхуки. Ключа тут не
  // было вовсе — то есть проверка подписи существовала только на бумаге и
  // всегда пропускала (разбор безопасности 03.09.2026). Значение придумывает
  // сам сервер при нажатии «Подключить вебхук», руками его вводить не нужно.
  "telegramWebhookSecret",
  "telegramQaOwnerId",
  // Автоответ в учебной группе (владелец 26.08.2026) — бот повторяет ТОЛЬКО её
  // же прошлый ответ на близко совпавший повторный вопрос (см. ai/qaGroupReply.ts),
  // ничего не сочиняет сам. По умолчанию выключено — владелец включает
  // осознанно, не сюрпризом после деплоя.
  "qaAutoReplyEnabled",
  // Расшифровка голосовых вопросов в группе для базы знаний — независимо от автоответа (05.09.2026).
  "qaVoiceTranscribeEnabled",
  "timezoneOffsetHours",
  "reportHour",
  "styleLearningEnabled",
  // Живая тревога «застрял разговор» (stuckAlert.ts) — владелец 25.08.2026 захотел
  // возможность выключать её из панели, не трогая код. cooldownHours читался кодом
  // и раньше, но не был в этом списке — та же ловушка, что уже описана для
  // aiModelVoice выше: настройка существовала только на бумаге.
  "stuckAlertEnabled",
  "stuckAlertCooldownHours",
  "fbPageToken",
  "fbPageId",
  // JSON-массив [{label, text}] — кнопки быстрых ответов под Telegram-уведомлением
  // «серой зоны» (см. quickReplies.ts). Панель не единственный способ править:
  // Ширин ей не пользуется, но владелец иногда правит текст отсюда.
  "quickReplies",
  // JSON-массив пар «возражение → сработавший ответ», копится ночным разбором
  // (nightlyLearning.ts) и подмешивается в промт отдельно от salesInsights —
  // см. ai/objectionLibrary.ts. Здесь только чтобы владелец мог посмотреть/стереть.
  "objectionLibrary",
  // ---- сайт shirinsweets.online (site/router.ts) ----
  // Телефон и TikTok на главной, цена офлайн-курса для карточки каталога. Без
  // значений отдаются дефолты из site/router.ts — сайт не должен пустовать.
  "sitePhone",
  "siteTiktokUrl",
  "offlineCoursePrice",
  // ---- раздел «Тексты и цены» (05.09.2026) ----
  // Цены онлайн-курсов и комплекта — читаются services/priceService.ts с
  // константами prices.ts как умолчаниями; запись отсюда же дублируется в
  // Course.price, который показывает сайт.
  "priceCourse50",
  "priceCourse70",
  "priceBundle",
  // Реквизиты, условие сертификата, язык уроков, «что после оплаты» — RU и TG.
  // Бот (правила 4, 17–21 в ai/prompts.ts) читает их на каждом ходе через
  // services/salesTextsService.ts; пусто — сегодняшний текст по умолчанию.
  "paymentPhone",
  "paymentRecipient",
  "paymentBanks",
  "paymentNameNoteRu",
  "paymentNameNoteTg",
  "certificateRuleRu",
  "certificateRuleTg",
  "lessonLanguageRu",
  "lessonLanguageTg",
  "afterPaymentRu",
  "afterPaymentTg",
  // Факты офлайн-курса для заготовки карточки (ai/offlineCourse.ts) и витрины:
  // длительность в днях, часы («14:00–17:00»), число десертов, адрес.
  "offlineCourseDays",
  "offlineCourseHours",
  "offlineCourseDesserts",
  "offlineCourseAddress",
  // ---- собственная платформа курсов ----
  // Хранилище видео: S3-совместимое (владелец выбрал Cloudflare R2, см.
  // docs/course-platform-design.md §5.2). Ключи вставляет сам владелец — они
  // не в окружении и не в коде, и маскируются в выдаче как остальные секреты.
  "r2Endpoint",
  "r2Bucket",
  "r2AccessKeyId",
  "r2SecretKey",
  "r2Region",
  // Публичный адрес раздачи (CDN или r2.dev) для картинок рецептов и обложек.
  // Видео раздаётся подписанными ссылками и сюда не смотрит.
  "r2PublicBase",
  // telegram | web | both — куда ведёт ссылка после подтверждения оплаты.
  // both на время перехода: старым ученицам привычная группа, новым — платформа.
  "courseDeliveryMode",
  // "false" выключает расшифровку уроков в текст (course/transcribe.ts).
  // По умолчанию включена: без неё помощник в чате отвечает только по
  // рецепту и на половину вопросов зовёт Ширин.
  "lessonTranscribeEnabled",
  // ---- офлайн-курс в Душанбе ----
  // Дата ближайшего набора и полное описание, которое бот пересказывает
  // желающим записаться. Раньше дата читалась кодом, но в этом списке её не
  // было — то есть поменять её из панели было нельзя, только правкой кода и
  // деплоем. А дата меняется каждый набор.
  "offlineCourseDate",
  // Карточка условий: две версии, по-русски и по-таджикски. Уходит клиентке
  // ДОСЛОВНО, отдельным сообщением — модель её не пересказывает, поэтому
  // вёрстка со значками и пустыми строками доходит как написана.
  "offlineCourseInfo",
  "offlineCourseInfoTg",
  // Дата начала СТРОГО ГГГГ-ММ-ДД — по ней уходит напоминание за сутки
  // (offlineReminder.ts). Отдельно от текста карточки: разбирать дату из
  // фразы «3 октября» значит однажды ошибиться на месяц и не напомнить вовсе.
  "offlineCourseStartDate",
  // Сторож входящих (inboundWatch.ts): сколько часов тишины в рабочее время
  // считать поломкой. Пусто — 4.
  "inboundSilenceHours",
  // ---- домашняя страница платформы ----
  // Владелец 03.09.2026: «пусть при нажатии ссылки выходит главная страница
  // школы — все уроки, контакты учителей, группа в телеграме». Ссылки живут в
  // настройках, а не в коде: группу пересоздают, ник меняют, и каждый такой
  // случай не должен требовать деплоя.
  "schoolTelegramGroupUrl",
  "schoolInstagramUrl",
  // Номер для WhatsApp в международном формате — с него же уходит напоминание
  // об очном курсе, но здесь он нужен ученице, чтобы написать живому человеку.
  "schoolWhatsappPhone",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const SECRET_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  "igToken",
  "appSecret",
  "geminiKey",
  "geminiKeysExtra",
  "telegramBotToken",
  "telegramWebhookSecret",
  "fbPageToken",
  "r2AccessKeyId",
  "r2SecretKey",
]);

/** Маска, которой наружу отдаётся заданный секрет. Панель шлёт её обратно
 *  нетронутой — такое значение при записи пропускается (см. writeSettings). */
export const SECRET_MASK = "•••";

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function isSecretKey(key: SettingKey): boolean {
  return SECRET_KEYS.has(key);
}

/** Все настройки для панели. Секреты наружу не отдаём — только признак «задан». */
export async function readSettingsMasked(): Promise<Record<SettingKey, string | null>> {
  const out = {} as Record<SettingKey, string | null>;
  for (const key of SETTING_KEYS) {
    const value = await getSetting(key);
    out[key] = value && isSecretKey(key) ? SECRET_MASK : value;
  }
  return out;
}

/**
 * Запись пачки настроек из панели. Неизвестные ключи молча пропускаются
 * (панель старой версии могла прислать лишнее), маска секрета не сохраняется —
 * иначе одно нажатие «Сохранить» затирало бы настоящий токен тремя точками.
 * Возвращает, сколько ключей реально записано.
 */
export async function writeSettings(values: Record<string, string>): Promise<number> {
  let written = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!isSettingKey(key)) continue;
    if (isSecretKey(key) && value === SECRET_MASK) continue;
    await setSetting(key, value);
    written += 1;
  }
  return written;
}

/** Одна настройка — путь HTML-формы (/admin-form/setting). Значение обрезается
 *  по краям: маркеры Meta копируются с переносом строки в конце. */
export async function writeSetting(key: SettingKey, value: string): Promise<void> {
  await setSetting(key, value.trim());
}
