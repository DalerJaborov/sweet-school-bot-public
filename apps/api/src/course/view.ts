import type { Certificate, Prisma } from "@prisma/client";
import { storageConfig, presignGet } from "../storage/s3.js";
import { parseStringArray, parseCourseTools } from "../json.js";
import { parseRecipeCard } from "./cardOcr.js";
import { translateMany, type CourseLanguage } from "./i18n.js";

/**
 * КАК УЧЕНИЦА ВИДИТ КУРС — ОДНА СБОРКА НА ДВЕ ДВЕРИ.
 *
 * Экран ученицы (/api/course/me) и «Посмотреть как ученица» в панели
 * (/api/course/preview/me) строят список уроков ЭТОЙ функцией. Иначе
 * предпросмотр со временем разошёлся бы с настоящим экраном, и Ширин
 * проверяла бы не то, что видят ученицы, — ради чего предпросмотр и делался.
 *
 * Функция только ЧИТАЕТ: курсы приходят готовыми, прогресс и сертификаты —
 * готовыми картами. Пишет вызывающий, и только настоящая ученица.
 */

/** Сколько живёт подписанная ссылка на фото, обложку и тизер. Шесть часов:
 *  человек читает рецепт на кухне долго, а перезагружать страницу посреди
 *  готовки не должен. */
export const PHOTO_TTL_SEC = 6 * 3600;

/** Что подгружать вместе с курсом. Корзина: удалённый урок ученице не отдаём
 *  никогда, даже в отсчёт на возврат. */
export const COURSE_TREE_INCLUDE = {
  modules: {
    orderBy: { order: "asc" },
    include: { lessons: { where: { deletedAt: null }, orderBy: { order: "asc" } } },
  },
} satisfies Prisma.CourseInclude;

export type CourseTree = Prisma.CourseGetPayload<{ include: typeof COURSE_TREE_INCLUDE }>;

type ProgressMark = { positionSec: number; percent: number; completedAt: Date | null };

export type CourseViewInput = {
  courses: CourseTree[];
  lang: CourseLanguage;
  /** Прогресс по id урока. Пустая карта — «ещё ничего не смотрела». */
  progress: Map<string, ProgressMark>;
  /** Выписанные сертификаты по id курса. */
  certificates: Map<string, Certificate>;
  /** Покупка, которой принадлежит курс; null — предпросмотр или не куплен. */
  purchaseIdFor: (courseId: string) => string | null;
};

/**
 * Курсы в том виде, в каком их рисует приложение ученицы.
 *
 * ОДНА пачка перевода на весь экран, по всем курсам разом: перевод стоит
 * времени, и десятки последовательных запросов к Gemini превратили бы открытие
 * списка уроков в долгое ожидание.
 */
export async function buildCourseViews(input: CourseViewInput) {
  const { courses, lang, progress, certificates, purchaseIdFor } = input;
  const cfg = await storageConfig();

  const source: string[] = [];
  for (const course of courses) {
    const lessonsFlat = course.modules.flatMap((m) => m.lessons);
    source.push(course.title, course.description ?? "");
    source.push(...course.modules.map((m) => m.title));
    source.push(...lessonsFlat.map((l) => l.title));
    source.push(...lessonsFlat.map((l) => l.recipeText ?? ""));
  }
  const t = await translateMany(source, lang);
  let cursor = 0;
  const next = () => t[cursor++];

  return courses.map((course) => {
    const lessonsFlat = course.modules.flatMap((m) => m.lessons);
    // Сертификат: положен, когда досмотрены ВСЕ готовые уроки курса.
    const readyLessons = lessonsFlat.filter((l) => l.status === "READY");
    const doneCount = readyLessons.filter((l) => progress.get(l.id)?.completedAt).length;
    const cert = certificates.get(course.id);
    const title = next();
    const description = next() || null;
    const moduleTitles = course.modules.map(() => next());
    const lessonTitles = lessonsFlat.map(() => next());
    const lessonRecipes = lessonsFlat.map(() => next());
    const titleOf = new Map(lessonsFlat.map((l, i) => [l.id, lessonTitles[i]]));
    const recipeOf = new Map(lessonsFlat.map((l, i) => [l.id, lessonRecipes[i] || null]));

    return {
      id: course.id,
      code: course.code,
      title,
      description,
      // Курс куплен, но материалы ещё не завезли: честно говорим об этом, а не
      // показываем пустой список уроков без объяснения (ревизия 04.09.2026).
      comingSoon: lessonsFlat.length === 0,
      purchaseId: purchaseIdFor(course.id),
      // Инструменты не переводим: названия и ссылку «где купить» владелец пишет
      // сам, на нужном языке (как рецепты — правило i18n.ts).
      toolsData: parseCourseTools(course.toolsData),
      certificate: {
        eligible: readyLessons.length > 0 && doneCount === readyLessons.length,
        done: doneCount,
        total: readyLessons.length,
        fullName: cert?.fullName ?? null,
        lang: cert?.lang ?? null,
        issuedAt: cert?.issuedAt ?? null,
        number: cert?.number ?? null,
      },
      modules: course.modules.map((m, mi) => ({
        id: m.id,
        title: moduleTitles[mi],
        lessons: m.lessons.map((l) => {
          const pr = progress.get(l.id);
          return {
            id: l.id,
            title: titleOf.get(l.id) ?? l.title,
            durationSec: l.durationSec,
            ready: l.status === "READY",
            recipeText: recipeOf.get(l.id) ?? l.recipeText,
            // Структурированный рецепт (карточка v2) — БЕЗ перевода: названия
            // ингредиентов остаются на языке карточки.
            recipeData: l.recipeData ? parseRecipeCard(l.recipeData) : null,
            // Подписанными ссылками, а не публичными: бакет закрыт целиком.
            recipePhotos: cfg
              ? parseStringArray(l.recipePhotos).map((path) => presignGet(cfg, path, PHOTO_TTL_SEC))
              : [],
            posterUrl: cfg && l.posterPath ? presignGet(cfg, l.posterPath, PHOTO_TTL_SEC) : null,
            teaserUrl: cfg && l.teaserMp4Path ? presignGet(cfg, l.teaserMp4Path, PHOTO_TTL_SEC) : null,
            // Обложки 16:9/9:16 (storage/coverArt.ts); null у старых уроков —
            // тогда в интерфейсе используется posterUrl.
            coverUrl: cfg && l.coverPath ? presignGet(cfg, l.coverPath, PHOTO_TTL_SEC) : null,
            storyUrl: cfg && l.storyPath ? presignGet(cfg, l.storyPath, PHOTO_TTL_SEC) : null,
            positionSec: pr?.positionSec ?? 0,
            percent: pr?.percent ?? 0,
            completed: Boolean(pr?.completedAt),
          };
        }),
      })),
    };
  });
}
