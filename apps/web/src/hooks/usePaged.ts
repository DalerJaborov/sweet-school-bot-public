import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * ПОДГРУЖАЕМЫЙ СПИСОК. Раньше Клиенты/Журнал/Чеки/Деньги грузили всё разом одним
 * запросом (до 500 строк) — незаметно, пока список маленький, но с ростом школы
 * это будет всё дольше открываться. Хук копит страницы в памяти и просит
 * следующую порцию по кнопке «Показать ещё», а не грузит всё вперёд.
 *
 * `query` — часть строки запроса после skip/take (например, поиск или фильтр
 * периода); меняется — список начинается заново, а не дописывается к старому.
 *
 * RACE CONDITION FIX (03.09.2026): добавлен AbortController для отмены
 * устаревших запросов. Без этого быстрая смена фильтра/поиска приводила к тому,
 * что медленный старый запрос перезаписывал результат быстрого нового —
 * пользователь видел данные от предыдущего фильтра. Паттерн совпадает с
 * DashboardPage/MoneyPage, где cancelled flag уже использовался.
 */
export function usePaged<Row>(
  path: string,
  query: string,
  pageSize = 30,
  skipParamName: "skip" | "rowsSkip" = "skip",
  takeParamName: "take" | "rowsTake" = "take"
) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function load(skip: number, append: boolean) {
    // Отменяем предыдущий in-flight запрос, если он ещё не завершился.
    // Это предотвращает race condition: медленный старый запрос не может
    // перезаписать результат быстрого нового.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}${takeParamName}=${pageSize}&${skipParamName}=${skip}${query ? `&${query}` : ""}`;
    (append ? setLoadingMore : (v: boolean) => !v && setRows(null))(true);
    api<{ rows: Row[]; hasMore: boolean }>(url)
      .then((d) => {
        if (controller.signal.aborted) return;
        setRows((prev) => (append && prev ? [...prev, ...d.rows] : d.rows));
        setHasMore(d.hasMore);
        setErr(null);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setErr(e instanceof Error ? e.message : "Ошибка");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  }

  useEffect(() => {
    load(0, false);
    // При unmount или смене path/query отменяем in-flight запрос,
    // чтобы не было setState на unmounted компоненте.
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, query]);

  return {
    rows,
    hasMore,
    loadingMore,
    err,
    loadMore: () => rows && load(rows.length, true),
    reload: () => load(0, false),
  };
}
