import { useCallback, useEffect, useRef, useState } from "react";
import { useUnsavedGuard } from "../components/UnsavedGuard";
import { api, type DeleteLessonResponse, type TrashedLesson, type TrashResponse } from "../api";
import { Icons } from "../components/Brand";
import { confirmDialog, promptDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/Illustrations";
import { Sheet } from "../components/Sheet";
import { toast } from "../components/Toast";
import { haptic, useTelegramClosingGuard } from "../telegram";

/**
 * КУРСЫ — наполнение собственной платформы: разделы, уроки, видео и рецепты.
 *
 * Главное здесь — статус урока. Видео перекодируется минутами, и без честного
 * статуса владелец не понимает, сломалось у него что-то или просто идёт работа.
 * Поэтому строка урока всегда говорит, что с ним прямо сейчас — человеческим
 * языком («видео готовится, ~10 мин»), с обложкой 16:9, как у ученицы, и
 * названием, которое правится на месте (§8 «Утра Ширин»). Рецепт с карточки,
 * который ещё никто не сверял, помечен бейджем — тап ведёт на проверку (§13).
 */

type Lesson = {
  id: string;
  title: string;
  order: number;
  status: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
  durationSec: number | null;
  hasVideo: boolean;
  recipeText: string | null;
  recipePhotos: string[];
  recipeSource: string | null;
  recipeReviewedAt: string | null;
  needsRecipeReview: boolean;
  coverUrl: string | null;
  isPreview: boolean;
  transcript: string | null;
  transcriptStatus: string | null;
  audioUrl: string | null;
};

type Module = { id: string; title: string; order: number; lessons: Lesson[] };

/** Инструмент курса (Course.toolsData, визуальная система 04.09.2026, §5):
 *  насадка, форма и т.п. — экран «Набор инструментов» в приложении ученицы. */
type CourseTool = { name: string; photoUrl: string | null; toolNumber: string | null; buyLink: string | null };

type Course = {
  id: string;
  code: string;
  title: string;
  price: number;
  active: boolean;
  students: number;
  modules: Module[];
  toolsData: CourseTool[];
};

/** Статус по-человечески: без «транскодинга» и кодов. */
const STATUS_LABEL: Record<Lesson["status"], string> = {
  UPLOADED: "видео принято, ждёт очереди",
  PROCESSING: "видео готовится, ~10 мин",
  READY: "готов",
  FAILED: "ошибка",
};

export function CoursesPage({ onReview }: { onReview?: (lessonId: string | null) => void } = {}) {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [storageReady, setStorageReady] = useState(true);
  const [reviewCount, setReviewCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Lesson | null>(null);
  const [editingTools, setEditingTools] = useState<Course | null>(null);
  const [trash, setTrash] = useState<TrashedLesson[]>([]);

  const loadTrash = useCallback(() => {
    api<TrashResponse>("/admin/lessons/trash")
      .then((r) => setTrash(r.rows))
      .catch(() => setTrash([]));
  }, []);

  function load() {
    api<{ courses: Course[]; storageReady: boolean }>("/admin/courses")
      .then((r) => {
        setCourses(r.courses);
        setStorageReady(r.storageReady);
      })
      .catch((e) => setErr(e.message));
    loadTrash();
    api<{ count: number }>("/admin/recipes/review-count")
      .then((r) => setReviewCount(r.count))
      .catch(() => undefined);
  }
  useEffect(load, []);

  async function rename(lesson: Lesson, title: string) {
    const next = title.trim();
    if (!next || next === lesson.title) return;
    try {
      await api(`/admin/lessons/${lesson.id}`, { method: "PUT", body: { title: next } });
      setCourses((cs) =>
        cs
          ? cs.map((c) => ({
              ...c,
              modules: c.modules.map((m) => ({ ...m, lessons: m.lessons.map((l) => (l.id === lesson.id ? { ...l, title: next } : l)) })),
            }))
          : cs
      );
      toast("Название сохранено");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось переименовать", "error");
    }
  }

  // Пока хоть один урок перекодируется, обновляем список: иначе владелец сидит
  // перед статусом «перекодируется» и не знает, закончилось ли.
  useEffect(() => {
    const working = courses?.some((c) =>
      c.modules.some((m) => m.lessons.some((l) => l.status === "PROCESSING" || l.status === "UPLOADED"))
    );
    if (!working) return;
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [courses]);

  async function fillCatalog() {
    setBusy("backfill");
    try {
      const r = await api<{ coursesCreated: number; purchasesLinked: number }>("/admin/courses/backfill", {
        method: "POST",
      });
      toast(`Каталог заполнен: курсов ${r.coursesCreated}, покупок связано ${r.purchasesLinked}`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось", "error");
    } finally {
      setBusy(null);
    }
  }

  async function addModule(course: Course) {
    // Не window.prompt: внутри Telegram его подавляют, и кнопка молча не
    // делала ничего — завести курс владелица физически не могла.
    const title = await promptDialog({
      title: "Название раздела",
      initial: `Раздел ${course.modules.length + 1}`,
      confirmLabel: "Создать",
    });
    if (!title) return;
    setBusy(course.id);
    try {
      await api(`/admin/courses/${course.id}/modules`, {
        method: "POST",
        body: { title: title.trim(), order: course.modules.length + 1 },
      });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось", "error");
    } finally {
      setBusy(null);
    }
  }

  async function addLesson(module: Module) {
    const title = await promptDialog({
      title: "Название урока",
      initial: `Урок ${module.lessons.length + 1}`,
      confirmLabel: "Создать",
    });
    if (!title) return;
    setBusy(module.id);
    try {
      await api(`/admin/modules/${module.id}/lessons`, {
        method: "POST",
        body: { title: title.trim(), order: module.lessons.length + 1 },
      });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось", "error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * КОРЗИНА («Утро Ширин» §19): без окна «Точно?». Урок уходит в корзину
   * сразу (сервер ставит deletedAt, ученицы его уже не видят), а тост даёт
   * «Отменить» — это настоящий возврат (POST restore), и он же доступен из
   * раздела «Корзина» внизу ещё 24 часа.
   */
  async function removeLesson(lesson: Lesson) {
    setBusy(lesson.id);
    try {
      await api<DeleteLessonResponse>(`/admin/lessons/${lesson.id}`, { method: "DELETE" });
      haptic("warning");
      load();
      toast(`«${lesson.title}» в корзине`, {
        duration: 6000,
        action: { label: "Отменить", onClick: () => void restoreLesson(lesson.id, lesson.title) },
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось", "error");
    } finally {
      setBusy(null);
    }
  }

  async function restoreLesson(id: string, title: string) {
    setBusy(id);
    try {
      await api(`/admin/lessons/${id}/restore`, { method: "POST" });
      haptic("success");
      toast(`«${title}» возвращён`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось вернуть", "error");
    } finally {
      setBusy(null);
    }
  }

  async function retranscode(lesson: Lesson) {
    setBusy(lesson.id);
    try {
      const r = await api<{ note: string }>(`/admin/lessons/${lesson.id}/retranscode`, { method: "POST" });
      toast(r.note);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>{Icons.media} Курсы</h2>
      <p className="hint">
        Уроки собственной платформы: ученица открывает их по ссылке из переписки, без Telegram, и они сохраняются
        у неё в телефоне.
      </p>

      {!storageReady && (
        <div className="msg err">
          Хранилище видео не настроено. Заполните ключи R2 в «Настройках» — без них видео некуда положить.
        </div>
      )}
      {err && <div className="msg err">{err}</div>}
      {!courses && <div className="skeleton" style={{ height: 160 }} />}

      {reviewCount > 0 && onReview && (
        <button type="button" className="btn ghost wide" style={{ marginBottom: 14 }} onClick={() => onReview(null)}>
          Проверить рецепты ({reviewCount})
        </button>
      )}

      {courses?.length === 0 && (
        <>
          <EmptyState text="Каталог пуст" />
          <button className="btn wide" disabled={busy === "backfill"} onClick={fillCatalog}>
            {busy === "backfill" ? "Заполняю…" : "Создать курсы из текущих цен"}
          </button>
        </>
      )}

      {courses?.map((course) => (
        <section key={course.id} style={{ marginBottom: 26 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h3 style={{ margin: 0 }}>{course.title}</h3>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn quiet small" onClick={() => setEditingTools(course)}>
                Инструменты{course.toolsData.length > 0 ? ` (${course.toolsData.length})` : ""}
              </button>
              <span className="chip">{course.students} купили</span>
            </div>
          </div>

          {course.modules.length === 0 && <p className="hint">Разделов пока нет.</p>}

          {course.modules.map((module) => (
            <div key={module.id} style={{ marginTop: 12 }}>
              <div className="list-sub" style={{ fontWeight: 600 }}>{module.title}</div>
              <div className="list">
                {module.lessons.map((lesson) => (
                  <LessonRow
                    key={lesson.id}
                    lesson={lesson}
                    busy={busy === lesson.id}
                    onRename={(title) => void rename(lesson, title)}
                    onEdit={() => setEditing(lesson)}
                    onRetry={() => void retranscode(lesson)}
                    onRemove={() => void removeLesson(lesson)}
                    onReview={onReview ? () => onReview(lesson.id) : undefined}
                  />
                ))}
              </div>
              <button className="btn ghost small" disabled={busy === module.id} onClick={() => addLesson(module)}>
                + Урок
              </button>
            </div>
          ))}

          <button
            className="btn ghost small"
            style={{ marginTop: 12 }}
            disabled={busy === course.id}
            onClick={() => addModule(course)}
          >
            + Раздел
          </button>
        </section>
      ))}

      {trash.length > 0 && (
        <details className="trash">
          <summary>Корзина ({trash.length})</summary>
          <p className="hint" style={{ marginTop: 6 }}>
            Удалённые уроки хранятся сутки — ученицы их уже не видят, но вернуть можно одной кнопкой.
          </p>
          {trash.map((row) => (
            <div key={row.id} className="trash-row">
              <div className="trash-title">
                {row.title}
                <span className="trash-sub">
                  {row.course} · {row.module}
                </span>
              </div>
              <span className="trash-left">{timeLeft(row.purgeAt)}</span>
              <button
                type="button"
                className="btn quiet small"
                disabled={busy === row.id}
                onClick={() => void restoreLesson(row.id, row.title)}
              >
                Вернуть
              </button>
            </div>
          ))}
        </details>
      )}

      {editing && (
        <LessonEditor
          lesson={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {editingTools && (
        <ToolsEditor
          course={editingTools}
          onClose={() => setEditingTools(null)}
          onSaved={() => {
            setEditingTools(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** «ещё 23 ч» / «ещё 40 мин» — сколько осталось до чистки корзины. */
export function timeLeft(purgeAt: string, now = Date.now()): string {
  const ms = new Date(purgeAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "вот-вот исчезнет";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `ещё ${min} мин`;
  return `ещё ${Math.floor(min / 60)} ч`;
}

/**
 * Строка урока: обложка 16:9 с номером, название (тап — правка на месте,
 * Enter сохраняет, Escape отменяет), статус человеческим языком, действия.
 */
function LessonRow(props: {
  lesson: Lesson;
  busy: boolean;
  onRename: (title: string) => void;
  onEdit: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onReview?: () => void;
}) {
  const { lesson, busy, onRename, onEdit, onRetry, onRemove, onReview } = props;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(lesson.title);
  // Enter и уход фокуса оба закрывают поле; после Enter поле пропадает из
  // DOM, и браузер шлёт blur ещё раз — второй раз сохранять не надо.
  const done = useRef(false);

  const startRename = () => {
    setDraft(lesson.title);
    done.current = false;
    setRenaming(true);
  };
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setRenaming(false);
    onRename(draft);
  };
  const cancel = () => {
    done.current = true;
    setDraft(lesson.title);
    setRenaming(false);
  };

  return (
    <div className="lesson-row">
      <div className="lesson-cover-thumb" aria-hidden>
        {lesson.coverUrl && <img src={lesson.coverUrl} alt="" loading="lazy" />}
        <span className="lesson-num">{lesson.order}</span>
      </div>
      <div className="lesson-main">
        {renaming ? (
          <input
            className="lesson-rename"
            value={draft}
            autoFocus
            aria-label="Название урока"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          />
        ) : (
          <button type="button" className="lesson-title-btn" title="Нажмите, чтобы переименовать" onClick={startRename}>
            {lesson.title}
          </button>
        )}
        <div className="lesson-status">
          <span className={lesson.status === "FAILED" ? "chip chip-err" : lesson.status === "READY" ? "chip chip-ok" : "chip"}>
            {STATUS_LABEL[lesson.status]}
          </span>
          {lesson.status === "FAILED" && lesson.hasVideo && (
            <button type="button" className="btn quiet small" disabled={busy} onClick={onRetry}>
              Ещё раз
            </button>
          )}
          {lesson.durationSec ? <span>{Math.round(lesson.durationSec / 60)} мин</span> : null}
          <span>{lesson.recipeText ? "рецепт есть" : "рецепта нет"}</span>
          {lesson.recipePhotos.length > 0 && <span>фото: {lesson.recipePhotos.length}</span>}
          {lesson.needsRecipeReview &&
            (onReview ? (
              <button type="button" className="chip chip-warn" onClick={onReview}>
                с карточки, не проверено
              </button>
            ) : (
              <span className="chip chip-warn">с карточки, не проверено</span>
            ))}
        </div>
      </div>
      <div className="lesson-actions">
        <button type="button" className="btn quiet small" onClick={onEdit}>
          Рецепт и видео
        </button>
        <button type="button" className="btn danger small" disabled={busy} onClick={onRemove}>
          Удалить
        </button>
      </div>
    </div>
  );
}

/** Редактор одного урока: видео, текст рецепта и фото к нему. Открывается
 *  листом сбоку/снизу (Sheet), а не окном поверх списка. */
function LessonEditor(props: { lesson: Lesson; onClose: () => void; onSaved: () => void }) {
  const { lesson, onClose, onSaved } = props;
  const [recipe, setRecipe] = useState(lesson.recipeText ?? "");
  const [transcript, setTranscript] = useState(lesson.transcript ?? "");
  const [photos, setPhotos] = useState(lesson.recipePhotos);
  const [uploading, setUploading] = useState<null | { what: "video" | "photo"; percent: number }>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  async function saveRecipe() {
    try {
      await api(`/admin/lessons/${lesson.id}`, { method: "PUT", body: { recipeText: recipe, transcript } });
      toast("Сохранено");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не получилось сохранить");
    }
  }

  /**
   * Видео заливается XHR, а не fetch: только он показывает ход отправки, а
   * ролик на сотни мегабайт по мобильному интернету идёт минутами — без
   * полоски владелец решит, что всё зависло, и закроет вкладку.
   */
  function uploadVideo(file: File) {
    setErr(null);
    setUploading({ what: "video", percent: 0 });
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/admin/lessons/${lesson.id}/video`);
    const token = localStorage.getItem("ssb_token");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploading({ what: "video", percent: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      setUploading(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        toast("Видео принято, идёт перекодировка");
        onSaved();
      } else {
        try {
          setErr((JSON.parse(xhr.responseText) as { error?: string }).error ?? "Не получилось загрузить");
        } catch {
          setErr("Не получилось загрузить видео");
        }
      }
    };
    xhr.onerror = () => {
      setUploading(null);
      setErr("Связь оборвалась во время загрузки");
    };
    xhr.send(form);
  }

  async function addPhoto(file: File) {
    setUploading({ what: "photo", percent: 0 });
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/admin/lessons/${lesson.id}/photos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("ssb_token") ?? ""}` },
        body: form,
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Не получилось");
      setPhotos((p) => [...p, data.url!]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не получилось добавить фото");
    } finally {
      setUploading(null);
    }
  }

  // ЗАКРЫТИЕ БЕЗ ПОТЕРЬ. Раньше касание мимо карточки закрывало лист и стирало
  // рецепт, который набирали с телефона десять минут; а во время заливки
  // видео закрытие уносило прогресс-бар, хотя загрузка продолжалась вслепую.
  const dirty = recipe !== (lesson.recipeText ?? "") || transcript !== (lesson.transcript ?? "");
  useUnsavedGuard(dirty || uploading !== null);
  useTelegramClosingGuard(dirty || uploading !== null);
  const tryClose = async () => {
    if (uploading !== null) {
      toast(uploading.what === "video" ? "Дождитесь, пока видео загрузится" : "Дождитесь загрузки фото", "error");
      return;
    }
    if (dirty) {
      const leave = await confirmDialog({
        title: "Закрыть без сохранения?",
        message: "Рецепт изменён, но не сохранён. Изменения пропадут.",
        confirmLabel: "Закрыть",
        cancelLabel: "Остаться",
        danger: true,
      });
      if (!leave) return;
    }
    onClose();
  };

  return (
    <Sheet open label={`Рецепт и видео — ${lesson.title}`} onClose={() => void tryClose()}>
      <div className="lesson-editor">
        <h3>{lesson.title}</h3>
        {err && <div className="msg err">{err}</div>}

        <label className="field">
          <span>Видео урока — MP4, MOV, MKV или WebM</span>
          <input
            ref={videoRef}
            type="file"
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) uploadVideo(file);
            }}
          />
        </label>
        {uploading?.what === "video" && (
          <div className="hint">Отправляю видео… {uploading.percent}%. Не закрывайте вкладку.</div>
        )}

        <label className="field">
          <span>Рецепт — текст как есть, переносы строк сохранятся</span>
          <textarea rows={10} value={recipe} onChange={(e) => setRecipe(e.target.value)} />
        </label>

        <label className="field">
          <span>
            Расшифровка урока — текст того, что говорит преподаватель. По ней помощник в чате отвечает на вопросы
            учениц.
            {lesson.audioUrl && (
              <>
                {" "}
                <a href={lesson.audioUrl} target="_blank" rel="noreferrer noopener">
                  Скачать аудио урока
                </a>{" "}
                → загрузить в Google AI Studio → вставить текст сюда.
              </>
            )}
          </span>
          <textarea rows={8} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
        </label>

        <label className="field">
          <span>Фото к рецепту</span>
          <input
            ref={photoRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void addPhoto(file);
            }}
          />
        </label>
        {photos.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {photos.map((url) => (
              <img key={url} src={url} alt="" className="thumb" />
            ))}
          </div>
        )}

        <div className="dialog-actions">
          <button className="btn quiet" onClick={() => void tryClose()}>
            Закрыть
          </button>
          <button className="btn" onClick={saveRecipe} disabled={uploading !== null}>
            Сохранить
          </button>
        </div>
      </div>
    </Sheet>
  );
}

const EMPTY_TOOL: CourseTool = { name: "", photoUrl: null, toolNumber: null, buyLink: null };

/**
 * НАБОР ИНСТРУМЕНТОВ (визуальная система 04.09.2026, §5) — насадки, формы и
 * т.п., общие для всего курса (не для одного урока, поэтому редактируется
 * здесь, а не в LessonEditor). Фото — тем же общим /admin/upload, что у
 * отзывов (см. admin.ts): своей ручки под инструменты заводить незачем.
 */
function ToolsEditor(props: { course: Course; onClose: () => void; onSaved: () => void }) {
  const { course, onClose, onSaved } = props;
  const [tools, setTools] = useState<CourseTool[]>(course.toolsData);
  const [uploading, setUploading] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function patchTool(i: number, changes: Partial<CourseTool>) {
    const next = tools.slice();
    next[i] = { ...next[i], ...changes };
    setTools(next);
  }

  async function uploadPhoto(i: number, file: File) {
    setUploading(i);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/admin/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("ssb_token") ?? ""}` },
        body: form,
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Не получилось");
      patchTool(i, { photoUrl: data.url });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не получилось загрузить фото");
    } finally {
      setUploading(null);
    }
  }

  const dirty = JSON.stringify(tools) !== JSON.stringify(course.toolsData);
  useUnsavedGuard(dirty || uploading !== null);
  useTelegramClosingGuard(dirty || uploading !== null);
  const tryClose = async () => {
    if (uploading !== null) {
      toast("Дождитесь загрузки фото", "error");
      return;
    }
    if (dirty) {
      const leave = await confirmDialog({
        title: "Закрыть без сохранения?",
        message: "Список инструментов изменён, но не сохранён. Изменения пропадут.",
        confirmLabel: "Закрыть",
        cancelLabel: "Остаться",
        danger: true,
      });
      if (!leave) return;
    }
    onClose();
  };

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const cleaned = tools
        .map((t) => ({ ...t, name: t.name.trim() }))
        .filter((t) => t.name.length > 0);
      await api(`/admin/courses/${course.id}`, { method: "PUT", body: { toolsData: cleaned } });
      toast("Сохранено");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не получилось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={() => void tryClose()}>
      <div className="dialog" style={{ maxWidth: 560 }} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">Набор инструментов — {course.title}</h3>
        <p className="hint">
          Показывается ученице отдельным экраном: название, номер (например, насадки) и ссылка «где купить».
        </p>
        {err && <div className="msg err">{err}</div>}

        {tools.map((tool, i) => (
          <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: "flex-start" }} key={i}>
            {tool.photoUrl && <img src={tool.photoUrl} alt="" className="thumb" />}
            <div style={{ flex: 1 }}>
              <label className="field">
                <span>Название</span>
                <input value={tool.name} onChange={(e) => patchTool(i, { name: e.target.value })} />
              </label>
              <label className="field">
                <span>Фото</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploading === i}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void uploadPhoto(i, file);
                  }}
                />
              </label>
              <div className="row" style={{ gap: 8 }}>
                <label className="field" style={{ maxWidth: 140 }}>
                  <span>Номер (насадки и т.п.)</span>
                  <input
                    value={tool.toolNumber ?? ""}
                    onChange={(e) => patchTool(i, { toolNumber: e.target.value || null })}
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span>Ссылка «где купить в Душанбе»</span>
                  <input value={tool.buyLink ?? ""} onChange={(e) => patchTool(i, { buyLink: e.target.value || null })} />
                </label>
              </div>
            </div>
            <button className="btn danger small" onClick={() => setTools(tools.filter((_, idx) => idx !== i))}>
              ×
            </button>
          </div>
        ))}

        <button className="btn ghost small" onClick={() => setTools([...tools, { ...EMPTY_TOOL }])}>
          + Инструмент
        </button>

        <div className="dialog-actions">
          <button className="btn quiet" onClick={() => void tryClose()}>
            Закрыть
          </button>
          <button className="btn" onClick={() => void save()} disabled={saving || uploading !== null}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
