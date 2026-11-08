import { lazy, type ComponentType } from "react";

/**
 * ЛЕНИВАЯ СТРАНИЦА, ПЕРЕЖИВАЮЩАЯ ВЫКЛАДКУ.
 *
 * После выкладки файлы разделов получают новые имена. Вкладка, открытая со
 * вчерашней версии, просит старый файл — и получает 404: раздел не открывается,
 * человек видит ошибку. Тогда один раз перезагружаем страницу (она подтянет
 * свежий каркас). Флаг в sessionStorage не даёт перезагружаться по кругу, если
 * проблема не в версии, а в сети: второй раз ошибка честно доходит до экрана.
 * Успешная загрузка флаг снимает.
 */
export const RELOAD_FLAG = "panel_chunk_reload";

export function loadWithReload<T>(load: () => Promise<T>, reload: () => void = () => location.reload()): Promise<T> {
  return load().then(
    (mod) => {
      try {
        sessionStorage.removeItem(RELOAD_FLAG);
      } catch {
        // без sessionStorage просто не помним флаг
      }
      return mod;
    },
    (error: unknown) => {
      let already = true;
      try {
        already = sessionStorage.getItem(RELOAD_FLAG) === "1";
        if (!already) sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        // хранилища нет — перезагрузку не рискуем, чтобы не зациклиться
      }
      if (already) throw error;
      reload();
      // Страница уходит на перезагрузку; не показываем ошибку, пока она идёт.
      return new Promise<T>(() => undefined);
    },
  );
}

type PageComponent<C> = C extends ComponentType<infer P> ? ComponentType<P> : never;

export function lazyPage<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazy<PageComponent<M[K]>>(() =>
    loadWithReload(load).then((m) => ({ default: m[name] as PageComponent<M[K]> })),
  );
}
