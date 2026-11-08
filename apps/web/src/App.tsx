import { Suspense, useCallback, useEffect, useState } from "react";
import { api, setToken, hasToken, checkAdminSession, signOut } from "./api";
import { isInsideTelegram, loginViaTelegram, applyTelegramChrome } from "./telegram";
import { Logo, Icons } from "./components/Brand";
import { BakeryHero } from "./components/Illustrations";
import { ToastHost } from "./components/Toast";
import { ConfirmHost } from "./components/ConfirmDialog";
import { ChoiceHost } from "./components/ChoiceSheet";
import { SkeletonList } from "./components/Skeleton";
import { CommandPalette, SearchButton, type SearchHit } from "./components/CommandPalette";
import { confirmLeave } from "./components/UnsavedGuard";
import { TodayPage } from "./pages/TodayPage";
import type { CatalogView } from "./pages/CatalogPage";
import type { TasksView } from "./pages/TasksPage";
import { BOTTOM_NAV, MORE_SECTIONS, bottomNavFor, isAllowed, navOwner, type Tab } from "./panel/nav";
import { useShowEscalations, useSimpleMode } from "./panel/prefs";
import { useAttention } from "./panel/useAttention";
import { lazyPage } from "./panel/lazy";

/**
 * ЛЕНИВАЯ ЗАГРУЗКА: на первом экране нужен только «Сегодня»; остальные
 * разделы (а это тяжёлые CoursesPage, ImportPage, FunnelsPage…) подгружаются
 * при первом открытии и в простое после входа — тап по нижней кнопке тогда
 * мгновенный.
 */
const pages = {
  tasks: () => import("./pages/TasksPage"),
  clients: () => import("./pages/ClientsPage"),
  catalog: () => import("./pages/CatalogPage"),
  more: () => import("./pages/MorePage"),
};
const TasksPage = lazyPage(pages.tasks, "TasksPage");
const ClientsPage = lazyPage(pages.clients, "ClientsPage");
const CatalogPage = lazyPage(pages.catalog, "CatalogPage");
const MorePage = lazyPage(pages.more, "MorePage");
const StudentPage = lazyPage(() => import("./pages/StudentPage"), "StudentPage");
const DashboardPage = lazyPage(() => import("./pages/DashboardPage"), "DashboardPage");
const SettingsPage = lazyPage(() => import("./pages/SettingsPage"), "SettingsPage");
const FunnelsPage = lazyPage(() => import("./pages/FunnelsPage"), "FunnelsPage");
const JournalPage = lazyPage(() => import("./pages/JournalPage"), "JournalPage");
const MoneyPage = lazyPage(() => import("./pages/MoneyPage"), "MoneyPage");
const StylePage = lazyPage(() => import("./pages/StylePage"), "StylePage");
const QualityPage = lazyPage(() => import("./pages/QualityPage"), "QualityPage");
const TestimonialsPage = lazyPage(() => import("./pages/TestimonialsPage"), "TestimonialsPage");
const MediaExamplesPage = lazyPage(() => import("./pages/MediaExamplesPage"), "MediaExamplesPage");
const ImportPage = lazyPage(() => import("./pages/ImportPage"), "ImportPage");
const RecipeReviewPage = lazyPage(() => import("./pages/RecipeReviewPage"), "RecipeReviewPage");
const LinksPage = lazyPage(() => import("./pages/LinksPage"), "LinksPage");

/** Иконка каждого раздела — для сайдбара на ПК и нижней панели. */
const TAB_ICON: Partial<Record<Tab, JSX.Element>> = {
  home: Icons.home,
  receipts: Icons.receipts,
  clients: Icons.clients,
  courses: Icons.media,
  more: Icons.more,
  money: Icons.money,
  summary: Icons.pulse,
  testimonials: Icons.testimonials,
  links: Icons.attach,
  settings: Icons.settings,
};

const TASK_TABS: Tab[] = ["receipts", "questions", "attention"];
const CATALOG_TABS: Tab[] = ["courses", "offer", "texts"];

/** Разделы, которые умеет открывать ⌘K (apps/api/src/search.ts → SECTIONS). */
const ALL_TABS = new Set<Tab>([
  ...BOTTOM_NAV.map((p) => p.id),
  ...MORE_SECTIONS.map((s) => s.id),
  "questions",
  "recipes",
  "texts",
  "offer",
]);
function isTab(id: string): id is Tab {
  return ALL_TABS.has(id as Tab);
}

