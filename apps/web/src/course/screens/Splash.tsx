import { Illustration } from "../components/Illustration";
import type { Dict } from "../i18n";

/** Заставка, пока грузится /me. */
export function Splash({ t }: { t: Dict }) {
  return (
    <div className="center" role="status">
      <Illustration kind="splash" />
      <div className="spinner" aria-hidden="true" />
      <p>{t.loading}</p>
    </div>
  );
}

/** Каталог ещё не заполнен: честно говорим, что курс в подготовке. */
export function Preparing({ t }: { t: Dict }) {
  return (
    <div className="center">
      <Illustration kind="empty" />
      <h1>{t.preparingTitle}</h1>
      <p>{t.preparingMessage}</p>
    </div>
  );
}
