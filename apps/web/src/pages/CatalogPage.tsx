import { Suspense } from "react";
import { lazyPage } from "../panel/lazy";
import { SkeletonList } from "../components/Skeleton";

const CoursesPage = lazyPage(() => import("./CoursesPage"), "CoursesPage");
const TextsPage = lazyPage(() => import("./TextsPage"), "TextsPage");

/**
 * «КУРСЫ И ЦЕНЫ» — одна кнопка внизу, два экрана под переключателем:
 * сами курсы (уроки, видео) и цены с реквизитами. Раньше «Тексты и цены» были
 * спрятаны в «Ещё», хотя цену меняют чаще, чем что-либо другое.
 */
export type CatalogView = "courses" | "texts";

export function CatalogPage(props: {
  view: CatalogView;
  onView: (v: CatalogView) => void;
  onReview: (lessonId: string | null) => void;
}) {
  const { view, onView, onReview } = props;
  return (
    <>
      <div className="seg tasks-seg" role="tablist" aria-label="Курсы и цены">
        <button
          role="tab"
          aria-selected={view === "courses"}
          className={view === "courses" ? "active" : ""}
          onClick={() => onView("courses")}
        >
          Курсы
        </button>
        <button
          role="tab"
          aria-selected={view === "texts"}
          className={view === "texts" ? "active" : ""}
          onClick={() => onView("texts")}
        >
          Цены и тексты
        </button>
      </div>
      <Suspense fallback={<SkeletonList rows={3} height={96} />}>
        {view === "courses" ? <CoursesPage onReview={onReview} /> : <TextsPage />}
      </Suspense>
    </>
  );
}
