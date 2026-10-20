/**
 * Клиент API платформы. Отличается от панельного (src/api.ts) тем, что не носит
 * заголовок с токеном: у ученицы сессия в httpOnly-куке, которую JavaScript не
 * видит и не может случайно утечь. Отсюда `credentials: "include"` везде.
 *
 * Сообщения об ошибках сервер отдаёт по-русски, но приложение показывает их
 * только вместе с подсказкой из словаря (см. screens/ErrorScreen.tsx) —
 * подсказка на языке ученицы объясняет, что делать.
 */

import { clearPair, loadPair } from "./offline";

const BASE = "/api/course";

/** Одно из устройств ученицы — как его описывает сервер при лимите. */
export type DeviceInfo = {
  id: string;
  /** Подпись сервера: «iPhone» | «Android» | «Компьютер» | «Устройство». */
  label: string;
  city: string | null;
  lastSeenAt: string | null;
  blocked: boolean;
};

/** Тело ответа 429 device_limit: что занято и сколько замен осталось. */
export type DeviceLimitData = { devices: DeviceInfo[]; swapsLeft: number };

export class CourseError extends Error {
  status: number;
  reason: string;
  /** Доп. поля ответа: при device_limit — устройства и число замен. */
  data?: Record<string, unknown>;
  constructor(status: number, message: string, reason: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.data = data;
  }

  /** Список устройств из 429 — если сервер его прислал. */
  deviceLimit(): DeviceLimitData | null {
    if (this.reason !== "device_limit" || !this.data) return null;
    const devices = this.data.devices;
    const swapsLeft = this.data.swapsLeft;
    if (!Array.isArray(devices) || typeof swapsLeft !== "number") return null;
    return { devices: devices as DeviceInfo[], swapsLeft };
  }
}

/**
 * Обмен токена спаривания на сессионные куки — один на все параллельные
 * запросы: если три запроса разом получили 401, нам нужен один /pair, а не три.
 */
let pairing: Promise<void> | null = null;

function repairSession(): Promise<void> {
  if (!pairing) {
    pairing = (async () => {
      const token = await loadPair().catch(() => undefined);
      if (!token) throw new CourseError(401, "no session", "no_session");
      try {
        await pairDevice(token);
      } catch (err) {
        // Отказ по существу (доступ закрыт) — токен больше не нужен;
        // сетевую ошибку оставляем: в следующий раз может получиться.
        if (
          err instanceof CourseError &&
          (err.reason === "revoked" || err.reason === "blocked" || err.status === 404)
        ) {
          void clearPair().catch(() => undefined);
        }
        throw err;
      }
    })().finally(() => {
      pairing = null;
    });
  }
  return pairing;
}

/**
 * Один запрос к API. При 401 «нет сессии» — если в телефоне есть токен
 * спаривания (см. offline.ts/savePair), один раз восстанавливаем куки через
 * /pair и повторяем запрос. Ровно один раз: `retried` защищает от петли, если
 * сервер и после /pair отвечает 401.
 */
async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; reason?: string } & Record<string, unknown>;
  if (!res.ok) {
    const reason = data.reason ?? "unknown";
    if (res.status === 401 && reason === "no_session" && !retried && path !== "/pair" && path !== "/open") {
      let repaired = false;
      try {
        await repairSession();
        repaired = true;
      } catch {
        // Нечем чинить — отдаём исходный 401 ниже.
      }
      if (repaired) return request<T>(path, init, true);
    }
    if (reason === "revoked" || reason === "blocked") void clearPair().catch(() => undefined);
    throw new CourseError(res.status, data.error ?? `HTTP ${res.status}`, reason, data);
  }
  return data as T;
}

/**
 * РЕЦЕПТ ИЗ РАСПОЗНАВАНИЯ КАРТОЧКИ (apps/api/src/course/cardOcr.ts), тот же
 * набор полей, что кладётся в Lesson.recipeData. Названия ингредиентов и
 * группы приходят как есть, БЕЗ перевода (правило i18n.ts): переводит только
 * markdown-версия в recipeText, а числа и надписи владельца трогать нельзя.
 */
