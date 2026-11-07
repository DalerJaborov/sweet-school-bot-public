import { AsyncLocalStorage } from "node:async_hooks";
export type WhatsAppTurn = { inboxId: string; contactId: string; accountId: string; chatId: string; messageId: string; sequence: number };
const turn = new AsyncLocalStorage<WhatsAppTurn>();
export const currentWhatsAppTurn = () => turn.getStore();
export function withWhatsAppTurn<T>(value: Omit<WhatsAppTurn, "sequence">, fn: () => Promise<T>): Promise<T> {
  return turn.run({ ...value, sequence: 0 }, fn);
}
