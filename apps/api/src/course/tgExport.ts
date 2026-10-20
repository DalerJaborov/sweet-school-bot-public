/**
 * РАЗБОР ЭКСПОРТА TELEGRAM DESKTOP В КАНДИДАТЫ УРОКОВ.
 *
 * Владелец экспортирует учебную группу («Экспорт истории чата» → JSON с видео
 * и фото). Получается result.json + папки video_files/, photos/. Этот модуль
 * превращает список сообщений в список уроков, которые потом показываются в
 * панели на подтверждение и импортируются на платформу.
 *
 * Модуль намеренно ЧИСТЫЙ: никакой файловой системы, базы и сети — только
 * JSON на входе и структуры на выходе. Так его можно гонять на встроенных
 * фикстурах в тестах, а проверка существования файлов и «уже импортировано»
 * живёт в маршрутах импорта.
 *
 * ДВА РЕЖИМА СКЛЕЙКИ — под два разных способа вести чат:
 *
 *  «caption» (учебная ГРУППА, исторический):
 *   • видео = урок; подпись к нему — «Урок 3. Наполеон» и дальше рецепт;
 *   • иногда название шлют ОТДЕЛЬНЫМ сообщением перед видео («Дарси 2»);
 *   • после видео идут фото готового изделия и длинный текст рецепта —
 *     обычно в пределах получаса;
 *   • между уроками — стикеры, голосовые, служебные «X присоединился».
 *
 *  «channel» (КАНАЛ школы, по реальному экспорту 04.09.2026):
 *   урок — это пачка постов за несколько минут: дизайнерская КАРТОЧКА рецепта
 *   (фото; текст «ДАРСИ 3 / ТВОРОЖНЫЙ ПИРОГ» и ингредиенты — ВНУТРИ картинки,
 *   подпись обычно пустая), ТИЗЕР 9–24 с (вертикальный, с музыкой) и ПОЛНОЕ
 *   видео 10–21 мин. Подписей почти нет, поэтому название берётся из имени
 *   файла («Творожный пирог.mp4»), а номер — по порядку появления. Посты без
 *   длинного видео (приветствие, фото инструментов, «Сабти сертификат») —
 *   не уроки: они уходят в отдельный список intro[], чтобы владелец мог
 *   позже сделать из них вводный урок.
 */

export type TgTextEntity = { type: string; text: string };
export type TgText = string | Array<string | TgTextEntity>;

export type TgMediaType =
  | "video_file"
  | "sticker"
  | "voice_message"
  | "audio_file"
  | "animation"
  | "video_message";

export type TgMessage = {
  id: number;
  type: "message" | "service";
  date: string;
  from?: string;
  text?: TgText;
  text_entities?: TgTextEntity[];
  file?: string;
  media_type?: TgMediaType | string;
  mime_type?: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  photo?: string;
  thumbnail?: string;
  sticker_emoji?: string;
  forwarded_from?: string;
  reply_to_message_id?: number;
};

export type TgExport = { id?: number; name?: string; type?: string; messages: TgMessage[] };

export type ParseMode = "caption" | "channel";

/** Откуда взялось название — панель показывает это владельцу, чтобы он знал,
 *  чему верить: подписи, имени файла или выдумке парсера. */
export type TitleSource = "caption" | "header" | "filename" | "generated";

export type LessonCandidate = {
  messageId: number;
  chatId: string;
  date: string;
  /** Явный номер из подписи («Урок 3») или порядковый, если номера не было. */
  number: number | null;
  /** Первая непустая строка подписи без нумерации, ≤ 200 символов. */
  title: string;
  titleSource: TitleSource;
  /** Остаток подписи + прикреплённые тексты, через пустую строку. */
  recipeText: string;
  videoFile: string;
  mimeType: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Прикреплённые фото в порядке появления; карточки рецепта — первыми. */
  photoFiles: string[];
  /** Фото-карточки рецепта (канальный режим). Подмножество photoFiles. */
  cardPhotos: string[];
  /** Короткий ролик-анонс (канальный режим), ≤ 40 с. Сообщение есть, а файла
   *  нет — тизер не выгружен (лимит размера), см. resolveVideoFiles. */
  teaserMessageId: number | null;
  teaserFile: string | null;
  teaserMimeType: string;
  teaserDurationSec: number | null;
  /** Все сообщения, вошедшие в урок; видео — первым. */
  attachedMessageIds: number[];
  /** Понятные владельцу замечания: что парсер решил сам, а не прочитал. */
  warnings: string[];
};

export type SkippedMessage = { messageId: number; reason: string };

/** Пост канала без полного видео: приветствие, фото инструментов, закреп. */
export type IntroPost = {
  messageId: number;
  date: string;
  kind: "text" | "photo" | "video";
  text: string;
  file: string | null;
};

export type ParsedTelegramExport = {
  chatId: string;
  chatName: string;
  mode: ParseMode;
  lessons: LessonCandidate[];
  skipped: SkippedMessage[];
  /** Посты без урока, из которых владелец может собрать вводный урок. */
  intro: IntroPost[];
};

export type ParseOptions = {
  /** Сколько минут после последнего прикреплённого сообщения фото/тексты
   *  ещё считаются частью урока. По умолчанию 30. */
  attachWindowMin?: number;
  /** Режим склейки. По умолчанию — «caption» (как было), либо по типу чата,
   *  см. detectParseMode. */
  mode?: ParseMode;
};

