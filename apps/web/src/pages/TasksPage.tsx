import { ReceiptsPage } from "./ReceiptsPage";
import { QuestionsPage } from "./QuestionsPage";
import { AttentionPage } from "./AttentionPage";

/**
 * «ЗАДАЧИ» — вторая кнопка нижней навигации: то, что ждёт решения Ширин.
 * Два inbox под одним переключателем — чеки и вопросы учениц; бейдж на
 * кнопке навигации складывает оба счётчика (App.tsx).
 */
export type TasksView = "receipts" | "questions" | "attention";

export function TasksPage(props: { view: TasksView; counts: { receipts: number; questions: number; attention: number }; onView: (v: TasksView) => void; onChange?: () => void }) {
  const { view, counts, onView, onChange } = props;
  return (
    <>
      <div className="seg tasks-seg" role="tablist" aria-label="Чеки и вопросы">
        <button role="tab" aria-selected={view === "receipts"} className={view === "receipts" ? "active" : ""} onClick={() => onView("receipts")}>
          Чеки{counts.receipts > 0 && <span className="seg-count">{counts.receipts}</span>}
        </button>
        <button role="tab" aria-selected={view === "questions"} className={view === "questions" ? "active" : ""} onClick={() => onView("questions")}>
          Вопросы учениц{counts.questions > 0 && <span className="seg-count">{counts.questions}</span>}
        </button>
        <button role="tab" aria-selected={view === "attention"} className={view === "attention" ? "active" : ""} onClick={() => onView("attention")}>
          Нужен ответ{counts.attention > 0 && <span className="seg-count">{counts.attention}</span>}
        </button>
      </div>
      {view === "receipts" ? <ReceiptsPage /> : view === "questions" ? <QuestionsPage /> : <AttentionPage onChange={onChange} />}
    </>
  );
}
