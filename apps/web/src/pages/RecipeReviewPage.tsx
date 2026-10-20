import { useCallback, useEffect, useState } from "react";
import { api, type LessonRecipe, type RecipeCard, type RecipeComponent, type RecipeItem, type ReviewRow } from "../api";
import { Icons } from "../components/Brand";
import { EmptyState } from "../components/Illustrations";
import { toast } from "../components/Toast";
import { useUnsavedGuard } from "../components/UnsavedGuard";
import { useTelegramBackButton, useTelegramClosingGuard } from "../telegram";

/**
 * ПРОВЕРКА РЕЦЕПТОВ С КАРТОЧЕК («Утро Ширин» §13).
 *
 * Импорт читает карточку рецепта через ИИ, и «250» может стать «260» — этого
 * не увидит никто, кроме Ширин. Экран кладёт рядом фото карточки (с зумом) и
 * структурированный рецепт по строкам: эмодзи, ингредиент, количество,
 * единица, примечание. Правишь строку, жмёшь «Проверила ✓» — сервер
 * пересобирает текст рецепта из структуры и снимает бейдж «не проверено».
 *
 * Без lessonId — список уроков, ждущих проверки; с lessonId — сама карточка.
 */
export function RecipeReviewPage(props: { lessonId: string | null; onOpen: (lessonId: string | null) => void; onBack: () => void }) {
  const { lessonId, onOpen, onBack } = props;
  if (lessonId) return <RecipeEditor lessonId={lessonId} onDone={() => onOpen(null)} />;
  return <ReviewList onOpen={onOpen} onBack={onBack} />;
}