function PageFallback() {
  return (
    <div className="card" data-testid="page-fallback">
      <SkeletonList rows={3} height={96} />
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const simple = useSimpleMode();
  const showEscalations = useShowEscalations();
  /** Проверка OCR-рецептов (§13): null — список уроков на проверку, id — карточка. */
  const [reviewLessonId, setReviewLessonId] = useState<string | null>(null);
  /** Открытая карточка ученицы — поверх вкладки «Клиенты» (StudentPage). */
  const [studentId, setStudentId] = useState<string | null>(null);
  // Check the server auth mode before trusting any previously stored session.
  const [checkingSession, setCheckingSession] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  // Что требует внимания (чеки, вопросы, ждущие клиенты) — один источник для
  // экрана «Сегодня» и красных цифр на кнопках. Обновляется при смене раздела.
  const attention = useAttention(authed, tab);
  // Чаты WhatsApp, где бот не смог ответить («Нужен ответ» в «Задачах»).
  const [waAttention, setWaAttention] = useState(0);
  useEffect(() => {
    if (!authed) return;
    api<{ chats: unknown[] }>("/admin/v1/conversations/attention")
      .then((a) => setWaAttention(a.chats.length))
      .catch(() => undefined); // сбой не должен гасить остальные цифры
  }, [authed, tab]);

  useEffect(() => {
    applyTelegramChrome();
  }, []);

  useEffect(() => {
    let active = true;
    checkAdminSession()
      .then(async (mode) => {
        const ok = mode === "access" || hasToken() || (isInsideTelegram() && (await loginViaTelegram()));
        if (active) setAuthed(ok);
      })
      .catch((error) => {
        if (active) setAccessError(error instanceof Error ? error.message : "Ошибка входа");
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // После входа тихо подгружаем частые разделы, пока человек читает «Сегодня».
  useEffect(() => {
    if (!authed) return;
    const warm = () =>
      void Promise.all([pages.tasks(), pages.clients(), pages.catalog(), pages.more()]).catch(() => undefined);
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (ric) ric(warm);
    else setTimeout(warm, 1500);
  }, [authed]);

  // Включили режим сестры, стоя в закрытом для неё разделе, — на «Сегодня».
  useEffect(() => {
    if (!isAllowed(tab, simple)) setTab("home");
  }, [tab, simple]);

  async function leavePanel() {
    try {
      await signOut();
      setAuthed(false);
    } catch {
      window.alert("Не удалось завершить сессию на сервере. Проверьте соединение и повторите выход.");
    }
  }

  const goTo = useCallback(async (id: Tab) => {
    // Промт на 10к символов или редактор воронки посреди правки — раньше один
    // тап по нижней навигации стирал всё без вопросов.
    if (!(await confirmLeave())) return;
    setTab(id);
    setStudentId(null);
    // Возврат наверх: иначе новый раздел открывается прокрученным на ту же
    // высоту, что и предыдущий, и выглядит пустым.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openReview = useCallback(
    (lessonId: string | null) => {
      setReviewLessonId(lessonId);
      void goTo("recipes");
    },
    [goTo],
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
    [goTo, openStudent],
  );

  if (checkingSession) {
    return (
      <div className="login">
        <div className="card">
          <Logo />
          <p className="hint" style={{ margin: 0 }}>
            Проверяю защищённый вход…
          </p>
        </div>
      </div>
    );
  }
  if (accessError)
    return (
      <div className="login">
        <div className="card">
          <Logo />
          <p role="alert">{accessError}</p>
          <a className="btn wide" href="/panel">
            Открыть защищённый вход
          </a>
        </div>
      </div>
    );
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const data = attention.data;
  const taskBadge = (data ? data.receipts + data.questions : 0) + waAttention;
  const clientBadge = data && showEscalations ? data.waiting.length : 0;
  const badgeOf = (id: Tab) => (id === "receipts" ? taskBadge : id === "clients" ? clientBadge : 0);
  const badgeLabel = (id: Tab, n: number) => (id === "receipts" ? `${n} дел ждут` : `${n} ждут ответа`);
  const owner = navOwner(tab);
  const items = bottomNavFor(simple);
  const sideSections = simple ? [] : MORE_SECTIONS.filter((s) => s.group === "main");
  const openFromToday = (t: Tab) => (t === "recipes" ? openReview(null) : void goTo(t));

  return (
    <div className="app-shell">
      {/* Сайдбар для ПК (≥900px): основное и частые разделы сразу. */}
      <aside className="sidebar">
        <Logo />
        <SearchButton variant="bar" />
        <nav className="sidebar-nav" aria-label="Разделы">
          {items
            .filter((i) => i.id !== "more")
            .map((item) => (
              <button
                key={item.id}
                className={owner === item.id ? "active" : ""}
                aria-current={owner === item.id ? "page" : undefined}
                onClick={() => void goTo(item.id)}
              >
                {TAB_ICON[item.id]}
                <span>{item.label}</span>
                {badgeOf(item.id) > 0 && (
                  <span className="dot" aria-label={badgeLabel(item.id, badgeOf(item.id))}>
                    {badgeOf(item.id)}
                  </span>
                )}
              </button>
            ))}
          {sideSections.length > 0 && <div className="sidebar-divider" />}
          {sideSections.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => void goTo(item.id)}
            >
              {TAB_ICON[item.id] ?? Icons.journal}
              <span>{item.label}</span>
            </button>
          ))}
          <div className="sidebar-divider" />
          <button
            className={owner === "more" ? "active" : ""}
            aria-current={owner === "more" ? "page" : undefined}
            onClick={() => void goTo("more")}
          >
            {Icons.more}
            <span>Ещё</span>
          </button>
        </nav>
        <button className="sidebar-logout" onClick={() => void leavePanel()}>
          Выйти
        </button>
      </aside>

      <div className="shell">
        <div className="topbar">
          <Logo />
          <div className="topbar-actions">
            <SearchButton />
          </div>
        </div>

        <Suspense fallback={<PageFallback />}>
          {tab === "home" && (
            <TodayPage
              data={attention.data}
              error={attention.error}
              simple={simple}
              onRetry={attention.reload}
              onGo={openFromToday}
              onOpenStudent={openStudent}
            />
          )}
          {tab === "summary" && <DashboardPage onGo={openFromToday} onOpenStudent={openStudent} />}
          {TASK_TABS.includes(tab) && (
            <TasksPage
              view={tab as TasksView}
              counts={{ receipts: data?.receipts ?? 0, questions: data?.questions ?? 0, attention: waAttention }}
              onView={(v) => void goTo(v)}
              onChange={() => setWaAttention((n) => Math.max(0, n - 1))}
            />
          )}
          {tab === "clients" && studentId && <StudentPage contactId={studentId} onBack={() => setStudentId(null)} />}
          {tab === "clients" && !studentId && <ClientsPage onOpenStudent={openStudent} />}
          {CATALOG_TABS.includes(tab) && (
            <CatalogPage view={tab as CatalogView} onView={(v) => void goTo(v)} onReview={openReview} />
          )}
          {tab === "more" && <MorePage onGo={(t) => void goTo(t)} onLogout={() => void leavePanel()} />}
          {tab === "money" && <MoneyPage />}
          {tab === "recipes" && (
            <RecipeReviewPage lessonId={reviewLessonId} onOpen={openReview} onBack={() => void goTo("courses")} />
          )}
          {tab === "funnels" && <FunnelsPage />}
          {tab === "journal" && <JournalPage />}
          {tab === "style" && <StylePage />}
          {tab === "media" && <MediaExamplesPage />}
          {tab === "import" && <ImportPage onGo={(t) => (t === "recipes" ? openReview(null) : void goTo(t))} />}
          {tab === "quality" && <QualityPage />}
          {tab === "testimonials" && <TestimonialsPage />}
          {tab === "links" && <LinksPage />}
          {tab === "settings" && <SettingsPage />}
        </Suspense>

        <nav className="nav" aria-label="Разделы">
          {items.map((item) => {
            const n = badgeOf(item.id);
            return (
              <button
                key={item.id}
                className={owner === item.id ? "active" : ""}
                aria-current={owner === item.id ? "page" : undefined}
                onClick={() => void goTo(item.id)}
              >
                {TAB_ICON[item.id]}
                {n > 0 && (
                  <span className="dot" aria-label={badgeLabel(item.id, n)}>
                    {n}
                  </span>
                )}
                <span className="nav-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

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
        <div className="login-art">
          <BakeryHero />
        </div>
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
