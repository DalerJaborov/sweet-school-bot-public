import type { Dict } from "./i18n";
import { useCatalog } from "./catalog";
import { displayTitle, type SiteCourse } from "./api";
import { openChat } from "./chat/bus";

/**
 * Карточки онлайн-курсов из /api/site/courses. Цены на сайте НИКОГДА не
 * зашиты в разметку: владелица меняет их в панели, и сайт должен показать
 * новое сразу. До ответа — скелет той же формы, чтобы страница не прыгала;
 * без JS поисковик видит текст-заглушку из статичной разметки.
 */
export function CoursesIsland({ t, only }: { t: Dict; only?: string }) {
  const { status, data, retry } = useCatalog();

  if (status === "loading") return <CoursesSkeleton />;
  if (status === "error") {
    return (
      <div className="notice notice-danger" role="alert">
        {t.networkError}{" "}
        <button type="button" className="btn btn-soft" onClick={retry}>
          {t.retry}
        </button>
      </div>
    );
  }

  // Лендинг одного курса (only=код) показывает только его карточку — без
  // связки и без второго курса, даже если оба доступны в каталоге.
  const allCourses = only ? data.courses.filter((c) => c.code === only) : data.courses;
  const bundle = only ? null : data.bundle;
  const courses = allCourses;
  if (courses.length === 0) return <p className="notice">{t.coursesEmpty}</p>;

  const showBundle = bundle && courses.length >= 2;
  const gridClass = courses.length === 1 ? "grid-1" : showBundle ? "grid-3" : "grid-2";
  return (
    <div className={`grid ${gridClass}`}>
      {courses.map((c) => (
        <CourseCard key={c.code} course={c} t={t} />
      ))}
      {showBundle && (
        <article className="card course-card bundle-card">
          <div className="course-cover" aria-hidden="true">
            <span>🎁</span>
          </div>
          <div className="course-body">
            <h3 className="h3">{t.bundleTitle}</h3>
            <p>{courses.map((c) => displayTitle(c.title)).join(" + ")}</p>
            <ul className="course-meta">
              <li className="chip">{t.bundleSave(bundle.fullPrice - bundle.price)}</li>
            </ul>
            <div className="price price-pill">
              {t.currency(bundle.price, courses[0].currency)}
              <s>{t.bundleFullPrice(bundle.fullPrice)}</s>
            </div>
            <button type="button" className="btn" onClick={() => openChat(t.chatPrefillBundle)}>
              {t.buyBundle}
            </button>
          </div>
        </article>
      )}
    </div>
  );
}

/**
 * Пока курс не завёл свою обложку в панели (`Course.coverUrl` пуст), берём
 * дизайнерскую обложку с настоящим фото десерта (scripts/make-covers.mjs →
 * public/img/covers), а не эмодзи-заглушку — карточка курса видна на сайте
 * первой. Ключ — код курса, не название: он не меняется при переименованиях.
 * Пути зашиты, а не читаются из media.json: остров не должен тащить весь
 * media.json в бандл ради двух строк.
 */
const FALLBACK_COVER: Record<string, string> = {
  COURSE50: "/img/covers/course-course50.webp",
  COURSE70: "/img/covers/course-course70.webp",
};
/** Половинный вариант той же обложки — для srcset (make-covers пишет `-sm`). */
const smallVariant = (src: string) => src.replace(/\.webp$/, "-sm.webp");
const COVER_SIZES = "(min-width: 720px) 400px, 100vw";

function CourseCard({ course, t }: { course: SiteCourse; t: Dict }) {
  const title = displayTitle(course.title);
  const fallback = FALLBACK_COVER[course.code];
  const cover = course.coverUrl ?? fallback ?? null;
  // srcset только у своих обложек: у coverUrl из панели половинного варианта нет.
  const srcSet = cover && cover === fallback ? `${smallVariant(cover)} 800w, ${cover} 1600w` : undefined;
  return (
    <article className="card course-card">
      <div className="course-cover">
        {cover ? (
          <img
            src={cover}
            srcSet={srcSet}
            sizes={srcSet ? COVER_SIZES : undefined}
            alt={t.coverAlt(title)}
            width={640}
            height={360}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span aria-hidden="true">🍰</span>
        )}
      </div>
      <div className="course-body">
        <h3 className="h3">{title}</h3>
        {course.description && <p>{course.description}</p>}
        <ul className="course-meta">
          <li className="chip">{t.lessonsCount(course.lessonsCount)}</li>
          {course.durationMin > 0 && <li className="chip">{t.durationMin(course.durationMin)}</li>}
          <li className="chip">{t.foreverChip}</li>
          <li className="chip chip-ok">{t.certificateChip}</li>
        </ul>
        <div className="price price-pill">{t.currency(course.price, course.currency)}</div>
        <button
          type="button"
          className="btn"
          aria-label={t.buyCourseAria(title)}
          onClick={() => openChat(t.chatPrefillCourse(title))}
        >
          {t.buyCourse}
        </button>
      </div>
    </article>
  );
}

function CoursesSkeleton() {
  return (
    <div className="grid grid-2" aria-busy="true" data-testid="courses-skeleton">
      {[0, 1].map((i) => (
        <div key={i} className="card skeleton-card">
          <div className="skeleton" style={{ aspectRatio: "16 / 9" }} />
          <div className="skeleton" style={{ width: "60%", height: 22 }} />
          <div className="skeleton" style={{ width: "90%" }} />
          <div className="skeleton" style={{ width: "40%", height: 28 }} />
          <div className="skeleton" style={{ height: 48, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}