function ReviewList({ onOpen, onBack }: { onOpen: (id: string) => void; onBack: () => void }) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ rows: ReviewRow[] }>("/admin/recipes/review")
      .then((d) => setRows(d.rows))
      .catch((e) => setErr((e as Error).message));
  }, []);
  useTelegramBackButton(true, onBack);

  return (
    <div className="card">
      <h2>{Icons.media} Проверить рецепты</h2>
      <p className="hint">Рецепты, прочитанные с карточек при импорте. Сверьте цифры с фото — модель могла ошибиться в граммовке.</p>
      {err && <div className="msg err">{err}</div>}
      {!rows && <div className="skeleton" style={{ height: 120 }} />}
      {rows?.length === 0 && (
        <div className="review-done">
          <EmptyState text="Все рецепты проверены" />
          <button type="button" className="btn quiet" onClick={onBack}>
            К курсам
          </button>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="list">
          {rows.map((r) => (
            <div className="list-row" key={r.id}>
              {r.coverUrl ? <img className="review-list-cover" src={r.coverUrl} alt="" /> : <div className="review-list-cover num" aria-hidden>{r.order}</div>}
              <div className="list-main">
                <div className="list-title">
                  {r.order}. {r.title}
                </div>
                <div className="list-sub">
                  {r.course} · {r.module} · {r.photos > 0 ? `карточек: ${r.photos}` : "фото карточки нет"}
                </div>
              </div>
              <div className="list-actions">
                <button type="button" className="btn small" onClick={() => onOpen(r.id)}>
                  Проверить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {rows && rows.length > 0 && (
        <button type="button" className="btn quiet wide" style={{ marginTop: 12 }} onClick={onBack}>
          К курсам
        </button>
      )}
    </div>
  );
}

const EMPTY_ITEM: RecipeItem = { ingredient: "", amount: null, unit: null, note: null, emoji: null };

/** Из markdown, если структуры нет (рецепт вписан руками) — одна часть, строка на ингредиент. */
function cardFromText(text: string | null, title: string): RecipeCard {
  const items: RecipeItem[] = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("**"))
    .map((l) => {
      const m = /^(.+?)\s+—\s+(\S+)(?:\s+(.+?))?(?:\s+\((.+)\))?$/.exec(l);
      return m
        ? { ingredient: m[1], amount: m[2], unit: m[3] ?? null, note: m[4] ?? null, emoji: null }
        : { ...EMPTY_ITEM, ingredient: l };
    });
  return { title, language: "tg", components: [{ name: "", items: items.length ? items : [{ ...EMPTY_ITEM }] }] };
}

function RecipeEditor({ lessonId, onDone }: { lessonId: string; onDone: () => void }) {
  const [lesson, setLesson] = useState<LessonRecipe | null>(null);
  const [card, setCard] = useState<RecipeCard | null>(null);
  const [initial, setInitial] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [zoomed, setZoomed] = useState<number | null>(null);

  useEffect(() => {
    setLesson(null);
    api<LessonRecipe>(`/admin/lessons/${lessonId}/recipe`)
      .then((d) => {
        const c = d.recipeData ?? cardFromText(d.recipeText, d.title);
        setLesson(d);
        setCard(c);
        setInitial(JSON.stringify(c));
      })
      .catch((e) => setErr((e as Error).message));
  }, [lessonId]);

  const dirty = card !== null && JSON.stringify(card) !== initial;
  useUnsavedGuard(dirty);
  useTelegramClosingGuard(dirty);
  useTelegramBackButton(true, onDone);

  const patchComponent = useCallback((ci: number, fn: (c: RecipeComponent) => RecipeComponent) => {
    setCard((c) => (c ? { ...c, components: c.components.map((x, i) => (i === ci ? fn(x) : x)) } : c));
  }, []);
  const patchItem = (ci: number, ii: number, changes: Partial<RecipeItem>) =>
    patchComponent(ci, (c) => ({ ...c, items: c.items.map((it, i) => (i === ii ? { ...it, ...changes } : it)) }));
  const removeItem = (ci: number, ii: number) => patchComponent(ci, (c) => ({ ...c, items: c.items.filter((_, i) => i !== ii) }));
  const addItem = (ci: number) => patchComponent(ci, (c) => ({ ...c, items: [...c.items, { ...EMPTY_ITEM }] }));
  const addComponent = () => setCard((c) => (c ? { ...c, components: [...c.components, { name: "", items: [{ ...EMPTY_ITEM }] }] } : c));
  const removeComponent = (ci: number) => setCard((c) => (c ? { ...c, components: c.components.filter((_, i) => i !== ci) } : c));

  const hasIngredient = Boolean(card?.components.some((c) => c.items.some((it) => it.ingredient.trim())));

  async function save() {
    if (!card) return;
    setSaving(true);
    setErr(null);
    try {
      // Пустые строки не шлём: строка без названия — это недописанная, а не ингредиент.
      const cleaned: RecipeCard = {
        ...card,
        components: card.components
          .map((c) => ({ name: c.name.trim(), items: c.items.filter((it) => it.ingredient.trim()).map((it) => ({ ...it, ingredient: it.ingredient.trim() })) }))
          .filter((c) => c.items.length > 0),
      };
      const r = await api<{ ok: true; reviewLeft: number }>(`/admin/lessons/${lessonId}/recipe`, { method: "PUT", body: { recipeData: cleaned } });
      setInitial(JSON.stringify(card));
      toast(r.reviewLeft > 0 ? `Проверено · осталось ${r.reviewLeft}` : "Проверено · это был последний");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не получилось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          {Icons.media} {lesson ? `${lesson.order}. ${lesson.title}` : "Рецепт"}
        </h2>
        <button type="button" className="btn quiet small" onClick={onDone}>
          ← К списку
        </button>
      </div>
      {lesson && (
        <p className="hint">
          {lesson.course} · {lesson.module}
          {lesson.needsReview ? " · с карточки, не проверено" : lesson.recipeReviewedAt ? " · проверено" : ""}
        </p>
      )}
      {err && <div className="msg err">{err}</div>}
      {!lesson && !err && <div className="skeleton" style={{ height: 240 }} />}

      {lesson && card && (
        <div className="review-layout">
          <div className="review-photos">
            {lesson.photos.length === 0 && <div className="hint">Фото карточки нет — сверять не с чем, проверьте по памяти.</div>}
            {lesson.photos.map((url, i) => (
              <div className="review-photo-wrap" key={url}>
                <div className={`review-photo ${zoomed === i ? "zoomed" : ""}`}>
                  <img src={url} alt={`Карточка рецепта ${i + 1}`} onClick={() => setZoomed(zoomed === i ? null : i)} />
                </div>
                <button type="button" className="review-photo-zoom" onClick={() => setZoomed(zoomed === i ? null : i)}>
                  {zoomed === i ? "Уменьшить" : "Увеличить"}
                </button>
              </div>
            ))}
          </div>

          <div className="recipe-edit">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Название десерта на карточке</span>
              <input value={card.title} onChange={(e) => setCard({ ...card, title: e.target.value })} />
            </label>
            {card.components.map((c, ci) => (
              <div className="recipe-component" key={ci}>
                <div className="recipe-component-head">
                  <input
                    className="recipe-component-name"
                    value={c.name}
                    placeholder="Часть рецепта (хамир, крем…)"
                    aria-label="Название части рецепта"
                    onChange={(e) => patchComponent(ci, (x) => ({ ...x, name: e.target.value }))}
                  />
                  {card.components.length > 1 && (
                    <button type="button" className="recipe-row-remove" aria-label="Убрать часть" onClick={() => removeComponent(ci)}>
                      ×
                    </button>
                  )}
                </div>
                {c.items.map((it, ii) => (
                  <div className="recipe-row" key={ii}>
                    <input className="recipe-emoji" value={it.emoji ?? ""} aria-label="Эмодзи" onChange={(e) => patchItem(ci, ii, { emoji: e.target.value || null })} />
                    <input value={it.ingredient} placeholder="Ингредиент" aria-label="Ингредиент" onChange={(e) => patchItem(ci, ii, { ingredient: e.target.value })} />
                    <input className="recipe-amount" value={it.amount ?? ""} placeholder="250" aria-label="Количество" inputMode="decimal" onChange={(e) => patchItem(ci, ii, { amount: e.target.value || null })} />
                    <input value={it.unit ?? ""} placeholder="г" aria-label="Единица" onChange={(e) => patchItem(ci, ii, { unit: e.target.value || null })} />
                    <button type="button" className="recipe-row-remove" aria-label="Убрать строку" onClick={() => removeItem(ci, ii)}>
                      ×
                    </button>
                    <input className="recipe-note" value={it.note ?? ""} placeholder="примечание" aria-label="Примечание" onChange={(e) => patchItem(ci, ii, { note: e.target.value || null })} />
                  </div>
                ))}
                <button type="button" className="btn ghost small" style={{ marginTop: 8 }} onClick={() => addItem(ci)}>
                  + Строка
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost small" onClick={addComponent}>
              + Часть рецепта
            </button>
            <button type="button" className="btn wide" disabled={saving || !hasIngredient} onClick={() => void save()}>
              {saving ? "Сохраняю…" : "Проверила ✓"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