export type RecipeCardItem = {
  ingredient: string;
  amount: string | null;
  unit: string | null;
  note: string | null;
  emoji: string | null;
};
export type RecipeCardComponent = { name: string; items: RecipeCardItem[] };
export type RecipeCardData = { title: string; components: RecipeCardComponent[]; language: string };

export type LessonView = {
  id: string;
  title: string;
  durationSec: number | null;
  ready: boolean;
  recipeText: string | null;
  /** Структура того же рецепта — для карточки v2 (чекбоксы, ×0.5/×2). null —
   *  рецепт вписан текстом вручную (без распознавания карточки) или это
   *  сохранённая до релиза копия /me без этого поля вовсе: тогда экран
   *  урока показывает recipeText как обычный текст. */
  recipeData?: RecipeCardData | null;
  recipePhotos: string[];
  /** Кадр из видео для строки урока; null, пока перекодировка не сделала постер. */
  posterUrl: string | null;
  /**
   * Обложка 1280×720 (кадр тизера/постера + бренд-слои — номер и название уже
   * впечатаны, см. apps/api/src/storage/coverArt.ts), null — ещё не
   * сгенерирована. Карточка урока в сетке (§3) падает на неё, затем на
   * posterUrl, затем на плейсхолдер: у уроков, импортированных до бэкфила,
   * coverUrl ещё нет — это обычный случай сегодня, не редкий.
   */
  coverUrl?: string | null;
  /** Короткий ролик-анонс (mp4 480p, подписанная ссылка); null — тизера нет. */
  teaserUrl?: string | null;
  /** Вертикальная обложка 1080×1920 для геройского экрана и шаринга в сторис. */
  storyUrl?: string | null;
  positionSec: number;
  percent: number;
  completed: boolean;
};

export type ModuleView = { id: string; title: string; lessons: LessonView[] };

/**
 * Сертификат курса (бэкенд 03.09.2026). `eligible` — все уроки пройдены;
 * `issuedAt`/`number` заполнены, если сертификат уже выписывали: тогда его
 * можно скачать повторно без формы.
 */
export type CourseCertificate = {
  eligible: boolean;
  done: number;
  total: number;
  fullName: string | null;
  lang: "ru" | "tg" | null;
  issuedAt: string | null;
  number: number | null;
};

/**
 * Инструмент курса (Course.toolsData, визуальная система 04.09.2026, §5):
 * насадка, форма и т.п. — экран «Набор инструментов». Название и ссылка «где
 * купить» приходят как написал владелец, без перевода (та же логика, что у
 * RecipeCardData). photoUrl — null, пока владелец не загрузил фото: тогда
 * карточка показывает плейсхолдер, а не сломанную картинку.
 */
export type CourseTool = { name: string; photoUrl: string | null; toolNumber: string | null; buyLink: string | null };

export type CourseInfo = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  purchaseId: string | null;
  modules: ModuleView[];
  /** Необязательно: сохранённая до релиза копия /me в телефоне поля не имеет. */
  certificate?: CourseCertificate;
  /** Курс куплен, но материалов ещё нет ни одного (ждёт импорта). */
  comingSoon?: boolean;
  /** Необязательно по той же причине, что и recipeData: старая сохранённая
   *  копия /me этого поля не знает. */
  toolsData?: CourseTool[];
};

export type SchoolContacts = {
  telegram: string | null;
  instagram: string | null;
  whatsapp: string | null;
};

/**
 * Контакты Ширин БЕЗ сессии — для экрана отказа, где /me недоступен. Публичный
 * адрес, без куки и без починки сессии: 401 здесь невозможен, а сетевой сбой
 * возвращает null — экран покажет, что сможет.
 */
