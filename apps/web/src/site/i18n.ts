/**
 * НАДПИСИ ИНТЕРАКТИВНЫХ ЧАСТЕЙ САЙТА на двух языках.
 *
 * Статичные тексты страниц (SEO-копия, FAQ, меню десертов) живут в
 * site-content/*.json и попадают в HTML на этапе сборки — поисковику нужен
 * готовый текст в разметке. Здесь только то, что рисует React после загрузки:
 * карточки курсов из API, форма записи, чат-виджет, ошибки сети.
 *
 * ПРАВИЛО (как в src/course/i18n.ts): в компонентах src/site/** кириллицы нет,
 * всё через t.*. Проверяет tests/site/i18nCompleteness.test.ts.
 * Таджикские строки — черновик, их вычитают отдельно.
 */

export type Lang = "ru" | "tg";

export const LANGUAGES: { code: Lang; label: string; short: string }[] = [
  { code: "tg", label: "Тоҷикӣ", short: "ТҶ" },
  { code: "ru", label: "Русский", short: "РУ" },
];

export const LANG_STORAGE_KEY = "ssb_site_lang";

const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_TG = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];

/** Разбор ГГГГ-ММ-ДД без Date: toLocaleDateString для «tg-TJ» в браузерах
 *  непредсказуем, а падеж месяца должен совпадать с карточкой бота. */
