/**
 * Шина «открой чат». Кнопки «Купить онлайн-курс» разбросаны по статичной
 * разметке и по островкам React, а виджет — один и ленивый. Событие на
 * window связывает их без общего состояния и без импорта виджета в каждую
 * кнопку.
 */

export const CHAT_OPEN_EVENT = "ssb:chat-open";

export type ChatOpenDetail = { prefill?: string };

export function openChat(prefill?: string): void {
  window.dispatchEvent(new CustomEvent<ChatOpenDetail>(CHAT_OPEN_EVENT, { detail: { prefill } }));
}

export function onChatOpen(cb: (detail: ChatOpenDetail) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<ChatOpenDetail>).detail ?? {});
  window.addEventListener(CHAT_OPEN_EVENT, handler);
  return () => window.removeEventListener(CHAT_OPEN_EVENT, handler);
}