export async function loadSchoolContacts(): Promise<SchoolContacts | null> {
  try {
    const res = await fetch(`${BASE}/contacts`);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<SchoolContacts>;
    return { telegram: data.telegram ?? null, instagram: data.instagram ?? null, whatsapp: data.whatsapp ?? null };
  } catch {
    return null;
  }
}

export type CourseProfile = {
  firstName: string | null;
  lastName: string | null;
  language: "ru" | "tg" | null;
};

export type CourseView = {
  ready: boolean;
  message?: string;
  offlineUntil: string | null;
  offlineRendition?: string;
  /** Водяной знак приходит с сервера: имя ученицы плюс хвост её номера. */
  watermark?: string;
  /** null в language — знакомство ещё не пройдено, показываем выбор языка. */
  profile?: CourseProfile;
  school?: SchoolContacts;
  /** Все купленные курсы — в одном окне (владелец 03.09.2026). */
  courses?: CourseInfo[];
  /** Алиас на один релиз: старая сборка в кеше SW ждёт единственный `course`. */
  course?: CourseInfo | null;
};

/** Курсы из ответа: новая форма — `courses[]`, старая — один `course`. */
export function coursesOf(view: CourseView): CourseInfo[] {
  if (view.courses && view.courses.length > 0) return view.courses;
  return view.course ? [view.course] : [];
}

export function lessonsOf(course: CourseInfo): LessonView[] {
  return course.modules.flatMap((m) => m.lessons);
}

/**
 * Вписать прогресс в уже полученный /me, не перечитывая его: чип «продолжить
 * с 12:30» в списке должен отражать то, что человек только что смотрел, — и
 * онлайн, и без сети (тогда так же правится сохранённая копия).
 */
export function patchProgress(view: CourseView, lessonId: string, positionSec: number, percent: number): CourseView {
  const patchLesson = (l: LessonView): LessonView =>
    l.id === lessonId ? { ...l, positionSec, percent, completed: l.completed || percent >= 95 } : l;
  const patchCourse = (c: CourseInfo): CourseInfo => ({
    ...c,
    modules: c.modules.map((m) => ({ ...m, lessons: m.lessons.map(patchLesson) })),
  });
  return {
    ...view,
    courses: view.courses?.map(patchCourse),
    course: view.course ? patchCourse(view.course) : view.course,
  };
}

/**
 * Отпечаток УСТРОЙСТВА для защиты от раздачи ссылки. Он не опознаёт человека —
 * только отличает один аппарат от другого.
 *
 * Сюда намеренно НЕ входит ничего, что меняется от браузера к браузеру: ссылка
 * из директа открывается во встроенном браузере Instagram, а смотреть человек
 * уходит в обычный, и такой отпечаток посчитал бы один телефон двумя
 * устройствами. Язык интерфейса тоже исключён — его меняют.
 */
export function browserFingerprint(): string {
  const parts = [
    String(screen.width),
    String(screen.height),
    String(screen.colorDepth),
    String(window.devicePixelRatio ?? ""),
    String(new Date().getTimezoneOffset()),
    String(navigator.hardwareConcurrency ?? ""),
  ];
  return parts.join("~");
}

/**
 * Вход по ссылке из переписки. `replaceOldest` — ученица подтвердила на
 * экране лимита, что это её новый телефон: сервер вытеснит самое старое
 * устройство. Без подтверждения на 429 прилетает CourseError c `data`:
 * список устройств и сколько замен осталось (см. CourseError.deviceLimit).
 */
export function openWithToken(token: string, replaceOldest = false): Promise<{ ok: boolean; contactId: string }> {
  return request("/open", {
    method: "POST",
    body: JSON.stringify({
      token,
      fingerprint: browserFingerprint(),
      ...(replaceOldest ? { replaceOldest: true } : {}),
    }),
  });
}

/**
 * Спаривание: те же сессионные куки для ТОГО ЖЕ устройства, нового места в
 * лимите не занимает. Вызывается по `?pair=` из start_url личного манифеста
 * и из request() при потере кук. Сам никогда не повторяется (retried=true).
 */
