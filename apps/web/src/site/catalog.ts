/**
 * Один запрос каталога на страницу. Карточки курсов и блок офлайна — разные
 * островки React, но данные им нужны одни и те же; обещание кэшируется на
 * уровне модуля, чтобы не дёргать /api/site/courses дважды.
 */

import { useCallback, useEffect, useState } from "react";
import { api, type Catalog } from "./api";

let inflight: Promise<Catalog> | null = null;

export function loadCatalog(force = false): Promise<Catalog> {
  if (!inflight || force) {
    inflight = api.catalog().catch((e) => {
      inflight = null;
      throw e;
    });
  }
  return inflight;
}

/** Только для тестов: сбросить кэш между кейсами. */
export function resetCatalogCache(): void {
  inflight = null;
}

export type CatalogState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: Catalog; error: null }
  | { status: "error"; data: null; error: Error };

export function useCatalog(): CatalogState & { retry: () => void } {
  const [state, setState] = useState<CatalogState>({ status: "loading", data: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading", data: null, error: null });
    loadCatalog(attempt > 0).then(
      (data) => alive && setState({ status: "ready", data, error: null }),
      (error: Error) => alive && setState({ status: "error", data: null, error }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
