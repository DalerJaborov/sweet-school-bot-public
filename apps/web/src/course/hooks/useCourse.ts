import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CourseError,
  coursesOf,
  lessonsOf,
  loadCourse,
  offlinePayload,
  openWithToken,
  pairDevice,
  patchProgress,
  saveLanguage,
  saveProgress,
  saveProgressBeacon,
  type CourseInfo,
  type CourseView,
  type DeviceLimitData,
  type LessonView,
  type SchoolContacts,
} from "../api";
import { applyLang, dict, type Lang } from "../i18n";
import {
  clearMe,
  downloadLesson,
  enqueueProgress,
  evictIfNeeded,
  flushProgressQueue,
  listLessons,
  loadMe,
  markCompleted,
  markLessonOpened,
  markUsed,
  registerServiceWorker,
  requestPersistentStorage,
  saveMe,
  savePair,
  sweepPartials,
  updateCachedProgress,
  type OfflineLesson,
} from "../offline";
import { environment } from "../install/detect";
import { reloadWithoutToken } from "../install/reload";
import { useOnline } from "./useOnline";

/**
 * ДАННЫЕ ПРИЛОЖЕНИЯ УЧЕНИЦЫ: вход, /me, офлайн-копия, прогресс, язык.
 *
 * ПОРЯДОК СТАРТА (03.09.2026): Service Worker + постоянное хранилище + уборка
 * оборванных загрузок → токен из адреса (только с сетью) → /me. Если сеть
 * упала — берём последний сохранённый /me и список уроков в телефоне, и
 * экран строится из них с баннером; при появлении сети — тихая перезагрузка.
 * Так офлайн перестал быть тупиком: раньше без интернета была только ошибка.
 *
 * ПРОГРЕСС. Онлайн уходит сразу (при уходе со страницы — через sendBeacon);
 * офлайн — правит сохранённую копию и копится в очереди, которую сливаем при
 * `online`. Локальная копия /me правится в обоих случаях: чип «продолжить с
 * 12:30» должен показывать то, что человек смотрел минуту назад.
 */

/** После скольких секунд просмотра урок считается «нужным» и сохраняется. */
const AUTOSAVE_AFTER_SEC = 30;

export type Source = "network" | "cache";
export type CourseErrorState = { message: string; reason: string };
export type ProgressVia = "fetch" | "beacon";
/** Экран лимита устройств: что занято, сколько замен, куда писать. */
export type DeviceLimitState = DeviceLimitData & { school: SchoolContacts | null; busy: boolean };

