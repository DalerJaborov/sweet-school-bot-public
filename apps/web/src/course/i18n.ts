/**
 * НАДПИСИ ИНТЕРФЕЙСА НА ДВУХ ЯЗЫКАХ.
 *
 * Почему они здесь, а не переводятся Gemini вместе с уроками: этих строк
 * около сотни, они не меняются, и переводить их заново на каждом открытии
 * приложения значило бы ждать сеть ради слова «Назад». Хуже того — без сети
 * (а офлайн у нас основной сценарий, ученицы смотрят в дороге) перевода не
 * было бы вовсе, и половина экрана вернулась бы на чужой язык.
 *
 * Gemini переводит СОДЕРЖИМОЕ — названия уроков, описание курса, рецепты
 * (см. apps/api/src/course/i18n.ts). Оно и правда меняется, и держать его
 * перевод руками невозможно.
 *
 * ПРАВИЛО (03.09.2026): В КОМПОНЕНТАХ КИРИЛЛИЦЫ НЕТ. Все слова, которые видит
 * ученица, живут только в этом файле — иначе таджикский экран рано или поздно
 * снова заговорит по-русски в самом неожиданном месте (так и вышло с плеером
 * и чатом в первой версии). Это проверяет тест tests/i18nCompleteness.
 */

export type Lang = "ru" | "tg";

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "tg", label: "Тоҷикӣ" },
  { code: "ru", label: "Русский" },
];

