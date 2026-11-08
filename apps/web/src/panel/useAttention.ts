import { useCallback, useEffect, useRef, useState } from "react";
import { api, type QueueItem, type Today } from "../api";

/** Клиент, который ждёт живого ответа (GET /admin/v1/waiting, apps/api/src/waiting.ts). */
export type WaitingClient = {
  contactId: string;
  name: string;
  channel: string;
  channelLabel: string;
  replyUrl: string | null;
  lastText: string;
  at: string;
};

export type Attention = {
  receipts: number;
  questions: number;
  notOpened: number;
  waiting: WaitingClient[];
  /** Помощник выключен — на всех, кто написал, отвечает человек (сервер считает так же). */
  aiOff: boolean;
  /** Первые в очереди — для подписи под числом («первый: @madina, 70 с.»). */
  queue: QueueItem[];
  problems: string[];
};

/**
 * «ЧТО ТРЕБУЕТ ВНИМАНИЯ» — один источник и для экрана «Сегодня», и для
 * красных цифр на кнопках внизу. Два уже существующих запроса: /admin/today
 * (чеки, вопросы учениц, не открывшие уроки) и /admin/v1/waiting (клиенты,
 * ждущие ответа человека). Ничего не выдумываем: нет ответа от сервера — null,
 * а не «ноль дел».
 *
 * Обновляем: при входе, при смене раздела (reload снаружи) и когда человек
 * вернулся на вкладку — сестра оставляет панель открытой и ждёт новых чеков.
 */
export function useAttention(
  enabled: boolean,
  refreshKey: unknown,
): {
  data: Attention | null;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<Attention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    Promise.all([
      api<Today>("/admin/today"),
      // Список клиентов не должен ронять весь экран: если маршрут не ответил,
      // показываем остальное, а ошибку держим отдельно.
      api<{ clients: WaitingClient[]; aiOff?: boolean }>("/admin/v1/waiting").catch((e: unknown) => {
        console.error("waiting clients", e);
        return null;
      }),
    ])
      .then(([today, waiting]) => {
        if (mine !== seq.current) return;
        setError(null);
        setData((prev) => ({
          receipts: today.pendingReceipts,
          questions: today.unansweredQuestions,
          notOpened: today.notOpened,
          waiting: waiting ? waiting.clients : (prev?.waiting ?? []),
          aiOff: waiting ? Boolean(waiting.aiOff) : (prev?.aiOff ?? false),
          queue: today.queue,
          problems: today.system.problems,
        }));
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        // Последние известные цифры надёжнее нуля, который выглядит как «всё хорошо».
        setError(e instanceof Error ? e.message : "Нет связи");
      });
  }, [enabled]);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, reload]);

  return { data, error, reload };
}

/** Что показывать на карточках «Сегодня» — чистая функция, чтобы проверять без экрана. */
export type TodayCardId = "receipts" | "waiting" | "questions" | "notOpened" | "recipes" | "problems";

export function activeCards(a: Attention, simple: boolean): TodayCardId[] {
  const out: TodayCardId[] = [];
  if (a.receipts > 0) out.push("receipts");
  if (a.waiting.length > 0) out.push("waiting");
  if (a.questions > 0) out.push("questions");
  if (a.notOpened > 0) out.push("notOpened");
  if (!simple) {
    if (a.queue.some((q) => q.kind === "recipesToReview")) out.push("recipes");
    if (a.problems.length > 0) out.push("problems");
  }
  return out;
}