export function useCourse() {
  const online = useOnline();
  const [view, setView] = useState<CourseView | null>(null);
  const [source, setSource] = useState<Source>("network");
  const [error, setError] = useState<CourseErrorState | null>(null);
  const [offline, setOffline] = useState<Record<string, OfflineLesson | undefined>>({});
  const [saving, setSaving] = useState<Record<string, number>>({});
  // Рефы — чтобы колбэки прогресса (они летят из плеера раз в 10 с) не
  // пересоздавались и не тянули за собой устаревшие замыкания.
  const offlineRef = useRef(offline);
  const savingRef = useRef(saving);
  offlineRef.current = offline;
  savingRef.current = saving;

  const lang: Lang = view?.profile?.language ?? "ru";
  const t = useMemo(() => dict(lang), [lang]);
  useEffect(() => applyLang(lang), [lang]);

  const courses: CourseInfo[] = useMemo(() => (view ? coursesOf(view) : []), [view]);
  const lessons = useMemo(() => courses.flatMap(lessonsOf), [courses]);

  // Встроенный браузер + токен в адресе: сначала выводим в настоящий браузер.
  const [inAppTrap, setInAppTrap] = useState(false);
  const [deviceLimit, setDeviceLimit] = useState<DeviceLimitState | null>(null);

  /**
   * Первый заход: в адресе есть токен из переписки (`?token=`) или токен
   * спаривания из start_url установленного приложения (`?pair=`).
   *
   *  - Встроенный браузер Instagram/Telegram + `?token=`: НЕ входим и токен
   *    НЕ трогаем — показываем экран «откройте в браузере», он уносит тот же
   *    адрес в Safari/Chrome. Вход там занял бы место в лимите телефоном,
   *    с которого потом всё равно смотреть нельзя (нет офлайна и установки).
   *  - Лимит устройств (429 с списком): экран выбора «заменить самое старое»;
   *    токен остаётся в адресе, чтобы повторить /open с replaceOldest.
   *  - Успешный вход — перезагрузка без токена (см. install/reload.ts).
   *  - `?pair=` — обмен на куки того же устройства, токен сохраняем в
   *    телефоне для тихого восстановления сессии (api.ts), адрес чистим.
   */
  const bootstrap = useCallback(async (silent = false, replaceOldest = false) => {
    const params = new URLSearchParams(window.location.search);
    // Короткая ссылка /l/<код> — код в пути; старая ?token= — тоже принимаем.
    const shortMatch = /^\/l\/([A-Za-z0-9]{6,32})$/.exec(window.location.pathname);
    const token = shortMatch?.[1] ?? params.get("token");
    const pair = params.get("pair");
    try {
      if (token && navigator.onLine) {
        if (environment().inApp) {
          setInAppTrap(true);
          return;
        }
        try {
          await openWithToken(token, replaceOldest);
        } catch (err) {
          const limit = err instanceof CourseError ? err.deviceLimit() : null;
          if (limit) {
            const cached = await loadMe().catch(() => undefined);
            setDeviceLimit({ ...limit, school: cached?.view.school ?? null, busy: false });
            setError(null);
            return;
          }
          throw err;
        }
        setDeviceLimit(null);
        reloadWithoutToken();
        return;
      }
      if (pair && navigator.onLine) {
        try {
          await pairDevice(pair);
          await savePair(pair).catch(() => undefined);
        } catch (err) {
          // Доступ закрыт — это ответ по существу, показываем его. Остальное
          // (истёк, сеть) не мешает: куки могут уже быть, /me ниже разберётся.
          if (err instanceof CourseError && (err.reason === "revoked" || err.reason === "blocked")) throw err;
        }
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
      const fresh = await loadCourse();
      setView(fresh);
      setSource("network");
      setError(null);
      void saveMe(fresh).catch(() => undefined);
    } catch (err) {
      if (err instanceof CourseError) {
        // Отказ сервера — не сеть: сохранённая копия тут лжёт, её убираем.
        const denied = err.reason === "revoked" || err.reason === "blocked";
        if (denied) {
          void clearMe().catch(() => undefined);
          setView(null);
          setOffline({});
        }
        if (!silent || denied) setError({ message: err.message, reason: err.reason });
        return;
      }
      const cached = await loadMe().catch(() => undefined);
      if (cached) {
        setView((v) => v ?? cached.view);
        setSource((s) => (silent ? s : "cache"));
        setError(null);
      } else if (!silent) {
        setError({ message: "", reason: "network" });
      }
    }
  }, []);

  /** Ученица подтвердила: это её новый телефон — вытесняем самое старое. */
  const replaceOldestDevice = useCallback(async () => {
    setDeviceLimit((d) => (d ? { ...d, busy: true } : d));
    await bootstrap(false, true);
    setDeviceLimit((d) => (d ? { ...d, busy: false } : d));
  }, [bootstrap]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      void registerServiceWorker();
      void requestPersistentStorage();
      await sweepPartials().catch(() => undefined);
      if (!cancelled) await bootstrap();
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  // Что уже лежит в телефоне — чтобы показать чип и открыть без сети.
  // Зависимость — список id, а не объекты уроков: прогресс правит объекты
  // каждые 10 секунд, и перечитывать базу из-за этого незачем.
  const lessonIds = lessons.map((l) => l.id).join(",");
  useEffect(() => {
    if (!lessonIds) {
      setOffline({});
      return;
    }
    let cancelled = false;
    void listLessons()
      .then((saved) => {
        if (cancelled) return;
        const entries: Record<string, OfflineLesson | undefined> = {};
        for (const meta of saved) entries[meta.lessonId] = meta;
        setOffline(entries);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lessonIds]);

  // Появилась сеть — досылаем прогресс и тихо обновляем экран. Именно
  // ПОЯВИЛАСЬ: при старте с сетью эффект тоже срабатывает, и раньше это
  // давало второй bootstrap параллельно первому — с токеном в адресе это два
  // /open разом (и два экрана лимита). Первый прогон пропускаем.
  const wasOnline = useRef(online);
  useEffect(() => {
    const came = online && !wasOnline.current;
    wasOnline.current = online;
    if (!came) return;
    void flushProgressQueue((item) => saveProgress(item.lessonId, item.positionSec, item.percent))
      .catch(() => undefined)
      .then(() => bootstrap(true));
  }, [online, bootstrap]);

  const cacheLesson = useCallback(async (lesson: LessonView) => {
    if (offlineRef.current[lesson.id] || savingRef.current[lesson.id] !== undefined || !navigator.onLine) return;
    setSaving((s) => ({ ...s, [lesson.id]: 0 }));
    try {
      const payload = await offlinePayload(lesson.id);
      // Освобождаем место заранее: узнать точный размер до загрузки нельзя,
      // поэтому берём оценку по длительности (около мегабайта на 8 секунд
      // в 480p) — этого достаточно, чтобы решить, что вытеснять.
      await evictIfNeeded(Math.max(payload.segments.length, 1) * 1_200_000);
      const ok = await downloadLesson(
        { ...payload, posterUrl: lesson.posterUrl, photoUrls: lesson.recipePhotos },
        lesson.title,
        (done, total) => setSaving((s) => ({ ...s, [lesson.id]: Math.round((done / total) * 100) })),
      );
      if (ok) {
        const saved = await listLessons();
        const meta = saved.find((m) => m.lessonId === lesson.id);
        setOffline((o) => ({ ...o, [lesson.id]: meta }));
      }
    } catch {
      // Не вышло — попробуем при следующем просмотре.
    } finally {
      setSaving((s) => {
        const copy = { ...s };
        delete copy[lesson.id];
        return copy;
      });
    }
  }, []);

  const reportProgress = useCallback(
    (lesson: LessonView, positionSec: number, percent: number, via: ProgressVia = "fetch") => {
      setView((v) => (v ? patchProgress(v, lesson.id, positionSec, percent) : v));
      if (percent >= 95) void markCompleted(lesson.id).catch(() => undefined);
      if (navigator.onLine) {
        if (via === "beacon") saveProgressBeacon(lesson.id, positionSec, percent);
        else
          void saveProgress(lesson.id, positionSec, percent).catch(() =>
            enqueueProgress({ lessonId: lesson.id, positionSec, percent, at: Date.now() }).catch(() => undefined),
          );
      } else {
        void enqueueProgress({ lessonId: lesson.id, positionSec, percent, at: Date.now() }).catch(() => undefined);
        void updateCachedProgress(lesson.id, positionSec, percent).catch(() => undefined);
      }
      // Смотрит по-настоящему — значит урок ей нужен и в дороге тоже.
      if (positionSec >= AUTOSAVE_AFTER_SEC) void cacheLesson(lesson);
    },
    [cacheLesson],
  );

  const noteOpened = useCallback((lessonId: string) => {
    void markUsed(lessonId).catch(() => undefined);
    // С первого открытого урока можно предлагать установку на экран «Домой»:
    // до этого человек ещё не понял, зачем ему приложение.
    void markLessonOpened().catch(() => undefined);
  }, []);

  const switchLanguage = useCallback(async (next: Lang) => {
    // Показываем новый язык сразу, не дожидаясь сети: подтверждение с сервера
    // ничего не добавляет к тому, что человек только что нажал сам.
    setView((v) =>
      v ? { ...v, profile: { ...(v.profile ?? { firstName: null, lastName: null }), language: next } } : v,
    );
    try {
      await saveLanguage(next);
      // Содержимое (названия уроков, рецепты) переводит сервер — поэтому
      // перечитываем: без этого сменились бы только надписи интерфейса.
      const fresh = await loadCourse();
      setView(fresh);
      void saveMe(fresh).catch(() => undefined);
    } catch {
      // Не долетело — надписи уже на новом языке, содержимое подтянется при
      // следующем открытии. Пугать человека ошибкой тут не за что.
    }
  }, []);

  return {
    view,
    error,
    inAppTrap,
    deviceLimit,
    replaceOldestDevice,
    source,
    online,
    lang,
    t,
    courses,
    lessons,
    offline,
    saving,
    retry: () => void bootstrap(),
    switchLanguage,
    reportProgress,
    noteOpened,
  };
}

export type CourseState = ReturnType<typeof useCourse>;
