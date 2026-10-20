/**
 * ОЧЕРЕДЬ ВОПРОСОВ, НАПИСАННЫХ БЕЗ СЕТИ.
 *
 * Написанное без интернета не теряется: складывается сюда и уходит, когда
 * связь появится. В ленте такое сообщение видно сразу, с пометкой. Живёт в
 * localStorage, а не в IndexedDB: это несколько строк текста, и синхронный
 * доступ проще — читаем при первом рендере, без мигания «пусто → есть».
 *
 * Сервер получает `queuedOffline: true`, чтобы владелец в панели понимал
 * разрыв между временем вопроса и временем доставки.
 */

const QUEUE_KEY = "ssb_course_chat_queue";

export type QueuedChat = { text: string; lessonId: string | null; at: number };

export function readQueue(): QueuedChat[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedChat[]) : [];
  } catch {
    return [];
  }
}

export function writeQueue(items: QueuedChat[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Приватный режим или переполненное хранилище — очередь просто не
    // переживёт перезагрузку. Это лучше, чем уронить отправку.
  }
}

export function enqueue(item: QueuedChat): QueuedChat[] {
  const next = [...readQueue(), item];
  writeQueue(next);
  return next;
}

/**
 * Отправить накопленное по порядку. Первая же неудача останавливает: сеть,
 * скорее всего, снова пропала, и молотить остальные записи бессмысленно —
 * они уйдут при следующем `online`. Порядок вопросов при этом сохраняется.
 */
export async function flushQueue(
  send: (item: QueuedChat) => Promise<unknown>
): Promise<{ sent: QueuedChat[]; left: QueuedChat[] }> {
  const pending = readQueue();
  const sent: QueuedChat[] = [];
  for (const item of pending) {
    try {
      await send(item);
    } catch {
      break;
    }
    sent.push(item);
    writeQueue(readQueue().filter((q) => q.at !== item.at));
  }
  return { sent, left: readQueue() };
}