const DEFAULT_ATTACH_WINDOW_MIN = 30;
const TITLE_MAX = 200;

/** Канальный режим: с этой длительности видео — полный урок… */
export const LESSON_MIN_SEC = 60;
/** …а до этой — тизер. Между ними — ни то ни другое, в skipped с причиной. */
export const TEASER_MAX_SEC = 40;

/** Медиа, которые уроком быть не могут. Причины — на русском, они уходят в панель. */
const SKIPPED_MEDIA: Record<string, string> = {
  sticker: "стикер",
  voice_message: "голосовое сообщение",
  audio_file: "аудиофайл",
  animation: "гифка",
  video_message: "кружок (видеосообщение)",
};

/**
 * Текст в экспорте — либо строка, либо массив кусков: обычные строки и
 * объекты-сущности (жирный, ссылка, упоминание). Для нас форматирование не
 * важно, нужен сплошной текст — склеиваем `.text` по порядку.
 */
export function flattenText(t: TgText | undefined): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  let out = "";
  for (const part of t) {
    if (typeof part === "string") out += part;
    else if (part && typeof part.text === "string") out += part.text;
  }
  return out;
}

/** Слова-маркеры урока на трёх языках группы: русский, таджикский (кириллица и
 *  латиница), английский. Регистр не важен. */
const LESSON_WORD = "(?:урок|занятие|дарс|дарси|dars|darsi|lesson)";

/**
 * «Урок 3. Наполеон», «Дарси 12 — Медовик», «Lesson 1: Cake», «Урок №3».
 * После слова-маркера разделитель необязателен: «Урок 3 Наполеон» тоже бывает.
 */
const WITH_WORD = new RegExp(`^${LESSON_WORD}\\s*(?:№|#)?\\s*(\\d{1,3})\\b\\s*(?:[.:)\\]—–-]+\\s*)?(.*)$`, "iu");

/**
 * «3. Эклеры», «3) Эклеры», «3 — Эклеры». Без слова-маркера разделитель
 * ОБЯЗАТЕЛЕН: иначе «3 яйца» превратилось бы в третий урок «яйца».
 */
const BARE_NUMBER = /^(?:№|#)?\s*(\d{1,3})\s*[.:)\]—–-]+\s*(.*)$/u;

type LessonHeader = { number: number; rest: string; explicit: boolean };

/** Общий разбор заголовка; `explicit` — было ли слово «Урок/Дарси/Lesson». */
function matchLessonHeader(line: string): LessonHeader | null {
  const s = line.trim();
  if (!s) return null;
  const withWord = WITH_WORD.exec(s);
  if (withWord) return { number: Number(withWord[1]), rest: withWord[2].trim(), explicit: true };
  const bare = BARE_NUMBER.exec(s);
  if (bare) return { number: Number(bare[1]), rest: bare[2].trim(), explicit: false };
  return null;
}

/**
 * Вытаскивает номер урока из строки. Возвращает номер и остаток строки
 * (название без нумерации) либо null, если это не заголовок урока.
 */
export function parseLessonNumber(line: string): { number: number; rest: string } | null {
  const m = matchLessonHeader(line);
  return m ? { number: m.number, rest: m.rest } : null;
}

/** Название: одна строка, без лишних пробелов, не длиннее лимита колонки. */
function normalizeTitle(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX).trimEnd() : one;
}

/** Строки текста без пустых по краям; внутренние пустые строки — часть рецепта. */
function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** Дата экспорта без зоны («2024-01-01T12:00:00») — трактуем как локальную;
 *  для сортировки и окна важна только разница, а она от зоны не зависит. */
