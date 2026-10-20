import { ReceiptsPage } from "./ReceiptsPage";
import { QuestionsPage } from "./QuestionsPage";

/**
 * «ЗАДАЧИ» — вторая кнопка нижней навигации: то, что ждёт решения Ширин.
 * Два inbox под одним переключателем — чеки и вопросы учениц; бейдж на
 * кнопке навигации складывает оба счётчика (App.tsx).
 */
export type TasksView = "receipts" | "questions";

export function TasksPage(props: { view: TasksView; counts: { receipts: number; questions: number }; onView: (v: TasksView) => void }) {
  const { view, counts, onView } = props;
  return (
    <>
      <div className="seg tasks-seg" role="tablist" aria-label="Задачи">
        <button role="tab" aria-selected={view === "receipts"} className={view === "receipts" ? "active" : ""} onClick={() => onView("receipts")}>
          Чеки{counts.receipts > 0 && <span className="seg-count">{counts.receipts}</span>}
        </button>
        <button role="tab" aria-selected={view === "questions"} className={view === "questions" ? "active" : ""} onClick={() => onView("questions")}>
          Вопросы{counts.questions > 0 && <span className="seg-count">{counts.questions}</span>}
        </button>
      </div>
      {view === "receipts" ? <ReceiptsPage /> : <QuestionsPage />}
    </>
  );
}
