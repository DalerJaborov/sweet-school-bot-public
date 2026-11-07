import { useEffect, useState, lazy, Suspense } from "react";
import { freeLessonCopy, type Lang } from "./i18n";
import type { RecipeCardData } from "../course/api";
const Video = lazy(() => import("./FreeLessonVideo"));
const BASE = "/api/v1/free-lesson";

type Offer = {
  enabled: boolean;
  unlocked?: boolean;
  id: string;
  title: string;
  coverUrl: string | null;
  durationSec: number | null;
};
type Content = {
  id: string;
  title: string;
  recipeText: string | null;
  recipeData: RecipeCardData | null;
  manifestUrl: string;
};
export function FreeLesson({ lang }: { lang: Lang }) {
  const t = freeLessonCopy[lang];
  const [offer, setOffer] = useState<Offer | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    fetch(BASE)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (value: Offer | null) => {
        if (!active) return;
        setOffer(value);
        if (value?.unlocked) {
          const response = await fetch(`${BASE}/content`);
          if (response.ok && active) setContent(await response.json());
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!offer?.enabled) return null;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    const fields = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${BASE}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fields.get("name"), phone: fields.get("phone"), lang }),
      });
      if (!response.ok) throw new Error();
      const lesson = await fetch(`${BASE}/content`);
      if (!lesson.ok) throw new Error();
      setContent(await lesson.json());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="free-lesson card" aria-labelledby="free-lesson-title">
      <div>
        <h2 className="h2" id="free-lesson-title">
          {t.title}
        </h2>
        <h3 className="h3">{offer.title}</h3>
        {!!offer.durationSec && (
          <p className="muted">
            {Math.ceil(offer.durationSec / 60)} {t.minutes}
          </p>
        )}
        {!content && offer.coverUrl && (
          <img src={offer.coverUrl} alt={offer.title} width="640" height="360" loading="lazy" />
        )}
      </div>
      {content ? (
        <div>
          <Suspense fallback={<p role="status">{t.loading}</p>}>
            <Video lang={lang} title={content.title} src={content.manifestUrl} />
          </Suspense>
          <h3>{t.recipe}</h3>
          {content.recipeData ? (
            content.recipeData.components.map((group, index) => (
              <div key={index}>
                <h4>{group.name}</h4>
                <ul>
                  {group.items.map((item, i) => (
                    <li key={i}>{[item.ingredient, item.amount, item.unit, item.note].filter(Boolean).join(" · ")}</li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="free-recipe">{content.recipeText || t.noRecipe}</p>
          )}
          <a className="btn" href={`${lang === "tg" ? "/tg" : ""}/online-kurs#kupit`}>
            {t.courses}
          </a>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p>{t.lead}</p>
          <label>
            {t.name}
            <input name="name" autoComplete="given-name" required minLength={2} maxLength={80} />
          </label>
          <label>
            {t.phone}
            <input name="phone" type="tel" autoComplete="tel" inputMode="tel" required minLength={9} maxLength={30} />
          </label>
          <p className="muted">{t.privacy}</p>
          {error && <p role="alert">{t.error}</p>}
          <button className="btn" disabled={busy}>
            {busy ? t.sending : t.action}
          </button>
        </form>
      )}
    </section>
  );
}