function toTs(date: string): number {
  const ts = Date.parse(date);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

function isVideo(m: TgMessage): boolean {
  return m.media_type === "video_file" || (typeof m.mime_type === "string" && m.mime_type.startsWith("video/"));
}

/**
 * Экспорт с лимитом размера: вместо пути Telegram Desktop пишет в `file`
 * «(File exceeds maximum size. Change data exporting settings to download.)»,
 * но длительность, размер кадра и mime сохраняет. Такое сообщение — не
 * «файла нет», а «файл лежит отдельно»: канальный режим подбирает его по
 * длительности среди video_files/ (resolveVideoFiles).
 */
const NOT_EXPORTED = /^\(File exceeds maximum size/i;

export function exportedFile(m: Pick<TgMessage, "file">): string | null {
  return m.file && !NOT_EXPORTED.test(m.file) ? m.file : null;
}

/**
 * НАЗВАНИЕ ИЗ ИМЕНИ ФАЙЛА. В канале подписей к видео нет, зато файлы
 * загружали под человеческими именами: «Творожный пирог.mp4»,
 * «Пирожное сникерс 5 сек.mp4», «Дубайский чизкейк-копия(1).mp4»,
 * «Фисташка1.mp4». Убираем расширение, «(1)», «копия», «5 сек», хвостовые и
 * ведущие цифры. Осталось что-то с буквами — это название с заглавной буквы;
 * не осталось («1224 (1).mp4») — пустая строка, пусть решает вызывающий.
 */
export function titleFromFileName(file: string): string {
  let s = file.split(/[\\/]/).pop() ?? "";
  s = s.replace(/\.[a-z0-9]{2,5}$/i, "");
  s = s.replace(/\(\s*\d*\s*\)/g, " ");
  s = s.replace(/[-_\s]*(?:копия|copy)[-_\s]*/gi, " ");
  s = s.replace(/(?:^|\s)\d+\s*(?:сек|секунд|сония|sec|s)\.?(?=\s|$)/gi, " ");
  s = s.replace(/_+/g, " ");
  s = s.replace(/\s*\d+\s*$/, "");
  s = s.replace(/^\s*\d+\s*/, "");
  s = s.replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, "").replace(/\s+/g, " ");
  if (!/\p{L}/u.test(s)) return "";
  // Имена, которые дал не человек, а телефон или сам Telegram.
  if (/^(?:video|vid|img|mov|file|video[ _]?file|record|recording|запись|видео)$/i.test(s)) return "";
  return normalizeTitle(s.charAt(0).toLocaleUpperCase("ru") + s.slice(1));
}

/** Тип чата в экспорте: у каналов Telegram пишет «public_channel»/«private_channel». */
export function detectParseMode(json: Pick<TgExport, "type">): ParseMode {
  return typeof json.type === "string" && /channel/i.test(json.type) ? "channel" : "caption";
}

/* ────────────────────────── чтение result.json ────────────────────────── */

export type ReadExportResult = {
  json: TgExport;
  /** Файл оборван (экспорт прервали до конца) — собрали, что дочиталось. */
  truncated: boolean;
  /** Сколько сообщений удалось вытащить из оборванного файла. */
  recovered: number;
};

/**
 * result.json из прерванного экспорта — обрезанный JSON: Telegram Desktop
 * пишет его последним, и если закрыть окно раньше, файл кончается на
 * полуслове. Целиком не разбирается, но сообщения до места обрыва — целые
 * объекты, и их можно вынуть, честно пройдя по скобкам с учётом строк.
 * Владелец тогда видит в панели, что нашлось, и предупреждение, что экспорт
 * надо доделать, — а не «файл не читается».
 */
export function readExportJson(raw: string): ReadExportResult {
  try {
    const json = JSON.parse(raw) as TgExport;
    if (!json || typeof json !== "object" || !Array.isArray(json.messages)) {
      throw new Error("нет массива messages");
    }
    return { json, truncated: false, recovered: json.messages.length };
  } catch {
    // ниже — восстановление
  }

  const key = raw.indexOf('"messages"');
  const open = key >= 0 ? raw.indexOf("[", key) : -1;
  if (open < 0) throw new Error("result.json не похож на экспорт Telegram: нет массива messages");

  const messages: TgMessage[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          messages.push(JSON.parse(raw.slice(objStart, i + 1)) as TgMessage);
        } catch {
          // объект внутри повреждён — пропускаем, дальше могут быть целые
        }
        objStart = -1;
      }
    } else if (c === "]" && depth === 0) break;
  }

  const head = raw.slice(0, key);
  const name = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  const id = /"id"\s*:\s*(-?\d+)/.exec(head);
  const type = /"type"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  const json: TgExport = {
    id: id ? Number(id[1]) : undefined,
    name: name ? JSON.parse(`"${name[1]}"`) : undefined,
    type: type ? JSON.parse(`"${type[1]}"`) : undefined,
    messages: messages.filter((m) => m && typeof m.id === "number"),
  };
  return { json, truncated: true, recovered: json.messages.length };
}

/* ───────────────────────────── режим caption ───────────────────────────── */

/**
 * Черновик урока в процессе сборки. Отличается от LessonCandidate тем, что
 * видео может ещё не быть — это «ожидающий» заголовок, присланный до видео.
 */
type Draft = {
  video: TgMessage | null;
  headerMessageId: number | null;
  number: number | null;
  title: string;
  recipeParts: string[];
  photoFiles: string[];
  attachedIds: number[];
  warnings: string[];
  /** Время последнего прикреплённого сообщения — от него отсчитывается окно. */
  lastTs: number;
};

function newDraft(lastTs: number): Draft {
  return {
    video: null,
    headerMessageId: null,
    number: null,
    title: "",
    recipeParts: [],
    photoFiles: [],
    attachedIds: [],
    warnings: [],
    lastTs,
  };
}

/**
 * Разбирает заголовок + текст сообщения в черновик: первая непустая строка —
 * название (номер отрезается), остальное — рецепт. Возвращает, был ли это
 * заголовок урока вообще (для текстов без видео это решает их судьбу).
 */
function applyCaption(draft: Draft, text: string): { header: LessonHeader | null; hadTitle: boolean } {
  const lines = splitLines(text);
  if (!lines.length) return { header: null, hadTitle: false };
  const header = matchLessonHeader(lines[0]);
  const title = normalizeTitle(header ? header.rest : lines[0]);
  const rest = splitLines(lines.slice(1).join("\n")).join("\n");
  if (header) draft.number = header.number;
  if (title) draft.title = title;
  if (rest) draft.recipeParts.push(rest);
  return { header, hadTitle: Boolean(title) };
}