const RU = {
  appName: "Shirin",

  // Общее
  loading: "Открываю ваши уроки…",
  preparingTitle: "Почти готово",
  preparingMessage: "Курс готовится, загляните чуть позже",
  retry: "Попробовать снова",
  back: "Назад",
  close: "Закрыть",
  networkError: "Не получается связаться с Ширин. Проверьте интернет.",
  errorStatus: (code: number) => `Ошибка ${code}`,
  /** Подсказки к отказам: разные причины требуют разных действий от человека. */
  help: {
    device_limit: "Напишите нам в Instagram, и мы освободим место для этого телефона.",
    revoked: "Если это ошибка, напишите нам — вернём доступ.",
    blocked: "Напишите нам в Instagram, разберёмся.",
    no_session: "Откройте ссылку из переписки с Ширин — она открывает уроки без пароля.",
    not_found: "Попросите у Ширин новую ссылку — эта больше не действует.",
    network: "Уроки, сохранённые в телефоне, откроются и без интернета.",
  } as Record<string, string>,
  /** Экран отказа — вход, а не тупик: купить курс и написать Ширин. */
  buyCourse: "Купить курс",
  buyCourseUrl: "https://shirinsweets.online/online-kurs",
  /** Предзаполненный текст в WhatsApp, когда ссылка на уроки не открылась. */
  linkBrokenWa: "Здравствуйте! Моя ссылка на уроки не открывается",

  // Главная
  greeting: (name: string) => `Здравствуйте, ${name}`,
  greetingNoName: "Здравствуйте",
  yourCourses: "Ваши курсы",
  lessonsCount: (n: number) => `${n} ${plural(n, "урок", "урока", "уроков")}`,
  passedOf: (done: number, total: number) => `пройдено ${done} из ${total}`,
  openCourse: "Открыть",
  courseAria: (title: string, done: number, total: number) => `${title}: пройдено ${done} из ${total}`,
  allLessons: "Все уроки",
  askTeacher: "Спросить Ширин",
  askAboutLesson: "Спросить про этот урок",
  languageLabel: "Язык",

  // Баннеры
  offlineBadge: "Нет интернета — открываются сохранённые уроки",
  cachedCopy: "Показываю сохранённую копию",

  // Строка урока
  savedChip: "в телефоне",
  savingChip: (p: number) => `сохраняю ${p}%`,
  savedTitle: "Работает без интернета",
  lessonPreparing: "готовится",
  courseComingSoon: "Курс готовится, загляните чуть позже",
  lessonDone: "пройден",
  lessonStopped: (p: number) => `остановились на ${p}%`,
  minutes: (m: number) => `${m} мин`,
  notSavedHint: "Откроется, когда появится интернет",
  continueFrom: (t: string) => `Продолжить с ${t}`,
  startOver: "Сначала",
  play: "Смотреть",
  /** Метка на карточке следующего непройденного урока (журнальная сетка). */
  nextLesson: "Следующий",
  /** Пилюля на геройском экране урока (§4 визуальной системы): действие и длительность вместе. */
  heroStartCta: (duration: string) => `Начать · ${duration}`,
  /** Кнопка «Поделиться» на геройском экране — отдаёт story.jpg через Web Share API. */
  heroShare: "Поделиться",

  // Экран урока
  savingLesson: (p: number) => `Сохраняю урок в телефон… ${p}%`,
  savedLesson: "Урок сохранён в телефоне и откроется без интернета",
  willSave: "Урок сохранится в телефоне, пока вы смотрите",
  noInternet: "Нет интернета",
  recipe: "Рецепт",
  photos: "Фото",
  question: "Вопрос",
  noRecipe: "Рецепт к этому уроку ещё не добавлен",
  noPhotos: "Фото к этому уроку пока нет",
  offlinePromise: "Просмотренные уроки сохраняются в телефоне — их можно смотреть потом без интернета",
  gb: "ГБ",
  mb: "МБ",

  // Плеер
  videoLabel: (title: string) => `Видео урока «${title}»`,
  playVideo: "Смотреть",
  pauseVideo: "Пауза",
  rewind: "Назад на 10 секунд",
  forward: "Вперёд на 10 секунд",
  seek: "Перемотка",
  seekValue: (cur: string, total: string) => `${cur} из ${total}`,
  speed: "Скорость",
  quality: "Качество",
  qualityAuto: "Авто",
  fullscreen: "На весь экран",
  exitFullscreen: "Выйти из полного экрана",
  playerNetwork: "Нет связи. Проверьте интернет.",
  playerMedia: "Видео не открылось. Попробуйте ещё раз.",
  playerUnsupported: "Браузер не умеет показывать это видео. Попробуйте другой браузер.",
  captureTitle: "Запись экрана остановила урок",
  captureText: "Уроки Ширин защищены авторским правом. Закройте запись и обновите страницу, чтобы продолжить.",
  qualityAutoWith: (height: string) => `Авто · ${height}`,
  buffering: "Загрузка…",
  hintHold: "Зажмите — ускорение 2×",
  hintDoubleTap: "Двойное касание — ±10 секунд",
  hintButtons: "Качество и скорость — кнопки внизу",
  hintDismiss: "Понятно",

  // Знакомство
  chooseLanguage: "Выберите язык",
  yourName: "Как вас зовут?",
  nameHint: "Имя появится на видео — так мы защищаем уроки от пересылки.",
  firstName: "Имя",
  lastName: "Фамилия",
  enter: "Войти",
  nameRequired: "Впишите, пожалуйста, имя",
  saveFailed: "Не получилось сохранить. Попробуйте ещё раз.",
  changeLanguage: "Забон / Язык",

  // Чат
  chatTitle: "Вопрос Ширин",
  chatLoading: "Загружаю…",
  chatEmpty: "Спросите про рецепт, замену продуктов или что-то, что не получилось. Ответим, как только увидим.",
  chatPlaceholder: "Ваш вопрос…",
  chatInputLabel: "Ваш вопрос",
  send: "Отправить",
  queuedNote: "отправится, когда появится интернет",
  chatLog: "Переписка с Ширин",

  // Контакты
  contacts: "Связаться с Ширин",
  telegramGroup: "Наша группа в Telegram",
  instagram: "Instagram Ширин",
  whatsapp: "Написать в WhatsApp",

  certificate: "Сертификат",
  certificateReady: "Курс пройден полностью — вам положен сертификат",
  certificateHint: "Проверьте имя и фамилию: так они будут напечатаны в сертификате",
  downloadCertificate: "Скачать сертификат",
  certificateLanguage: "Язык сертификата",
  fixName: "Исправить имя",
  certificateNumber: (n: number, date: string) => `Сертификат № ${n} от ${date}`,
  certificateFailed: "Не получилось выписать сертификат. Попробуйте ещё раз.",
  /** Второй, «шаринговый» формат сертификата (§6 визуальной системы) — PNG под
   *  ленту Instagram, рядом с PDF-кнопкой, а не вместо неё. */
  shareCertificatePng: "Поделиться в Instagram",

  // Тема
  themeDark: "Включить тёмную тему",
  themeLight: "Включить светлую тему",

  // Выход из встроенного браузера (Instagram, Facebook, Telegram, Line)
  escapeTitle: "Откройте уроки в браузере",
  escapeText:
    "Здесь, внутри приложения, видео не сохраняются в телефон и не работают без интернета. Один раз откройте ссылку в обычном браузере — дальше всё будет работать само.",
  escapeButtonIos: "Открыть в Safari",
  escapeButtonAndroid: "Открыть в Chrome",
  escapeButtonOther: "Открыть в браузере",
  escapeManualIos: "Не открылось? Нажмите «•••» вверху справа и выберите «Открыть в браузере».",
  escapeManualAndroid: "Не открылось? Нажмите «⋮» вверху справа и выберите «Открыть в Chrome».",
  escapeManualOther: "Скопируйте ссылку и вставьте её в обычный браузер.",
  copyLink: "Скопировать ссылку",
  copied: "Ссылка скопирована",

  // Устройства: лимит
  deviceLimitTitle: "На этой ссылке уже занято место",
  deviceLimitText: (n: number) =>
    `Уроки можно смотреть на ${n} ${plural(n, "устройстве", "устройствах", "устройствах")}. Все места заняты — вот они:`,
  deviceLabel: (label: string) => label,
  deviceBlocked: "заблокировано",
  deviceLastSeen: (when: string) => `в сети ${when}`,
  today: "сегодня",
  yesterday: "вчера",
  daysAgo: (n: number) => `${n} ${plural(n, "день", "дня", "дней")} назад`,
  replaceOldest: "Это мой новый телефон — заменить самое старое",
  swapsLeft: (n: number) => `Осталось замен: ${n}`,
  noSwapsLeft: "Замены закончились. Напишите нам — мы освободим место для этого телефона.",

  // Установка на экран «Домой»
  installTitle: "Добавьте уроки на экран «Домой»",
  installText: "Откроются в один тап, без браузера, и сохранённые уроки будут работать без интернета.",
  installButton: "Установить",
  installShowSteps: "Как добавить",
  installStep1: "Нажмите «Поделиться» внизу Safari",
  installStep2: "Выберите «На экран Домой»",
  installStep3: "Нажмите «Добавить»",
  notNow: "Не сейчас",

  // Карточка рецепта v2 (визуальная система 04.09.2026, §2)
  lessonBadge: (n: number) => `УРОК ${n}`,
  portionLabel: "Порция",
  gotIngredient: "собрано",
  sendToWhatsapp: "Отправить в WhatsApp",
  preparingImage: "Готовлю картинку…",
  imageSavedManual: "Картинка сохранена — прикрепите её к сообщению в WhatsApp вручную",
  imageShareFailed: "Не получилось создать картинку. Попробуйте ещё раз.",

  // Экран «Набор инструментов» (визуальная система 04.09.2026, §5)
  toolsLink: "Набор инструментов",
  toolsTitle: "Набор инструментов",
  noTools: "Инструменты для этого курса пока не добавлены",
  toolPhotoMissing: "Фото пока нет",
  toolNumberLabel: (n: string) => `№ ${n}`,
  buyInDushanbe: "Где купить в Душанбе",
};

