/**
 * Шина «открой чат». Кнопки «Купить онлайн-курс» разбросаны по статичной
 * разметке и по островкам React, а виджет — один и ленивый. Событие на
 * window связывает их без общего состояния и без импорта виджета в каждую
 * кнопку.
 */

export const CHAT_OPEN_EVENT = "ssb:chat-open";

export type ChatOpenDetail = { prefill?: string };

let listeners = 0;
let pending: ChatOpenDetail | undefined;

export function openChat(prefill?: string): void {
  if (!listeners) { pending = { prefill }; return; }
  window.dispatchEvent(new CustomEvent<ChatOpenDetail>(CHAT_OPEN_EVENT, { detail: { prefill } }));
}

export function onChatOpen(cb: (detail: ChatOpenDetail) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<ChatOpenDetail>).detail ?? {});
  listeners++;
  window.addEventListener(CHAT_OPEN_EVENT, handler);
  if (pending) { const requested = pending; pending = undefined; cb(requested); }
  return () => { listeners--; window.removeEventListener(CHAT_OPEN_EVENT, handler); };
}