/**
 * Является ли текстовое сообщение заголовком следующего урока. Слово
 * «Урок/Дарси/Lesson» — всегда да. Голый номер («2. Медовик») — только если
 * сообщение однострочное: длинный рецепт часто начинается с «1. Взбить яйца»,
 * и это шаг, а не урок.
 */
function isHeaderMessage(text: string): boolean {
  const lines = splitLines(text).filter((l) => l.trim());
  if (!lines.length) return false;
  const h = matchLessonHeader(lines[0]);
  if (!h) return false;
  return h.explicit || lines.length === 1;
}

function finalize(draft: Draft, chatId: string): LessonCandidate {
  const v = draft.video;
  if (!v) throw new Error("finalize: черновик без видео"); // защита от ошибки в самом парсере
  return {
    messageId: v.id,
    chatId,
    date: v.date,
    number: draft.number,
    title: draft.title,
    titleSource: draft.title ? "caption" : "generated",
    recipeText: draft.recipeParts.join("\n\n"),
    videoFile: v.file ?? "",
    mimeType: v.mime_type ?? "",
    durationSec: typeof v.duration_seconds === "number" ? v.duration_seconds : null,
    width: typeof v.width === "number" ? v.width : null,
    height: typeof v.height === "number" ? v.height : null,
    photoFiles: draft.photoFiles,
    cardPhotos: [],
    teaserMessageId: null,
    teaserFile: null,
    teaserMimeType: "",
    teaserDurationSec: null,
    attachedMessageIds: [v.id, ...draft.attachedIds],
    warnings: draft.warnings,
  };
}

type Sorted = { m: TgMessage; ts: number };

/** Telegram обычно пишет по порядку, но экспорт из нескольких частей и
 *  отредактированные сообщения встречались вразнобой — сортируем сами.
 *  Сообщения без даты уходят в начало, но между собой по id. */
function sortMessages(messages: TgMessage[] | undefined): Sorted[] {
  return (messages ?? [])
    .map((m) => ({ m, ts: toTs(m.date) }))
    .sort((a, b) => {
      const ta = Number.isNaN(a.ts) ? -Infinity : a.ts;
      const tb = Number.isNaN(b.ts) ? -Infinity : b.ts;
      return ta - tb || a.m.id - b.m.id;
    });
}

/** Медиа, которое не может быть ни уроком, ни его частью: причина или null. */
function unusableReason(m: TgMessage): string | null {
  if (m.type === "service") return "служебное сообщение";
  if (m.media_type && SKIPPED_MEDIA[m.media_type]) return SKIPPED_MEDIA[m.media_type];
  return null;
}

/**
 * Главная функция: сообщения экспорта → уроки + список пропущенного.
 *
 * Режим «caption» (по умолчанию):
 *  • видео начинает урок; подпись даёт название и начало рецепта;
 *  • фото и тексты в окне после ПОСЛЕДНЕГО прикреплённого сообщения (или
 *    ответы на уже прикреплённое) попадают в урок;
 *  • текст-заголовок («Дарси 2») закрывает текущий урок и ждёт своё видео;
 *  • всё вне окна без открытого урока — в skipped с причиной.
 *
 * Режим «channel» — см. parseChannel ниже.
 *
 * Номера: явные сохраняются, отсутствующие заполняются порядковыми (1, 2, …
 * по месту в списке), дубликаты явных — предупреждение, а не ошибка: владелец
 * поправит в панели.
 */
export function parseTelegramExport(json: TgExport, opts: ParseOptions = {}): ParsedTelegramExport {
  const windowMs = (opts.attachWindowMin ?? DEFAULT_ATTACH_WINDOW_MIN) * 60_000;
  const chatId = String(json.id ?? "unknown");
  const chatName = typeof json.name === "string" ? json.name : "";
  const mode = opts.mode ?? "caption";
  const sorted = sortMessages(json.messages);

  const parsed =
    mode === "channel" ? parseChannel(sorted, chatId, windowMs) : parseCaption(sorted, chatId, windowMs);
  assignNumbers(parsed.lessons);
  return { chatId, chatName, mode, ...parsed };
}

type ParsedBody = Pick<ParsedTelegramExport, "lessons" | "skipped" | "intro">;

