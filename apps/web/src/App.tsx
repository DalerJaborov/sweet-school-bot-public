import { useCallback, useEffect, useState } from "react";
import { api, setToken, hasToken, logout, type Today } from "./api";
import { isInsideTelegram, loginViaTelegram, applyTelegramChrome } from "./telegram";
import { Logo, Icons } from "./components/Brand";
import { BakeryHero } from "./components/Illustrations";
import { ToastHost } from "./components/Toast";
import { ConfirmHost } from "./components/ConfirmDialog";
import { ChoiceHost } from "./components/ChoiceSheet";
import { Sheet } from "./components/Sheet";
import { CommandPalette, SearchButton, type SearchHit } from "./components/CommandPalette";
import { confirmLeave } from "./components/UnsavedGuard";
import { DashboardPage, type GoTab } from "./pages/DashboardPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FunnelsPage } from "./pages/FunnelsPage";
import { JournalPage } from "./pages/JournalPage";
import { TasksPage, type TasksView } from "./pages/TasksPage";
import { ClientsPage } from "./pages/ClientsPage";
import { MoneyPage } from "./pages/MoneyPage";
import { StylePage } from "./pages/StylePage";
import { QualityPage } from "./pages/QualityPage";
import { TestimonialsPage } from "./pages/TestimonialsPage";
import { MediaExamplesPage } from "./pages/MediaExamplesPage";
import { CoursesPage } from "./pages/CoursesPage";
import { ImportPage } from "./pages/ImportPage";
import { TextsPage } from "./pages/TextsPage";
import { StudentPage } from "./pages/StudentPage";
import { RecipeReviewPage } from "./pages/RecipeReviewPage";

type Tab =
  | "home"
  | "recipes"
  | "receipts"
  | "questions"
  | "clients"
  | "money"
  | "texts"
  | "courses"
  | "funnels"
  | "journal"
  | "style"
  | "media"
  | "import"
  | "quality"
  | "testimonials"
  | "settings";

type NavItem = { id: Tab; label: string; icon: JSX.Element };

/**
 * НАВИГАЦИЯ «УТРО ШИРИН» (05.09.2026): внизу четыре кнопки — Сегодня ·
 * Задачи (чеки + вопросы, с бейджем) · Ученицы · Ещё. Всё остальное — под
 * «Ещё» листом снизу; на ПК (≥900px) сайдбар показывает все разделы сразу.
 * Ни один раздел не удалён — только переставлен по частоте использования.
 */
const PRIMARY: NavItem[] = [
  { id: "home", label: "Сегодня", icon: Icons.home },
  { id: "receipts", label: "Задачи", icon: Icons.receipts },
  { id: "clients", label: "Ученицы", icon: Icons.clients },
];

const SECONDARY: NavItem[] = [
  { id: "money", label: "Деньги", icon: Icons.money },
  { id: "texts", label: "Тексты и цены", icon: Icons.journal },
  { id: "courses", label: "Курсы", icon: Icons.media },
  { id: "funnels", label: "Воронки", icon: Icons.funnels },
  { id: "journal", label: "Журнал", icon: Icons.journal },
  { id: "style", label: "Стиль", icon: Icons.style },
  { id: "media", label: "Медиа на повтор", icon: Icons.media },
  { id: "import", label: "Импорт", icon: Icons.media },
  { id: "quality", label: "Качество", icon: Icons.style },
  { id: "testimonials", label: "Отзывы", icon: Icons.testimonials },
  { id: "settings", label: "Настройки", icon: Icons.settings },
];

const TASK_TABS: Tab[] = ["receipts", "questions"];

/** Разделы, которые умеет открывать ⌘K (apps/api/src/search.ts → SECTIONS). */
const ALL_TABS = new Set<Tab>([...PRIMARY.map((p) => p.id), ...SECONDARY.map((s) => s.id), "questions", "recipes"]);
function isTab(id: string): id is Tab {
  return ALL_TABS.has(id as Tab);
}

