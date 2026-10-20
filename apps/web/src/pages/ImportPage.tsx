import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/ConfirmDialog";
import { Icons } from "../components/Brand";
import { EmptyState } from "../components/EmptyState";

/**
 * ИМПОРТ УРОКОВ ИЗ ЭКСПОРТА TELEGRAM DESKTOP — пять шагов, как в мастере.
 *
 * Владелец не технический: страница ведёт за руку. Папка → список уроков с
 * галочками и названиями, которые можно поправить → курс и раздел → запуск с
 * живым прогрессом → готово. Ничего не запускается, пока человек не увидел,
 * что именно будет создано: «Урок 7» с подписью «видео» иначе уехал бы в
 * приложение как есть.
 *
 * Экспорт КАНАЛА (04.09.2026): у урока есть карточка рецепта, тизер и полное
 * видео, а файлы больше лимита экспорта сервер подбирает по длительности —
 * когда подходит несколько, владелец выбирает сам прямо в строке урока.
 *
 * ЧЕК-ЛИСТ (волна 2, §14): шаг 0 «Что подготовить» с живым местом на диске,
 * а после READY — «Проверьте рецепты с карточек (N)» и «Удалить исходники
 * (X ГБ)», чтобы диск освобождался без Далера.
 */

type Folder = { name: string; sizeGb: number; videoCount: number; hasResult: boolean };
type Disk = { freeGb: number; freePct: number } | null;
type FileStatus = "exported" | "resolved" | "ambiguous" | "missing" | "broken";
type FileResolution = {
  file: string | null;
  status: FileStatus;
  candidates: string[];
  note: string | null;
  sizeBytes: number;
  durationSec: number | null;
};
type Candidate = {
  messageId: number;
  number: number | null;
  title: string;
  titleSource: "caption" | "header" | "filename" | "generated";
  recipeText: string;
  videoFile: string;
  durationSec: number | null;
  photoFiles: string[];
  cardPhotos: string[];
  teaserMessageId: number | null;
  teaserFile: string | null;
  teaserDurationSec: number | null;
  video: FileResolution;
  teaser: FileResolution | null;
  warnings: string[];
  fileExists: boolean;
  sizeMb: number;
  alreadyImported: boolean;
};
type IntroPost = { messageId: number; date: string; kind: "text" | "photo" | "video"; text: string; file: string | null };
type Preview = {
  chatId: string;
  chatName: string;
  mode: "caption" | "channel";
  lessons: Candidate[];
  intro: IntroPost[];
  skipped: { messageId: number; reason: string }[];
  warnings: string[];
  disk: Disk;
};
type Row = {
  messageId: number;
  title: string;
  recipeText: string;
  include: boolean;
  order: number;
  /** Файл, выбранный владельцем среди кандидатов (или подобранный сервером). */
  videoFile: string | null;
  teaserFile: string | null;
  src: Candidate;
  open: boolean;
};
type Status = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { done: number; total: number; current: string | null; errors: { item: string; error: string }[] } | null;
  lastResult: { created: number; skipped: number; errors: number; ocr?: number } | null;
  lastError: string | null;
};

const COURSES = [
  { code: "COURSE50", label: "Курс за 50 сомони — Арт-десерты" },
  { code: "COURSE70", label: "Курс за 70 сомони — 21 рецепт" },
] as const;

const TITLE_SOURCE: Record<Candidate["titleSource"], string> = {
  caption: "из подписи",
  header: "из заголовка",
  filename: "из имени файла",
  generated: "придумано — поправьте",
};

/** Меньше — импорт не запустится (MIN_FREE_GB на сервере — 2, но перекодировка
 *  тридцати уроков и временные файлы хотят запас): честная планка для чек-листа. */
const RECOMMENDED_FREE_GB = 6;