function parseCaption(sorted: Sorted[], chatId: string, windowMs: number): ParsedBody {
  const lessons: LessonCandidate[] = [];
  const skipped: SkippedMessage[] = [];

  /** Урок с видео, к которому ещё можно прикреплять. */
  let current: Draft | null = null;
  /** Заголовок без видео, ждёт следующее видео. */
  let pending: Draft | null = null;

  const closeCurrent = () => {
    if (current) lessons.push(finalize(current, chatId));
    current = null;
  };

  const withinWindow = (draft: Draft, ts: number, m: TgMessage): boolean => {
    if (m.reply_to_message_id !== undefined && draft.attachedIds.includes(m.reply_to_message_id)) return true;
    if (draft.video && m.reply_to_message_id === draft.video.id) return true;
    if (Number.isNaN(ts) || Number.isNaN(draft.lastTs)) return false;
    return ts - draft.lastTs <= windowMs;
  };

  for (const { m, ts } of sorted) {
    const unusable = unusableReason(m);
    if (unusable) {
      skipped.push({ messageId: m.id, reason: unusable });
      continue;
    }

    const text = flattenText(m.text);

    if (isVideo(m)) {
      if (!exportedFile(m)) {
        // Экспорт с лимитом размера: файл больше лимита — в JSON есть запись,
        // а самого видео нет. Ни в урок, ни в тишину: владелец должен увидеть.
        skipped.push({ messageId: m.id, reason: "видео не выгружено (превышен лимит размера экспорта)" });
        continue;
      }
      closeCurrent();
      const draft = pending ?? newDraft(ts);
      pending = null;
      draft.video = m;
      draft.lastTs = ts;

      const before = { title: draft.title, number: draft.number };
      const { hadTitle } = applyCaption(draft, text);
      if (hadTitle && before.title && draft.title !== before.title) {
        // У видео своя подпись, а перед ним отдельно прислали заголовок.
        // Верим подписи (она ближе к видео), но говорим об этом владельцу.
        draft.warnings.push(`заголовок «${before.title}» перед видео не использован — у видео своя подпись`);
      }
      if (!hadTitle && before.title) draft.title = before.title;
      if (draft.number === null && before.number !== null) draft.number = before.number;
      if (!draft.title) draft.warnings.push("нет подписи — название придумано");
      current = draft;
      continue;
    }

    if (m.photo) {
      const target = current ?? pending;
      if (target && withinWindow(target, ts, m)) {
        target.photoFiles.push(m.photo);
        target.attachedIds.push(m.id);
        target.lastTs = ts;
        const caption = splitLines(text).join("\n");
        if (caption) target.recipeParts.push(caption);
      } else {
        skipped.push({ messageId: m.id, reason: "фото без видео" });
      }
      continue;
    }

    if (m.file) {
      // Документ (pdf, docx, архив) — не умеем показывать в уроке.
      skipped.push({ messageId: m.id, reason: "файл, не видео" });
      continue;
    }

    const body = splitLines(text).join("\n");
    if (!body.trim()) {
      skipped.push({ messageId: m.id, reason: "пустое сообщение" });
      continue;
    }

    if (isHeaderMessage(body)) {
      closeCurrent();
      if (pending) {
        // Два заголовка подряд без видео — первый повис. В skipped, чтобы
        // владелец увидел, что между ними видео не нашлось.
        skipped.push({ messageId: pending.headerMessageId ?? m.id, reason: "заголовок без видео" });
        for (const id of pending.attachedIds) {
          if (id !== pending.headerMessageId) skipped.push({ messageId: id, reason: "текст без видео" });
        }
      }
      pending = newDraft(ts);
      pending.headerMessageId = m.id;
      pending.attachedIds.push(m.id);
      applyCaption(pending, body);
      continue;
    }

    const target = current ?? pending;
    if (target && withinWindow(target, ts, m)) {
      target.recipeParts.push(body);
      target.attachedIds.push(m.id);
      target.lastTs = ts;
    } else {
      skipped.push({ messageId: m.id, reason: "текст без видео" });
    }
  }

  closeCurrent();
  if (pending) {
    const p: Draft = pending;
    for (const id of p.attachedIds) {
      skipped.push({ messageId: id, reason: id === p.headerMessageId ? "заголовок без видео" : "текст без видео" });
    }
  }

  return { lessons, skipped, intro: [] };
}

/* ───────────────────────────── режим channel ───────────────────────────── */

/** Пост, который ждёт своего полного видео (или достанется предыдущему). */
type PoolItem = { m: TgMessage; kind: "photo" | "teaser" | "text" };

type ChannelDraft = { video: TgMessage; items: PoolItem[] };

/**
 * Канальная склейка. Правила:
 *  • сообщения идут ЦЕПОЧКОЙ: пока между соседними постами не больше окна
 *    (30 мин), они считаются одной пачкой; разрыв длиннее — новая пачка;
 *  • полное видео (≥ 60 с, или длительность неизвестна) — урок; всё, что
 *    накопилось в пачке ДО него (карточка, тизер, тексты), — его;
 *  • пачка без полного видео вовсе — вступление (intro), не урок;
 *  • короткое видео (≤ 40 с) — тизер; между 40 и 60 с — непонятно что,
 *    в skipped с причиной, владелец разберётся;
 *  • видео без файла (лимит размера экспорта) — всё равно урок или тизер:
 *    файл подберёт resolveVideoFiles.
 *
 * Карточка ПЕРЕД видео — не догадка, а порядок, в котором школа ведёт канал
 * (проверено по реальному экспорту 04.09.2026: карточка, тизер и урок
 * уходят одной секундой, урок последним). Поэтому накопленное достаётся
 * СЛЕДУЮЩЕМУ видео, а то, что пришло после урока, — уже следующему уроку или
 * вступлению: иначе закреп «Сабти сертификат» через восемь минут после
 * последнего урока стал бы его названием.
 */