/**
 * Таджикский. Переведено под живую речь Душанбе, а не под учебник: ученицы
 * школы пишут именно так (см. примеры в apps/api/src/ai/clientLanguage.ts).
 * Формы на «-ед» (вежливое повеление: «пурсед», «дароед») — по замечаниям
 * носителя 03.09.2026: инфинитив «пурсидан» на кнопке читается как надпись в
 * словаре, а не как приглашение.
 */
const TG: typeof RU = {
  appName: "Shirin",

  loading: "Дарсҳоятон кушода шуда истодаанд…",
  preparingTitle: "Қариб тайёр шуд",
  preparingMessage: "Курс тайёр шуда истодааст, камтар пас дароед",
  retry: "Боз кӯшиш кунед",
  back: "Ба қафо",
  close: "Пӯшед",
  networkError: "Бо Ширин алоқа баста нашуд. Интернетатонро тафтиш кунед.",
  errorStatus: (code: number) => `Хатогии ${code}`,
  help: {
    device_limit: "Ба мо дар Instagram нависед, барои ин телефон ҷой мекушоем.",
    revoked: "Агар ин хато бошад, ба мо нависед — дастрасиро бармегардонем.",
    blocked: "Ба мо дар Instagram нависед, ҳал мекунем.",
    no_session: "Пайвандро аз мукотиба бо Ширин кушоед — дарсҳо бе парол кушода мешаванд.",
    not_found: "Аз Ширин пайванди нав пурсед — ин дигар кор намекунад.",
    network: "Дарсҳои дар телефон захирашуда бе интернет ҳам кушода мешаванд.",
  } as Record<string, string>,
  buyCourse: "Курсро харидан",
  buyCourseUrl: "https://shirinsweets.online/tg/online-kurs",
  linkBrokenWa: "Ассалому алейкум! Пайванди дарсҳои ман кушода намешавад",

  greeting: (name: string) => `Ассалому алайкум, ${name}`,
  greetingNoName: "Ассалому алайкум",
  yourCourses: "Курсҳои шумо",
  lessonsCount: (n: number) => `${n} дарс`,
  passedOf: (done: number, total: number) => `${done} аз ${total} тамом шуд`,
  openCourse: "Кушоед",
  courseAria: (title: string, done: number, total: number) => `${title}: ${done} аз ${total} тамом шуд`,
  allLessons: "Ҳамаи дарсҳо",
  askTeacher: "Аз Ширин пурсед",
  askAboutLesson: "Дар бораи ин дарс пурсед",
  languageLabel: "Забон",

  offlineBadge: "Интернет нест — дарсҳои сабтшуда кушода мешаванд",
  cachedCopy: "Нусхаи сабтшуда нишон дода мешавад",

  savedChip: "дар телефон",
  savingChip: (p: number) => `сабт шуда истодааст ${p}%`,
  savedTitle: "Бе интернет кор мекунад",
  lessonPreparing: "тайёр шуда истодааст",
  courseComingSoon: "Курс тайёр шуда истодааст, каме дертар назар андозед",
  lessonDone: "тамом шуд",
  lessonStopped: (p: number) => `дар ${p}% истодед`,
  minutes: (m: number) => `${m} дақ`,
  notSavedHint: "Вақте интернет пайдо шуд, мекушояд",
  continueFrom: (t: string) => `Аз ${t} давом диҳед`,
  startOver: "Аз аввал",
  play: "Тамошо кунед",
  nextLesson: "Дарси навбатӣ",
  heroStartCta: (duration: string) => `Сар кунед · ${duration}`,
  heroShare: "Паҳн кунед",

  savingLesson: (p: number) => `Дарс дар телефон сабт шуда истодааст… ${p}%`,
  savedLesson: "Дарс дар телефон сабт шуд ва бе интернет мекушояд",
  willSave: "То тамошо кардани шумо, дарс дар телефон сабт мешавад",
  noInternet: "Интернет нест",
  recipe: "Рецепт",
  photos: "Расмҳо",
  question: "Савол",
  noRecipe: "Ба ин дарс ҳанӯз рецепт илова нашудааст",
  noPhotos: "Ба ин дарс ҳоло расмҳо нестанд",
  offlinePromise: "Дарсҳои тамошокардаатон дар телефон сабт мешаванд — баъд метавонед онҳоро бе интернет бинед",
  gb: "ГБ",
  mb: "МБ",

  videoLabel: (title: string) => `Видеои дарси «${title}»`,
  playVideo: "Тамошо кунед",
  pauseVideo: "Таваққуф",
  rewind: "10 сония ба қафо",
  forward: "10 сония ба пеш",
  seek: "Пешу қафо кардан",
  seekValue: (cur: string, total: string) => `${cur} аз ${total}`,
  speed: "Суръат",
  quality: "Сифат",
  qualityAuto: "Авто",
  fullscreen: "Ба тамоми экран",
  exitFullscreen: "Аз экрани пурра бароед",
  playerNetwork: "Алоқа нест. Интернетатонро тафтиш кунед.",
  playerMedia: "Видео кушода нашуд. Боз кӯшиш кунед.",
  playerUnsupported: "Браузер ин видеоро нишон диҳад наметавонад. Браузери дигарро кӯшиш кунед.",
  captureTitle: "Забти экран дарсро истонд",
  captureText: "Дарсҳои Ширин ҳуқуқи муаллифӣ доранд. Барои давом додан, забти экранро пӯшед ва саҳифаро нав кунед.",
  qualityAutoWith: (height: string) => `Авто · ${height}`,
  buffering: "Бор мешавад…",
  hintHold: "Пахш карда доред — суръати 2×",
  hintDoubleTap: "Ду бор ламс кунед — ±10 сония",
  hintButtons: "Сифат ва суръат — тугмаҳо дар поён",
  hintDismiss: "Фаҳмидам",

  chooseLanguage: "Забонро интихоб кунед",
  yourName: "Номи шумо чист?",
  nameHint: "Номатон дар видео пайдо мешавад — бо ҳамин роҳ мо дарсҳоро аз паҳншавӣ ҳимоя мекунем.",
  firstName: "Ном",
  lastName: "Насаб",
  enter: "Дароед",
  nameRequired: "Лутфан, номатонро нависед",
  saveFailed: "Сабт карда нашуд. Боз кӯшиш кунед.",
  changeLanguage: "Забон / Язык",

  chatTitle: "Савол ба Ширин",
  chatLoading: "Боргирӣ шуда истодааст…",
  chatEmpty: "Дар бораи рецепт, иваз кардани маҳсулот ё он чизе, ки набаромад, пурсед. Ҳамин ки дидем, ҷавоб медиҳем.",
  chatPlaceholder: "Саволи шумо…",
  chatInputLabel: "Саволи шумо",
  send: "Равон кунед",
  queuedNote: "вақте интернет пайдо шуд, равон мешавад",
  chatLog: "Мукотиба бо Ширин",

  contacts: "Тамос бо Ширин",
  telegramGroup: "Гуруҳи мо дар Telegram",
  instagram: "Instagram-и Ширин",
  whatsapp: "Дар WhatsApp нависед",

  certificate: "Сертификат",
  certificateReady: "Курсро пурра тамом кардед — ба шумо сертификат дода мешавад",
  certificateHint: "Ном ва насабатонро тафтиш кунед: онҳо дар сертификат маҳз ҳамин тавр чоп мешаванд",
  downloadCertificate: "Сертификатро боргирӣ кунед",
  certificateLanguage: "Забони сертификат",
  fixName: "Номро ислоҳ кунед",
  certificateNumber: (n: number, date: string) => `Сертификати № ${n} аз ${date}`,
  certificateFailed: "Сертификат дода нашуд. Боз кӯшиш кунед.",
  shareCertificatePng: "Дар Instagram паҳн кунед",

  themeDark: "Мавзӯи торикро фаъол кунед",
  themeLight: "Мавзӯи равшанро фаъол кунед",

  escapeTitle: "Дарсҳоро дар браузер кушоед",
  escapeText:
    "Дар ин ҷо, дар дохили барнома, видеоҳо дар телефон сабт намешаванд ва бе интернет кор намекунанд. Як бор пайвандро дар браузери оддӣ кушоед — баъд ҳама чиз худаш кор мекунад.",
  escapeButtonIos: "Дар Safari кушоед",
  escapeButtonAndroid: "Дар Chrome кушоед",
  escapeButtonOther: "Дар браузер кушоед",
  escapeManualIos: "Кушода нашуд? «•••»-ро дар боло рост пахш кунед ва «Открыть в браузере»-ро интихоб кунед.",
  escapeManualAndroid: "Кушода нашуд? «⋮»-ро дар боло рост пахш кунед ва «Открыть в Chrome»-ро интихоб кунед.",
  escapeManualOther: "Пайвандро нусха кунед ва дар браузери оддӣ гузоред.",
  copyLink: "Пайвандро нусха кунед",
  copied: "Пайванд нусха шуд",

  deviceLimitTitle: "Дар ин пайванд ҷой аллакай банд аст",
  deviceLimitText: (n: number) => `Дарсҳоро дар ${n} дастгоҳ дидан мумкин аст. Ҳамаи ҷойҳо банданд — инҳоянд:`,
  // Сервер подписывает устройства по-русски; здесь — их таджикские имена.
  deviceLabel: (label: string) => ({ Компьютер: "Компютер", Устройство: "Дастгоҳ" })[label] ?? label,
  deviceBlocked: "баста шудааст",
  deviceLastSeen: (when: string) => `дар шабака ${when}`,
  today: "имрӯз",
  yesterday: "дирӯз",
  daysAgo: (n: number) => `${n} рӯз пеш`,
  replaceOldest: "Ин телефони нави ман аст — кӯҳнатаринро иваз кунед",
  swapsLeft: (n: number) => `Ивазҳои боқимонда: ${n}`,
  noSwapsLeft: "Ивазҳо тамом шуданд. Ба мо нависед — барои ин телефон ҷой мекушоем.",

  installTitle: "Дарсҳоро ба экрани «Асосӣ» илова кунед",
  installText: "Бо як пахш, бе браузер кушода мешаванд, ва дарсҳои сабтшуда бе интернет кор мекунанд.",
  installButton: "Насб кунед",
  installShowSteps: "Чӣ тавр илова кунам",
  installStep1: "Дар поёни Safari «Поделиться»-ро пахш кунед",
  installStep2: "«На экран Домой»-ро интихоб кунед",
  installStep3: "«Добавить»-ро пахш кунед",
  notNow: "Ҳоло не",

  lessonBadge: (n: number) => `ДАРСИ ${n}`,
  portionLabel: "Ҳисса",
  gotIngredient: "гирифта шуд",
  sendToWhatsapp: "Ба WhatsApp равон кунед",
  preparingImage: "Расм тайёр шуда истодааст…",
  imageSavedManual: "Расм сабт шуд — онро ба WhatsApp дастӣ ҳамроҳ кунед",
  imageShareFailed: "Расм сохта нашуд. Боз кӯшиш кунед.",

  toolsLink: "Маҷмӯи асбобҳо",
  toolsTitle: "Маҷмӯи асбобҳо",
  noTools: "Ба ин курс ҳанӯз асбобҳо илова нашудаанд",
  toolPhotoMissing: "Расм ҳоло нест",
  toolNumberLabel: (n: string) => `№ ${n}`,
  buyInDushanbe: "Дар Душанбе аз куҷо харидан мумкин",
};