export function ImportPage({ onGo }: { onGo: (tab: "courses" | "recipes") => void }) {
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4 | 5>(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [disk, setDisk] = useState<Disk>(null);
  /** Процент свободного места из /health — тот же, что видит строка состояния на главной. */
  const [healthFreePct, setHealthFreePct] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [mode, setMode] = useState<Preview["mode"]>("channel");
  const [rows, setRows] = useState<Row[]>([]);
  const [intro, setIntro] = useState<IntroPost[]>([]);
  const [introOpen, setIntroOpen] = useState(false);
  const [skipped, setSkipped] = useState<Preview["skipped"]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [courseCode, setCourseCode] = useState<(typeof COURSES)[number]["code"]>("COURSE50");
  const [moduleTitle, setModuleTitle] = useState("Уроки");
  const [deleteSource, setDeleteSource] = useState(true);
  const [ocrCards, setOcrCards] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadFolders() {
    setErr(null);
    try {
      const data = await api<{ folders: Folder[]; disk: Disk; job: Status }>("/admin/imports/telegram");
      setFolders(data.folders);
      setDisk(data.disk);
      setStatus(data.job);
      // Импорт уже идёт (страницу перезагрузили) — сразу на прогресс.
      if (data.job.running) setStep(4);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не получилось прочитать папки");
    }
  }
  useEffect(() => {
    void loadFolders();
    // /health отвечает 503, когда что-то не так, но JSON с diskFreePct там всё равно есть.
    fetch("/health")
      .then((r) => r.json() as Promise<{ diskFreePct?: number | null }>)
      .then((h) => setHealthFreePct(typeof h.diskFreePct === "number" ? h.diskFreePct : null))
      .catch(() => setHealthFreePct(null));
  }, []);

  // Импорт закончился — считаем, сколько рецептов с карточек ждут проверки,
  // и обновляем размер папки: после заливки её можно удалить.
  useEffect(() => {
    if (step !== 5) return;
    api<{ count: number }>("/admin/recipes/review-count")
      .then((r) => setReviewCount(r.count))
      .catch(() => setReviewCount(null));
    void loadFolders();
  }, [step]);

  async function deleteSources() {
    if (!folder) return;
    const size = folders.find((f) => f.name === folder)?.sizeGb ?? 0;
    const ok = await confirmDialog({
      title: `Удалить папку «${folder}»?`,
      message: `Исходники (${size} ГБ) уже в хранилище. Папка с сервера удалится безвозвратно — повторить импорт из неё будет нельзя.`,
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await api<{ freedGb: number; disk: Disk }>(`/admin/imports/telegram/${encodeURIComponent(folder)}`, { method: "DELETE" });
      toast(`Папка удалена, освобождено ${r.freedGb} ГБ`);
      setDisk(r.disk);
      setFolders((fs) => fs.filter((f) => f.name !== folder));
      setFolder(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось удалить папку", "error");
    } finally {
      setDeleting(false);
    }
  }

  // Опрос прогресса раз в 3 секунды, пока идёт.
  useEffect(() => {
    if (step !== 4) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<Status>("/admin/imports/telegram/status");
        if (stop) return;
        setStatus(s);
        if (!s.running && (s.lastResult || s.lastError)) setStep(5);
      } catch {
        // сеть моргнула — следующий тик
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [step]);

  async function readFolder(name: string) {
    setBusy(true);
    setErr(null);
    try {
      const p = await api<Preview>(`/admin/imports/telegram/${encodeURIComponent(name)}`);
      setFolder(name);
      setMode(p.mode);
      setDisk(p.disk);
      setSkipped(p.skipped);
      setIntro(p.intro ?? []);
      setWarnings(p.warnings ?? []);
      setRows(
        p.lessons.map((c, i) => ({
          messageId: c.messageId,
          title: c.title,
          recipeText: c.recipeText,
          include: !c.alreadyImported && c.fileExists,
          order: c.number ?? i + 1,
          videoFile: c.video.file,
          teaserFile: c.teaser?.file ?? null,
          src: c,
          open: false,
        }))
      );
      setStep(2);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не получилось прочитать экспорт");
    } finally {
      setBusy(false);
    }
  }

  function patch(messageId: number, fn: (r: Row) => Row) {
    setRows((rs) => rs.map((r) => (r.messageId === messageId ? fn(r) : r)));
  }

  async function run() {
    if (!folder) return;
    const chosen = rows.filter((r) => r.include);
    const ok = await confirmDialog({
      title: `Импортировать ${chosen.length} ${plural(chosen.length, "урок", "урока", "уроков")}?`,
      message: `Курс: ${COURSES.find((c) => c.code === courseCode)?.label}. Раздел: «${moduleTitle}». Видео зальются в хранилище и встанут на перекодировку — это займёт часы, бот при этом работает как обычно.`,
      confirmLabel: "Запустить",
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/admin/imports/telegram/run", {
        method: "POST",
        body: {
          folder,
          mode,
          courseCode,
          moduleTitle,
          deleteSourceAfterUpload: deleteSource,
          ocrCards,
          lessons: rows.map((r) => ({
            messageId: r.messageId,
            title: r.title.trim() || r.src.title,
            recipeText: r.recipeText.trim() || null,
            include: r.include,
            order: r.order,
            videoFile: r.videoFile,
            teaserFile: r.teaserFile,
          })),
        },
      });
      setStep(4);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не получилось запустить");
      toast("Импорт не запустился", "error");
    } finally {
      setBusy(false);
    }
  }

  const chosenCount = rows.filter((r) => r.include).length;
  const cardsChosen = rows.filter((r) => r.include && r.src.cardPhotos.length > 0).length;

  return (
    <div className="card">
      <h2>{Icons.media} Импорт уроков из Telegram</h2>
      <p className="hint">
        Шаг {step + 1} из 6.{" "}
        {step === 0 && "Что подготовить, прежде чем начинать."}
        {step === 1 && "Выберите папку с экспортом — она должна лежать на сервере в /data/imports."}
        {step === 2 && "Проверьте названия и рецепты. Снимите галочку с того, что импортировать не надо."}
        {step === 3 && "Куда положить уроки."}
        {step === 4 && "Идёт заливка. Страницу можно закрыть — работа продолжится."}
        {step === 5 && "Готово. Перекодировка видео идёт в фоне — статус каждого урока виден в «Курсах»."}
      </p>
      {err && <div className="msg err">{err}</div>}

      {step === 0 && (
        <>
          <ul className="checklist">
            <li className="check-item">
              <span>
                <b>Экспорт из Telegram Desktop в JSON, с медиа</b>
                <small>Канал Ширин → «Экспорт истории чата» → формат JSON, галочки «Видео» и «Фото».</small>
              </span>
            </li>
            <li className="check-item">
              <span>
                <b>Лимит размера файла — максимум</b>
                <small>Иначе уроки длиннее лимита останутся заглушкой «File exceeds maximum size», и их придётся подбирать вручную.</small>
              </span>
            </li>
            <li className="check-item">
              <span>
                <b>Дождаться надписи «Экспорт завершён»</b>
                <small>Закрыть окно раньше — result.json оборвётся на полуслове, и часть уроков не найдётся.</small>
              </span>
            </li>
            <li className={`check-item ${disk ? (disk.freeGb >= RECOMMENDED_FREE_GB ? "ok" : "bad") : ""}`}>
              <span>
                <b>Свободно на сервере не меньше {RECOMMENDED_FREE_GB} ГБ</b>
                <small>
                  {disk
                    ? `Сейчас свободно ${disk.freeGb} ГБ (${healthFreePct ?? disk.freePct}%)${disk.freeGb < RECOMMENDED_FREE_GB ? " — мало, сначала освободите место или удалите старые папки импорта" : ""}`
                    : healthFreePct !== null
                      ? `Сейчас свободно ${healthFreePct}% диска`
                      : "Проверяю место на диске…"}
                </small>
              </span>
            </li>
            <li className="check-item">
              <span>
                <b>Папка скопирована на сервер в /data/imports</b>
                <small>Команду для копирования даст Далер; {folders.length > 0 ? `сейчас там ${folders.length} ${plural(folders.length, "папка", "папки", "папок")}.` : "пока папок нет."}</small>
              </span>
            </li>
          </ul>
          <button className="btn" onClick={() => setStep(1)}>
            К папкам →
          </button>
        </>
      )}

      {step === 1 && (
        <>
          {folders.length === 0 && (
            <div className="hint">
              Папок пока нет. Сделайте в Telegram Desktop «Экспорт истории чата» (JSON, с видео и фото) и скопируйте
              папку на сервер — команду для этого даст Далер.
            </div>
          )}
          {folders.map((f) => (
            <div key={f.name} className="row" style={{ alignItems: "center", gap: 12, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <strong>{f.name}</strong>
                <div className="hint" style={{ margin: 0 }}>
                  {f.videoCount} видео · {f.sizeGb} ГБ {f.hasResult ? "" : "· нет result.json"}
                </div>
              </div>
              <button className="btn" disabled={!f.hasResult || busy} onClick={() => void readFolder(f.name)}>
                {busy ? "Читаю…" : "Прочитать →"}
              </button>
            </div>
          ))}
          {disk && (
            <p className="hint">
              Свободно на диске: {disk.freeGb} ГБ ({disk.freePct}%). Для импорта нужно хотя бы 2 ГБ.
            </p>
          )}
          <button className="btn quiet" onClick={() => setStep(0)}>
            ← Что подготовить
          </button>
        </>
      )}

      {step === 2 && (
        <>
          {warnings.map((w, i) => (
            <div key={i} className="msg err">
              {w}
            </div>
          ))}
          <div className="hint">
            Найдено уроков: {rows.length}. Выбрано: {chosenCount}.{" "}
            {mode === "channel" ? "Режим: канал (карточка + тизер + урок)." : "Режим: группа (видео с подписью)."}{" "}
            {skipped.length > 0 && `Пропущено сообщений: ${skipped.length}.`}
          </div>
          {rows.map((r) => (
            <div
              key={r.messageId}
              className="card soft"
              style={{ marginBottom: 10, opacity: r.src.alreadyImported ? 0.55 : 1 }}
            >
              <div className="row" style={{ alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={r.include}
                  disabled={r.src.alreadyImported || !r.videoFile || r.src.video.status === "broken"}
                  onChange={(e) => patch(r.messageId, (x) => ({ ...x, include: e.target.checked }))}
                  aria-label={`Импортировать «${r.title}»`}
                />
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={r.order}
                  onChange={(e) => patch(r.messageId, (x) => ({ ...x, order: Number(e.target.value) || 1 }))}
                  style={{ width: 64 }}
                  aria-label="Порядковый номер"
                />
                <input
                  type="text"
                  value={r.title}
                  onChange={(e) => patch(r.messageId, (x) => ({ ...x, title: e.target.value }))}
                  style={{ flex: 1 }}
                  aria-label="Название урока"
                  title={`Название ${TITLE_SOURCE[r.src.titleSource]}`}
                />
              </div>
              <div className="row" style={{ gap: 14, flexWrap: "wrap", margin: "6px 0 0", fontSize: 13 }}>
                <Mark ok={r.src.cardPhotos.length > 0} label="карточка" detail={r.src.cardPhotos.length > 1 ? `×${r.src.cardPhotos.length}` : ""} />
                <Mark
                  ok={r.src.teaser ? r.src.teaser.status === "exported" || r.src.teaser.status === "resolved" : null}
                  label="тизер"
                  detail={r.src.teaser?.status === "broken" ? "повреждён" : r.src.teaser?.status === "ambiguous" ? "выберите" : ""}
                />
                <Mark
                  ok={r.src.video.status === "exported" || r.src.video.status === "resolved"}
                  label="видео"
                  detail={
                    r.src.video.status === "broken"
                      ? "повреждено"
                      : r.src.video.status === "ambiguous"
                        ? "выберите файл"
                        : r.src.video.status === "missing"
                          ? "нет файла"
                          : `${r.src.sizeMb} МБ`
                  }
                />
                <span className="hint" style={{ margin: 0 }}>
                  {formatDuration(r.src.durationSec)}
                  {r.src.titleSource === "filename" && r.videoFile && ` · ${basename(r.videoFile)}`}
                  {r.src.alreadyImported && " · уже загружен ✔"}
                </span>
              </div>
              {r.src.video.status === "ambiguous" && (
                <FilePicker
                  label="Файл урока"
                  value={r.videoFile}
                  candidates={r.src.video.candidates}
                  onChange={(file) =>
                    patch(r.messageId, (x) => ({
                      ...x,
                      videoFile: file,
                      include: x.include || (Boolean(file) && !x.src.alreadyImported),
                      // Название из выбранного файла, если своё не написали.
                      title: x.src.titleSource === "generated" && file ? titleFromFile(file) || x.title : x.title,
                    }))
                  }
                />
              )}
              {r.src.teaser?.status === "ambiguous" && (
                <FilePicker
                  label="Файл тизера"
                  value={r.teaserFile}
                  candidates={r.src.teaser.candidates}
                  onChange={(file) => patch(r.messageId, (x) => ({ ...x, teaserFile: file }))}
                />
              )}
              {(r.src.video.note || r.src.teaser?.note || r.src.warnings.length > 0) && (
                <div className="hint" style={{ margin: "6px 0 0" }}>
                  {r.src.video.note && `⚠ видео: ${r.src.video.note}`}
                  {r.src.teaser?.note && ` · ⚠ тизер: ${r.src.teaser.note}`}
                  {r.src.warnings.map((w) => ` · ⚠ ${w}`).join("")}
                </div>
              )}
              <button
                type="button"
                className="btn ghost small"
                style={{ marginTop: 6 }}
                onClick={() => patch(r.messageId, (x) => ({ ...x, open: !x.open }))}
              >
                {r.open
                  ? "Свернуть рецепт"
                  : r.recipeText
                    ? "Рецепт (поправить)"
                    : r.src.cardPhotos.length > 0
                      ? "Рецепта текстом нет — прочитаем с карточки"
                      : "Рецепта нет — добавить"}
              </button>
              {r.open && (
                <textarea
                  rows={8}
                  value={r.recipeText}
                  onChange={(e) => patch(r.messageId, (x) => ({ ...x, recipeText: e.target.value }))}
                  style={{ width: "100%", marginTop: 6 }}
                  aria-label="Рецепт"
                />
              )}
            </div>
          ))}

          {intro.length > 0 && (
            <div className="card soft" style={{ marginBottom: 10 }}>
              <button type="button" className="btn ghost small" onClick={() => setIntroOpen((v) => !v)}>
                {introOpen ? "Скрыть вступление" : `Вступление без урока: ${intro.length} ${plural(intro.length, "пост", "поста", "постов")}`}
              </button>
              {introOpen && (
                <>
                  <p className="hint">
                    Приветствие, инструменты, закрепы — не импортируются. Из них можно потом собрать вводный урок в «Курсах».
                  </p>
                  <ul className="hint" style={{ margin: 0, paddingLeft: 18 }}>
                    {intro.map((p) => (
                      <li key={p.messageId}>
                        {p.kind === "photo" ? "📷 " : p.kind === "video" ? "🎬 " : "✎ "}
                        {p.text ? firstLine(p.text) : p.file ? basename(p.file) : "(пусто)"}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn quiet" onClick={() => setStep(1)}>
              ← Назад
            </button>
            <button className="btn" disabled={chosenCount === 0} onClick={() => setStep(3)}>
              Дальше →
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="radio-group" role="radiogroup" aria-label="Курс">
            {COURSES.map((c) => (
              <label key={c.code} className="toggle">
                <input type="radio" name="course" checked={courseCode === c.code} onChange={() => setCourseCode(c.code)} />
                {c.label}
              </label>
            ))}
          </div>
          <label className="field">
            <span>Раздел — под этим заголовком уроки появятся у учениц</span>
            <input type="text" value={moduleTitle} onChange={(e) => setModuleTitle(e.target.value)} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} />
            Удалять видео с сервера после заливки в хранилище (освобождает место)
          </label>
          <label className="toggle" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={ocrCards} onChange={(e) => setOcrCards(e.target.checked)} />
            Прочитать рецепты с карточек через ИИ ({cardsChosen} {plural(cardsChosen, "урок", "урока", "уроков")} с карточкой) —
            только туда, где рецепт текстом пуст; результат помечен как «с карточки», проверьте цифры
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn quiet" onClick={() => setStep(2)}>
              ← Назад
            </button>
            <button className="btn" disabled={busy || !moduleTitle.trim()} onClick={() => void run()}>
              {busy ? "Запускаю…" : `Запустить импорт (${chosenCount})`}
            </button>
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <EmptyState scene="Importing" title="Импорт идёт" hint="Видео перекодируются и уходят в хранилище — можно закрыть панель, работа продолжится." size={96} />
          <Progress status={status} />
          <p className="hint">Обновляется каждые три секунды.</p>
        </>
      )}

      {step === 5 && (
        <>
          {status?.lastResult && !status.lastError && (
            <EmptyState scene="CourseReady" title="Курс собран" hint="Уроки уже в приложении у учениц. Осталось проверить рецепты с карточек." size={96} />
          )}
          <Progress status={status} />
          {status?.lastResult && (
            <div className="msg ok">
              Создано уроков: {status.lastResult.created}, пропущено (уже были): {status.lastResult.skipped}, ошибок:{" "}
              {status.lastResult.errors}
              {typeof status.lastResult.ocr === "number" && `, рецептов с карточек: ${status.lastResult.ocr}`}.
            </div>
          )}
          {status?.lastError && <div className="msg err">Импорт прерван: {status.lastError}</div>}
          {reviewCount !== null && reviewCount > 0 && (
            <button className="btn ghost wide" style={{ marginBottom: 10 }} onClick={() => onGo("recipes")}>
              Проверьте рецепты с карточек ({reviewCount})
            </button>
          )}
          {folder && folders.some((f) => f.name === folder) && (
            <button className="btn danger wide" style={{ marginBottom: 10 }} disabled={deleting || Boolean(status?.running)} onClick={() => void deleteSources()}>
              {deleting ? "Удаляю…" : `Удалить исходники (${folders.find((f) => f.name === folder)?.sizeGb ?? 0} ГБ)`}
            </button>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => onGo("courses")}>
              Открыть «Курсы»
            </button>
            <button
              className="btn quiet"
              onClick={() => {
                setStep(1);
                void loadFolders();
              }}
            >
              Ещё одна папка
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Галочка/крестик с подписью: ok=null — «не предусмотрено» (тизера не было в постах). */
function Mark({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const sign = ok === null ? "—" : ok ? "✓" : "✗";
  const color = ok === null ? "var(--muted, #888)" : ok ? "var(--ok, #2a8a4a)" : "var(--danger, #c0392b)";
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span aria-hidden style={{ color, fontWeight: 600 }}>
        {sign}
      </span>{" "}
      {label}
      {detail ? ` ${detail}` : ""}
    </span>
  );
}

function FilePicker({
  label,
  value,
  candidates,
  onChange,
}: {
  label: string;
  value: string | null;
  candidates: string[];
  onChange: (file: string | null) => void;
}) {
  return (
    <label className="field" style={{ marginTop: 6 }}>
      <span>{label} — по длительности подходят несколько, выберите</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— не выбран —</option>
        {candidates.map((c) => (
          <option key={c} value={c}>
            {basename(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Progress({ status }: { status: Status | null }) {
  const p = status?.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 10, borderRadius: 6, background: "var(--bg-soft)", overflow: "hidden", margin: "8px 0" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width .3s" }} />
      </div>
      <div>
        {p ? `${p.done} из ${p.total}` : status?.running ? "Готовлюсь…" : "—"}
        {p?.current && status?.running ? ` · сейчас: ${p.current}` : ""}
      </div>
      {p && p.errors.length > 0 && (
        <ul className="hint" style={{ marginTop: 8 }}>
          {p.errors.map((e, i) => (
            <li key={i}>
              {e.item}: {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDuration(sec: number | null): string {
  if (!sec) return "длительность ?";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** Упрощённое зеркало titleFromFileName с сервера — только для подстановки в поле. */
function titleFromFile(file: string): string {
  const s = basename(file)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\(\s*\d*\s*\)/g, " ")
    .replace(/[-_\s]*(?:копия|copy)[-_\s]*/gi, " ")
    .replace(/_+/g, " ")
    .replace(/\s*\d+\s*$/, "")
    .replace(/^\s*\d+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return /\p{L}/u.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