function parseChannel(sorted: Sorted[], chatId: string, windowMs: number): ParsedBody {
  const drafts: ChannelDraft[] = [];
  const skipped: SkippedMessage[] = [];
  const intro: IntroPost[] = [];

  let pool: PoolItem[] = [];
  let prevTs = Number.NaN;

  const orphan = (item: PoolItem) => {
    intro.push({
      messageId: item.m.id,
      date: item.m.date,
      kind: item.kind === "teaser" ? "video" : item.kind,
      text: splitLines(flattenText(item.m.text)).join("\n"),
      file: item.m.photo ?? item.m.file ?? null,
    });
    skipped.push({ messageId: item.m.id, reason: "пост без полного видео — отложен во вступление" });
  };

  /** Разрыв цепочки: накопленное без своего видео — во вступление. */
  const flush = () => {
    pool.forEach(orphan);
    pool = [];
  };

  for (const { m, ts } of sorted) {
    const unusable = unusableReason(m);
    if (unusable) {
      skipped.push({ messageId: m.id, reason: unusable });
      continue;
    }
    if (Number.isNaN(prevTs) || Number.isNaN(ts) || ts - prevTs > windowMs) flush();
    prevTs = ts;

    if (isVideo(m)) {
      const dur = typeof m.duration_seconds === "number" ? m.duration_seconds : null;
      if (dur === null || dur >= LESSON_MIN_SEC) {
        drafts.push({ video: m, items: pool });
        pool = [];
        continue;
      }
      if (dur <= TEASER_MAX_SEC) {
        pool.push({ m, kind: "teaser" });
        continue;
      }
      skipped.push({
        messageId: m.id,
        reason: `видео ${dur} с — ни тизер (до ${TEASER_MAX_SEC} с), ни урок (от ${LESSON_MIN_SEC} с)`,
      });
      continue;
    }

    if (m.photo) {
      pool.push({ m, kind: "photo" });
      continue;
    }
    if (m.file) {
      skipped.push({ messageId: m.id, reason: "файл, не видео" });
      continue;
    }
    if (!splitLines(flattenText(m.text)).join("\n").trim()) {
      skipped.push({ messageId: m.id, reason: "пустое сообщение" });
      continue;
    }
    pool.push({ m, kind: "text" });
  }
  flush();

  return { lessons: drafts.map((d) => finalizeChannel(d, chatId)), skipped, intro };
}

/** Урок из полного видео и его пачки (карточки, тизер, тексты — до и после). */
function finalizeChannel(draft: ChannelDraft, chatId: string): LessonCandidate {
  const v = draft.video;
  const warnings: string[] = [];
  const texts: string[] = [];
  const caption = splitLines(flattenText(v.text)).join("\n");
  if (caption) texts.push(caption);

  const cardPhotos: string[] = [];
  const attachedMessageIds = [v.id];
  let teaser: TgMessage | null = null;

  for (const item of draft.items) {
    attachedMessageIds.push(item.m.id);
    if (item.kind === "photo" && item.m.photo) {
      cardPhotos.push(item.m.photo);
    } else if (item.kind === "teaser") {
      if (teaser) warnings.push(`второй короткий ролик «${item.m.file}» не использован — тизер уже есть`);
      else teaser = item.m;
    }
    const text = splitLines(flattenText(item.m.text)).join("\n");
    if (text) texts.push(text);
  }

  // Название: первая непустая строка первого текста (подпись видео, тизера,
  // карточки или отдельный пост — в порядке появления). Нет текста — имя файла.
  const videoFile = exportedFile(v) ?? "";
  let number: number | null = null;
  let title = "";
  let source: TitleSource = "generated";
  const recipeParts: string[] = [];
  if (texts.length) {
    const lines = splitLines(texts[0]);
    const header = matchLessonHeader(lines[0]);
    if (header) number = header.number;
    let titleLine = header ? header.rest : lines[0];
    let restFrom = 1;
    // «Дарси 3» одной строкой, название — следующей.
    if (header && !titleLine && lines.length > 1) {
      titleLine = lines[1];
      restFrom = 2;
    }
    title = normalizeTitle(titleLine);
    source = header ? "header" : "caption";
    const rest = splitLines(lines.slice(restFrom).join("\n")).join("\n");
    if (rest) recipeParts.push(rest);
    recipeParts.push(...texts.slice(1));
  }
  if (!title) {
    // Подписи нет (или «Дарси 3» без названия) — имя файла, номер оставляем.
    title = titleFromFileName(videoFile);
    source = title ? "filename" : "generated";
  }
  if (number === null) {
    // «ДАРСИ 3» может стоять не первой строкой — ищем по всем текстам.
    outer: for (const t of texts) {
      for (const line of splitLines(t)) {
        const h = matchLessonHeader(line);
        if (h?.explicit) {
          number = h.number;
          break outer;
        }
      }
    }
  }

  const durationSec = typeof v.duration_seconds === "number" ? v.duration_seconds : null;
  // Без файла название придёт из подобранного файла (resolveVideoFiles) —
  // ругаться рано.
  if (source === "generated" && videoFile) {
    warnings.push("название не удалось извлечь ни из подписи, ни из имени файла — придумано");
  }
  if (durationSec === null) warnings.push("длительность неизвестна — считаем полным уроком");
  if (cardPhotos.length === 0) warnings.push("нет карточки рецепта");
  if (!teaser) warnings.push("нет тизера");

  const t: TgMessage | null = teaser;
  return {
    messageId: v.id,
    chatId,
    date: v.date,
    number,
    title,
    titleSource: source,
    recipeText: recipeParts.join("\n\n"),
    videoFile,
    mimeType: v.mime_type ?? "",
    durationSec,
    width: typeof v.width === "number" ? v.width : null,
    height: typeof v.height === "number" ? v.height : null,
    photoFiles: [...cardPhotos],
    cardPhotos,
    teaserMessageId: t?.id ?? null,
    teaserFile: t ? exportedFile(t) : null,
    teaserMimeType: t?.mime_type ?? "",
    teaserDurationSec: typeof t?.duration_seconds === "number" ? t.duration_seconds : null,
    attachedMessageIds,
    warnings,
  };
}