export function App() {
  const [authed, setAuthed] = useState(hasToken());
  const [tab, setTab] = useState<Tab>("home");
  const [moreOpen, setMoreOpen] = useState(false);
  /** Проверка OCR-рецептов (§13): null — список уроков на проверку, id — карточка. */
  const [reviewLessonId, setReviewLessonId] = useState<string | null>(null);
  /** Открытая карточка ученицы — поверх вкладки «Ученицы» (StudentPage). */
  const [studentId, setStudentId] = useState<string | null>(null);
  /** Бейдж на «Задачах» — чеки в ожидании + вопросы без ответа. */
  const [counts, setCounts] = useState({ receipts: 0, questions: 0 });
  // Открыто внутри Telegram — входим сами, без пароля: подпись даёт сам Telegram.
  // Пока проверяем, форму входа не показываем, иначе она мигнёт и исчезнет.
  const [checkingTelegram, setCheckingTelegram] = useState(!hasToken() && isInsideTelegram());

  useEffect(() => {
    applyTelegramChrome();
  }, []);

  useEffect(() => {
    if (!checkingTelegram) return;
    loginViaTelegram()
      .then((ok) => setAuthed(ok))
      .finally(() => setCheckingTelegram(false));
  }, [checkingTelegram]);

  // Счётчик обновляем при каждой смене раздела: свежие цифры нужны ровно тогда,
  // когда человек что-то сделал и вернулся, а не по таймеру.
  useEffect(() => {
    if (!authed) return;
    api<Pick<Today, "pendingReceipts" | "unansweredQuestions">>("/admin/today")
      .then((d) => setCounts({ receipts: d.pendingReceipts, questions: d.unansweredQuestions }))
      // Сетевая ошибка не должна тихо обнулять бейдж — последнее известное
      // число надёжнее нуля, который выглядит как «всё ок».
      .catch((e) => console.error("task counts", e));
  }, [authed, tab]);

  const goTo = useCallback(async (id: Tab | GoTab) => {
    // Промт на 10к символов или редактор воронки посреди правки — раньше один
    // тап по нижней навигации стирал всё без вопросов.
    if (!(await confirmLeave())) return;
    setTab(id);
    setMoreOpen(false);
    setStudentId(null);
    // Возврат наверх: иначе новый раздел открывается прокрученным на ту же
    // высоту, что и предыдущий, и выглядит пустым.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const closeMore = useCallback(() => setMoreOpen(false), []);
  const openReview = useCallback(
    (lessonId: string | null) => {
      setReviewLessonId(lessonId);
      void goTo("recipes");
    },
    [goTo]
  );
  const openStudent = useCallback((id: string) => {
    setTab("clients");
    setStudentId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  /** Выбор в ⌘K: ученица → карточка, урок → «Курсы», раздел → вкладка. */
  const onSearchPick = useCallback(
    (hit: SearchHit) => {
      if (hit.type === "student") openStudent(hit.id);
      else if (hit.type === "lesson") void goTo("courses");
      else if (isTab(hit.tab)) void goTo(hit.tab);
    },
    [goTo, openStudent]
  );

  if (checkingTelegram) {
    return (
      <div className="login">
        <div className="card">
          <Logo />
          <p className="hint" style={{ margin: 0 }}>Вхожу через Telegram…</p>
        </div>
      </div>
    );
  }
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const inSecondary = SECONDARY.some((s) => s.id === tab);
  const inTasks = TASK_TABS.includes(tab);
  const taskBadge = counts.receipts + counts.questions;
  const isActive = (id: Tab) => (id === "receipts" ? inTasks : tab === id);

  return (
    <div className="app-shell">
      {/* Сайдбар для ПК (≥900px): все разделы сразу, «Ещё» не нужно. */}
      <aside className="sidebar">
        <Logo />
        <SearchButton variant="bar" />
        <nav className="sidebar-nav">
          {PRIMARY.map((item) => (
            <button
              key={item.id}
              className={isActive(item.id) ? "active" : ""}
              aria-current={isActive(item.id) ? "page" : undefined}
              onClick={() => void goTo(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.id === "receipts" && taskBadge > 0 && <span className="dot">{taskBadge}</span>}
            </button>
          ))}
          <div className="sidebar-divider" />
          {SECONDARY.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => void goTo(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <button className="sidebar-logout" onClick={() => { logout(); setAuthed(false); }}>
          Выйти
        </button>
      </aside>

      <div className="shell">
        <div className="topbar">
          <Logo />
          <div className="topbar-actions">
            <SearchButton />
            <button className="btn quiet small" onClick={() => { logout(); setAuthed(false); }} title="Выйти">
              Выйти
            </button>
          </div>
        </div>

        {tab === "home" && <DashboardPage onGo={(t) => (t === "recipes" ? openReview(null) : void goTo(t))} onOpenStudent={openStudent} />}
        {inTasks && <TasksPage view={tab as TasksView} counts={counts} onView={(v) => void goTo(v)} />}
        {tab === "clients" && studentId && <StudentPage contactId={studentId} onBack={() => setStudentId(null)} />}
        {tab === "clients" && !studentId && <ClientsPage onOpenStudent={openStudent} />}
        {tab === "money" && <MoneyPage />}
        {tab === "texts" && <TextsPage />}
        {tab === "courses" && <CoursesPage onReview={openReview} />}
        {tab === "recipes" && <RecipeReviewPage lessonId={reviewLessonId} onOpen={openReview} onBack={() => void goTo("courses")} />}
        {tab === "funnels" && <FunnelsPage />}
        {tab === "journal" && <JournalPage />}
        {tab === "style" && <StylePage />}
        {tab === "media" && <MediaExamplesPage />}
        {tab === "import" && <ImportPage onGo={(t) => (t === "recipes" ? openReview(null) : void goTo(t))} />}
        {tab === "quality" && <QualityPage />}
        {tab === "testimonials" && <TestimonialsPage />}
        {tab === "settings" && <SettingsPage />}

        <nav className="nav" aria-label="Разделы">
          {PRIMARY.map((item) => (
            <button
              key={item.id}
              className={isActive(item.id) ? "active" : ""}
              aria-current={isActive(item.id) ? "page" : undefined}
              onClick={() => void goTo(item.id)}
            >
              {item.icon}
              {item.id === "receipts" && taskBadge > 0 && (
                <span className="dot" aria-label={`${taskBadge} задач`}>
                  {taskBadge}
                </span>
              )}
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
          <button
            className={inSecondary ? "active" : ""}
            aria-current={inSecondary ? "page" : undefined}
            aria-haspopup="dialog"
            onClick={async () => {
              if (!(await confirmLeave())) return;
              setMoreOpen(true);
            }}
          >
            {Icons.settings}
            <span className="nav-label">Ещё</span>
          </button>
        </nav>

        <Sheet open={moreOpen} label="Ещё разделы" onClose={closeMore}>
          {SECONDARY.map((item) => (
            <button
              key={item.id}
              className={`sheet-item ${tab === item.id ? "active" : ""}`}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => void goTo(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </Sheet>

        <CommandPalette onSelect={onSearchPick} />
        <ToastHost />
        <ConfirmHost />
        <ChoiceHost />
      </div>
    </div>
  );
}

function Login(props: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { token } = await api<{ token: string }>("/admin/login", { method: "POST", body: { password } });
      setToken(token);
      props.onDone();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Ошибка входа");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card">
        <div className="login-art"><BakeryHero /></div>
        <Logo />
        {err && <div className="msg err">{err}</div>}
        <form onSubmit={submit}>
          <label className="field">
            <span>Пароль панели</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          <button className="btn wide" disabled={busy || !password} type="submit">
            {busy ? "Вхожу…" : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