function formatDayMonth(iso: string, months: string[]): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${Number(m[3])} ${months[month - 1]}` : iso;
}

const RU = {
  brand: "Shirin Sweets",
  languageLabel: "Язык",

  // Общее
  loading: "Загружаю…",
  retry: "Попробовать снова",
  close: "Закрыть",
  networkError: "Не получается связаться с сервером. Проверьте интернет.",
  errorStatus: (code: number) => `Ошибка ${code}`,
  currency: (amount: number, currency: string) => `${amount} ${currency === "TJS" ? "сомони" : currency}`,

  // Карточки онлайн-курсов
  coursesTitle: "Онлайн-курсы",
  coursesEmpty: "Курсы скоро появятся — напишите нам в чат, подскажем.",
  lessonsCount: (n: number) => `${n} ${plural(n, "видеоурок", "видеоурока", "видеоуроков")}`,
  durationMin: (min: number) => `${Math.round(min / 60)} ч видео`,
  foreverChip: "навсегда",
  certificateChip: "сертификат",
  buyCourse: "Купить онлайн-курс",
  buyCourseAria: (title: string) => `Купить курс «${title}» через чат`,
  bundleTitle: "Оба курса вместе",
  bundleSave: (save: number) => `выгода ${save} сомони`,
  bundleFullPrice: (full: number) => `вместо ${full} сомони`,
  buyBundle: "Купить оба курса",
  chatPrefillCourse: (title: string) => `Здравствуйте! Хочу купить онлайн-курс «${title}».`,
  chatPrefillBundle: "Здравствуйте! Хочу купить оба онлайн-курса вместе.",
  chatPrefillDefault: "Здравствуйте! Хочу купить онлайн-курс.",
  coverAlt: (title: string) => `Обложка курса «${title}»`,

  // Офлайн-курс и форма записи
  offlinePrice: (amount: number) => `${amount} сомони`,
  offlinePriceNote: "продукты и сертификат включены",
  offlineNextStart: (date: string) => `Ближайший набор: ${date}`,
  offlineDateTbd: "Дата следующего набора уточняется — оставьте заявку, сообщим первой",
  /** «3 октября» из ГГГГ-ММ-ДД — те же падежи, что у бота (api/ai/courseDate.ts). */
  dayMonth: (iso: string) => formatDayMonth(iso, MONTHS_RU),
  formTitle: "Записаться на офлайн-курс",
  formLead: "Оставьте имя и телефон — Ширин перезвонит и расскажет о ближайшей группе.",
  formName: "Ваше имя",
  formNamePlaceholder: "Например, Мадина",
  formPhone: "Телефон",
  formPhonePlaceholder: "+992 90 000 00 00",
  formSubmit: "Записаться",
  formSending: "Отправляю…",
  formErrName: "Напишите имя — от 2 до 80 букв",
  formErrPhone: "Проверьте номер: от 9 до 20 знаков, только цифры, «+» и пробелы",
  formErrLimit: "Слишком много заявок с этого устройства. Попробуйте через час или напишите в WhatsApp.",
  formErrGeneric: "Не получилось отправить. Попробуйте ещё раз или напишите в WhatsApp.",
  formSuccessTitle: "Заявка отправлена",
  formSuccessText: (name: string) => `${name}, спасибо! Ширин свяжется с вами в ближайшее время.`,
  formAgain: "Отправить ещё одну заявку",
  formPrivacy: "Номер нужен только для звонка о курсе. Никаких рассылок.",

  // Чат-виджет
  chatFab: "Спросить / Купить",
  chatFabAria: "Открыть чат с Ширин",
  chatTitle: "Чат с Ширин",
  chatSubtitle: "Отвечаем сразу, обычно за минуту",
  chatEmpty: "Спросите о курсах, цене или пришлите чек об оплате — доступ к урокам придёт сюда же.",
  chatPlaceholder: "Напишите сообщение…",
  chatInputLabel: "Сообщение",
  send: "Отправить",
  attachImage: "Прикрепить чек",
  removeImage: "Убрать картинку",
  imageTooBig: "Файл больше 10 МБ — сделайте скриншот поменьше.",
  imageBadType: "Нужна картинка: JPG, PNG, WebP или HEIC.",
  chatTyping: "Ширин печатает…",
  chatPending: "Ответ идёт, подождите немного…",
  chatRateLimited: (sec: number) => `Слишком много сообщений. Подождите ${Math.ceil(sec / 60)} мин.`,
  chatSendFailed: "Не отправилось. Проверьте интернет и попробуйте снова.",
  chatStartFailed: "Чат сейчас недоступен. Напишите нам в WhatsApp или Telegram.",
  fromYou: "Вы",
  fromBot: "Ширин",
  fromOwner: "Ширин",
  attachedImageAlt: "Прикреплённая картинка",
  openLessonsLink: "Открыть мои уроки",
  chatLog: "Сообщения",
  messageTime: (d: Date) => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
};

const TG: Dict = {
  brand: "Shirin Sweets",
  languageLabel: "Забон",

  loading: "Бор мекунам…",
  retry: "Боз кӯшиш кунед",
  close: "Пӯшидан",
  networkError: "Бо сервер пайваст шуда наметавонам. Интернетро санҷед.",
  errorStatus: (code: number) => `Хатогӣ ${code}`,
  currency: (amount: number, currency: string) => `${amount} ${currency === "TJS" ? "сомонӣ" : currency}`,

  coursesTitle: "Курсҳои онлайн",
  coursesEmpty: "Курсҳо ба зудӣ пайдо мешаванд — дар чат нависед, маслиҳат медиҳем.",
  lessonsCount: (n: number) => `${n} видеодарс`,
  durationMin: (min: number) => `${Math.round(min / 60)} соат видео`,
  foreverChip: "барои ҳамеша",
  certificateChip: "сертификат",
  buyCourse: "Курси онлайнро харидан",
  buyCourseAria: (title: string) => `Курси «${title}»-ро тавассути чат харидан`,
  bundleTitle: "Ҳар ду курс якҷоя",
  bundleSave: (save: number) => `${save} сомонӣ сарфа мекунед`,
  bundleFullPrice: (full: number) => `ба ҷои ${full} сомонӣ`,
  buyBundle: "Ҳар ду курсро харидан",
  chatPrefillCourse: (title: string) => `Ассалому алейкум! Мехоҳам курси онлайни «${title}»-ро харам.`,
  chatPrefillBundle: "Ассалому алейкум! Мехоҳам ҳар ду курси онлайнро якҷоя харам.",
  chatPrefillDefault: "Ассалому алейкум! Мехоҳам курси онлайнро харам.",
  coverAlt: (title: string) => `Муқоваи курси «${title}»`,

  offlinePrice: (amount: number) => `${amount} сомонӣ`,
  offlinePriceNote: "маводҳо ва сертификат дохил",
  offlineNextStart: (date: string) => `Қабули наздиктарин: ${date}`,
  offlineDateTbd: "Санаи қабули оянда аниқ мешавад — дархост гузоред, аввал ба шумо мегӯем",
  dayMonth: (iso: string) => formatDayMonth(iso, MONTHS_TG),
  formTitle: "Ба курси офлайн сабти ном",
  formLead: "Ном ва телефонатонро гузоред — Ширин занг мезанад ва дар бораи гурӯҳи наздик мегӯяд.",
  formName: "Номи шумо",
  formNamePlaceholder: "Масалан, Мадина",
  formPhone: "Телефон",
  formPhonePlaceholder: "+992 90 000 00 00",
  formSubmit: "Сабти ном",
  formSending: "Мефиристам…",
  formErrName: "Номро нависед — аз 2 то 80 ҳарф",
  formErrPhone: "Рақамро санҷед: аз 9 то 20 аломат, танҳо рақамҳо, «+» ва фосила",
  formErrLimit: "Аз ин дастгоҳ дархостҳо аз ҳад зиёданд. Пас аз як соат кӯшиш кунед ё дар WhatsApp нависед.",
  formErrGeneric: "Фиристода нашуд. Боз кӯшиш кунед ё дар WhatsApp нависед.",
  formSuccessTitle: "Дархост фиристода шуд",
  formSuccessText: (name: string) => `${name}, ташаккур! Ширин ба зудӣ бо шумо тамос мегирад.`,
  formAgain: "Боз як дархост фиристодан",
  formPrivacy: "Рақам танҳо барои занг дар бораи курс лозим аст. Ҳеҷ гуна рекламаи ҳатмӣ нест.",

  chatFab: "Пурсидан / Харидан",
  chatFabAria: "Чатро бо Ширин кушодан",
  chatTitle: "Чат бо Ширин",
  chatSubtitle: "Фавран ҷавоб медиҳем, одатан дар як дақиқа",
  chatEmpty: "Дар бораи курсҳо ва нарх пурсед ё чеки пардохтро фиристед — дастрасӣ ба дарсҳо ҳамин ҷо меояд.",
  chatPlaceholder: "Паём нависед…",
  chatInputLabel: "Паём",
  send: "Равон кунед",
  attachImage: "Чекро замима кунед",
  removeImage: "Расмро гирифтан",
  imageTooBig: "Файл аз 10 МБ калон аст — скриншоти хурдтар созед.",
  imageBadType: "Расм лозим аст: JPG, PNG, WebP ё HEIC.",
  chatTyping: "Ширин менависад…",
  chatPending: "Ҷавоб омада истодааст, каме интизор шавед…",
  chatRateLimited: (sec: number) => `Паёмҳо аз ҳад зиёданд. ${Math.ceil(sec / 60)} дақиқа интизор шавед.`,
  chatSendFailed: "Фиристода нашуд. Интернетро санҷед ва боз кӯшиш кунед.",
  chatStartFailed: "Чат ҳоло дастнорас аст. Дар WhatsApp ё Telegram нависед.",
  fromYou: "Шумо",
  fromBot: "Ширин",
  fromOwner: "Ширин",
  attachedImageAlt: "Расми замимашуда",
  openLessonsLink: "Дарсҳои маро кушодан",
  chatLog: "Паёмҳо",
  messageTime: (d: Date) => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
};

export type Dict = typeof RU;

export const DICTIONARIES: Record<Lang, Dict> = { ru: RU, tg: TG };

export function dict(lang: Lang): Dict {
  return DICTIONARIES[lang];
}

export function isLang(value: unknown): value is Lang {
  return value === "ru" || value === "tg";
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