/**
 * Порядковые номера тем, у кого явного нет; дубликаты явных и повторы
 * названий — предупреждение. Порядковый = позиция в списке (1-based), а не
 * «следующий свободный»: так урок без номера между «Урок 2» и «Урок 4»
 * получит 3, как и ожидает владелец.
 */
function assignNumbers(lessons: LessonCandidate[]): void {
  const seen = new Map<number, number>();
  const titles = new Map<string, number>();
  lessons.forEach((lesson, i) => {
    if (lesson.number === null) lesson.number = i + 1;
    if (!lesson.title) lesson.title = `Урок ${lesson.number}`;
    const prev = seen.get(lesson.number);
    if (prev !== undefined) {
      lesson.warnings.push(`номер ${lesson.number} уже есть у урока «${lessons[prev].title}»`);
    } else {
      seen.set(lesson.number, i);
    }
    const key = lesson.title.toLocaleLowerCase("ru");
    const sameTitle = titles.get(key);
    if (sameTitle !== undefined) {
      lesson.warnings.push(`название повторяется — такое же у урока ${lessons[sameTitle].number}`);
    } else {
      titles.set(key, i);
    }
  });
}

/* ─────────────────── подбор файлов к невыгруженным видео ─────────────────── */

/** Видео из папки video_files/, уже прощупанное ffprobe (см. importRoutes). */
export type FolderVideo = {
  /** Путь относительно папки экспорта: «video_files/Банан.mp4». */
  file: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** ffprobe файл не прочитал: оборванная загрузка (нет moov atom), не видео. */
  broken: boolean;
};

export type FileStatus = "exported" | "resolved" | "ambiguous" | "missing" | "broken";

export type FileResolution = {
  file: string | null;
  status: FileStatus;
  /** Подходящие по длительности файлы, когда выбрать надо владельцу. */
  candidates: string[];
  note: string | null;
  sizeBytes: number;
  durationSec: number | null;
};

export type ResolvedLesson = LessonCandidate & { video: FileResolution; teaser: FileResolution | null };

/** Выбор владельца в панели для одного урока: файл урока и/или тизера.
 *  null/undefined — «не выбирал», решает подбор по длительности. */
export type LessonFileOverride = { videoFile?: string | null; teaserFile?: string | null };

/** Telegram пишет длительность целым, ОТБРАСЫВАЯ дробную часть: файл на
 *  742.27 с в JSON — 742. Допуск снизу — на округление ffprobe. */
const DURATION_LOW_SEC = 0.5;
const DURATION_HIGH_SEC = 1.5;

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

type Slot = {
  lesson: ResolvedLesson;
  role: "video" | "teaser";
  durationSec: number | null;
  width: number | null;
  height: number | null;
  candidates: FolderVideo[];
  chosen: FolderVideo | null;
};

/**
 * ПОДБОР ФАЙЛОВ К ВИДЕО БЕЗ ФАЙЛА. Экспорт с маленьким лимитом размера
 * оставляет в JSON только длительность и размер кадра, а сами ролики владелец
 * скачал отдельно под их исходными именами. Сопоставляем:
 *  1. по длительности (±, см. выше), среди файлов, которые не заняты
 *     выгруженными сообщениями и не повреждены; при нескольких — предпочитаем
 *     совпавший размер кадра;
 *  2. по ПОДСКАЗКЕ ИЗ ИМЕНИ СОСЕДА: тизер «Дубайский чизкейк-копия(1).mp4»
 *     говорит, что урок с тремя одинаковыми «742 с» — «Дубайский чизкейк.mp4»;
 *  3. однозначные назначения снимают файл с остальных — и так, пока
 *     что-то меняется (три урока по 742 с так разбираются хотя бы частично).
 * Что осталось неоднозначным — с перечнем кандидатов: в панели владелец
 * выбирает сам, это честнее угадывания.
 *
 * Название урока без подписи берётся из подобранного файла.
 *
 * `overrides` — что владелец выбрал в панели среди кандидатов. Применяется ДО
 * подбора: выбранный файл сразу занят и выпадает из кандидатов остальных, и
 * тогда «три урока по 742 с» после одного выбора разбираются сами (05.09.2026:
 * раньше запуск импорта звал подбор без выбора владельца, и урок с
 * заглушкой «File exceeds…» падал на «файл не найден»).
 */