export type Dict = typeof RU;

export function dict(lang: Lang): Dict {
  return lang === "tg" ? TG : RU;
}

/** Для теста полноты: оба словаря целиком, без обхода через dict(). */
export const DICTIONARIES: Record<Lang, Dict> = { ru: RU, tg: TG };

/**
 * Язык — ещё и атрибут документа: по нему браузер выбирает переносы и
 * озвучку в VoiceOver/TalkBack, а без него таджикский текст читался бы
 * русскими правилами.
 */
export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
}

/** Русские числительные: 1 урок, 2 урока, 5 уроков. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** «12:30» — где остановились. Часы показываем только когда они есть. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(rest)}` : `${m}:${two(rest)}`;
}

/** «1.2 ГБ» / «340 МБ» — единицы из словаря, чтобы и они были на языке экрана. */
export function formatBytes(bytes: number, t: Dict): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ${t.gb}`;
  return `${Math.round(bytes / 1024 ** 2)} ${t.mb}`;
}

/**
 * «сегодня» / «вчера» / «3 дня назад» / «12.08.2026» — когда устройство было
 * в сети. Человек выбирает, какое из своих устройств отдать, по этой строке,
 * поэтому она должна читаться, а не быть ISO-датой.
 */
export function formatLastSeen(iso: string | null | undefined, t: Dict, now = Date.now()): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return t.today;
  if (days === 1) return t.yesterday;
  if (days < 7) return t.daysAgo(days);
  return new Date(at).toLocaleDateString("ru-RU");
}

export function formatDuration(sec: number | null, t: Dict): string {
  if (!sec) return "";
  return t.minutes(Math.max(1, Math.round(sec / 60)));
}