export function pairDevice(pair: string): Promise<{ ok: boolean; contactId: string }> {
  return request("/pair", { method: "POST", body: JSON.stringify({ pair }) }, true);
}

export function loadCourse(): Promise<CourseView> {
  return request("/me");
}

/** Знакомство: язык и имя. После него /me отдаёт уроки уже на нужном языке. */
export function saveProfile(input: {
  firstName: string;
  lastName: string;
  language: "ru" | "tg";
}): Promise<{ ok: boolean }> {
  return request("/profile", { method: "POST", body: JSON.stringify(input) });
}

/** Смена языка без повторного ввода имени. */
export function saveLanguage(language: "ru" | "tg"): Promise<{ ok: boolean }> {
  return request("/language", { method: "POST", body: JSON.stringify({ language }) });
}

export type IssuedCertificate = {
  ok: boolean;
  fullName: string;
  lang: "ru" | "tg";
  number: number;
  issuedAt: string;
};

/**
 * Выписать сертификат: имя печатается так, как ввела ученица, — поэтому
 * оно уходит отдельно от профиля. 409 — курс ещё не пройден.
 */
export function requestCertificate(input: {
  courseId: string;
  firstName: string;
  lastName: string;
  lang: "ru" | "tg";
}): Promise<IssuedCertificate> {
  return request("/certificate", { method: "POST", body: JSON.stringify(input) });
}

/** Адрес PDF: открывается в новой вкладке, кука сессии уходит сама (same-origin). */
export function certificateUrl(courseId: string, lang: "ru" | "tg"): string {
  return `${BASE}/certificate/${encodeURIComponent(courseId)}.pdf?lang=${lang}`;
}

/** Адрес PNG 1080×1350 для шаринга в Instagram (визуальная система §6) —
 *  тот же сертификат, другой формат, та же авторизация same-origin. */
export function certificatePngUrl(courseId: string, lang: "ru" | "tg"): string {
  return `${BASE}/certificate/${encodeURIComponent(courseId)}.png?lang=${lang}`;
}

export function manifestUrl(lessonId: string): string {
  return `${BASE}/lessons/${lessonId}/manifest`;
}

export type OfflinePayload = {
  lessonId: string;
  rendition: string;
  keyUrl: string;
  variantUrl: string;
  segments: string[];
};

export function offlinePayload(lessonId: string): Promise<OfflinePayload> {
  return request(`/lessons/${lessonId}/offline`);
}

export function saveProgress(lessonId: string, positionSec: number, percent: number): Promise<{ completed: boolean }> {
  return request(`/lessons/${lessonId}/progress`, {
    method: "POST",
    body: JSON.stringify({ positionSec, percent }),
  });
}

/**
 * Прогресс в момент, когда страница уходит (свернули, закрыли вкладку):
 * обычный fetch браузер в этот момент вправе оборвать, sendBeacon — обещает
 * доставить. Тело — Blob с типом JSON: бэкенд (03.09.2026) читает его как
 * обычный запрос. Куки с beacon уходят сами (same-origin).
 */
export function saveProgressBeacon(lessonId: string, positionSec: number, percent: number): boolean {
  const body = JSON.stringify({ positionSec, percent });
  const url = `${BASE}/lessons/${lessonId}/progress`;
  if (typeof navigator.sendBeacon === "function") {
    try {
      return navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } catch {
      // Падает в редких браузерах — идём обычным путём ниже.
    }
  }
  void fetch(url, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => undefined);
  return true;
}

export type ChatMessage = {
  id: string;
  fromStudent: boolean;
  text: string | null;
  createdAt: string;
  pending?: boolean;
};

export function loadChat(): Promise<{ messages: ChatMessage[] }> {
  return request("/chat");
}

export function sendChat(
  text: string,
  lessonId: string | null,
  queuedOffline = false,
): Promise<{ messages: ChatMessage[] }> {
  return request("/chat", { method: "POST", body: JSON.stringify({ text, lessonId, queuedOffline }) });
}