export function resolveVideoFiles(
  lessons: LessonCandidate[],
  folder: FolderVideo[],
  overrides?: ReadonlyMap<number, LessonFileOverride>
): ResolvedLesson[] {
  const byPath = new Map(folder.map((f) => [normPath(f.file), f]));
  const taken = new Set<string>();
  const out: ResolvedLesson[] = lessons.map((l) => ({ ...l, video: emptyResolution(), teaser: null }));

  const exportedResolution = (file: string): FileResolution => {
    const f = byPath.get(normPath(file));
    if (!f) return { ...emptyResolution(), file, status: "missing", note: `файла ${file} нет в папке экспорта` };
    taken.add(normPath(f.file));
    if (f.broken) {
      return { ...fromFolder(f), status: "broken", note: "файл повреждён (загрузка оборвалась, нет moov atom) — скачайте заново" };
    }
    return { ...fromFolder(f), status: "exported" };
  };

  /** Файл, выбранный владельцем: есть в папке и цел — занимаем; иначе null,
   *  и решает обычный подбор (а при запуске — честная ошибка «не найден»). */
  const chosenResolution = (file: string | null | undefined): FileResolution | null => {
    if (!file) return null;
    const f = byPath.get(normPath(file));
    if (!f || f.broken) return null;
    taken.add(normPath(f.file));
    return { ...fromFolder(f), status: "resolved" };
  };

  // Сначала — всё, что выгружено или выбрано владельцем: эти файлы заняты и
  // кандидатами не бывают.
  const slots: Slot[] = [];
  for (const l of out) {
    const ov = overrides?.get(l.messageId);
    const chosenVideo = chosenResolution(ov?.videoFile);
    if (chosenVideo) l.video = chosenVideo;
    else if (l.videoFile) l.video = exportedResolution(l.videoFile);
    else slots.push({ lesson: l, role: "video", durationSec: l.durationSec, width: l.width, height: l.height, candidates: [], chosen: null });

    if (l.teaserMessageId !== null) {
      const chosenTeaser = chosenResolution(ov?.teaserFile);
      if (chosenTeaser) l.teaser = chosenTeaser;
      else if (l.teaserFile) l.teaser = exportedResolution(l.teaserFile);
      else slots.push({ lesson: l, role: "teaser", durationSec: l.teaserDurationSec, width: null, height: null, candidates: [], chosen: null });
    }
  }

  const free = folder.filter((f) => !f.broken && !taken.has(normPath(f.file)) && f.durationSec !== null);
  for (const s of slots) {
    if (s.durationSec === null) continue;
    const d = s.durationSec;
    const byDuration = free.filter((f) => f.durationSec! >= d - DURATION_LOW_SEC && f.durationSec! <= d + DURATION_HIGH_SEC);
    const byDims = s.width && s.height ? byDuration.filter((f) => f.width === s.width && f.height === s.height) : [];
    s.candidates = byDims.length ? byDims : byDuration;
  }

  const titleOf = (file: string | null): string => (file ? titleFromFileName(file).toLocaleLowerCase("ru") : "");
  const siblingFile = (s: Slot): string | null =>
    s.role === "video" ? s.lesson.teaser?.file ?? null : s.lesson.video.file;

  let changed = true;
  while (changed) {
    changed = false;
    for (const s of slots) {
      if (s.chosen || s.candidates.length === 0) continue;
      let pick: FolderVideo | null = null;
      if (s.candidates.length === 1) pick = s.candidates[0];
      else {
        const hint = titleOf(siblingFile(s));
        const hinted = hint ? s.candidates.filter((f) => titleOf(f.file) === hint) : [];
        if (hinted.length === 1) pick = hinted[0];
      }
      if (!pick) continue;
      s.chosen = pick;
      changed = true;
      const key = normPath(pick.file);
      for (const other of slots) {
        if (other !== s) other.candidates = other.candidates.filter((f) => normPath(f.file) !== key);
      }
      const res: FileResolution = { ...fromFolder(pick), status: "resolved" };
      if (s.role === "video") s.lesson.video = res;
      else s.lesson.teaser = res;
    }
  }

  for (const s of slots) {
    if (s.chosen) continue;
    const res: FileResolution =
      s.candidates.length > 1
        ? {
            ...emptyResolution(),
            status: "ambiguous",
            candidates: s.candidates.map((f) => f.file),
            note: `по длительности подходят несколько файлов — выберите нужный`,
          }
        : {
            ...emptyResolution(),
            status: "missing",
            note: "файл не выгружен — увеличьте лимит размера в экспорте или положите файл в video_files",
          };
    if (s.role === "video") s.lesson.video = res;
    else s.lesson.teaser = res;
  }

  for (const l of out) {
    l.videoFile = l.video.file ?? "";
    l.teaserFile = l.teaser?.file ?? null;
    if (l.video.status === "resolved" && (l.titleSource === "generated" || l.titleSource === "filename")) {
      const t = titleFromFileName(l.videoFile);
      if (t) {
        l.title = t;
        l.titleSource = "filename";
      } else if (l.titleSource === "generated") {
        l.warnings.push("название не удалось извлечь ни из подписи, ни из имени файла — придумано");
      }
    }
    if (l.video.status === "ambiguous" && l.titleSource === "generated") {
      l.warnings.push("название появится, когда выберете файл");
    }
  }
  return out;
}

function emptyResolution(): FileResolution {
  return { file: null, status: "missing", candidates: [], note: null, sizeBytes: 0, durationSec: null };
}

function fromFolder(f: FolderVideo): FileResolution {
  return { file: f.file, status: "exported", candidates: [], note: null, sizeBytes: f.sizeBytes, durationSec: f.durationSec };
}
