import { AsyncLocalStorage } from "node:async_hooks";
import { getSetting } from "../db.js";

// Permission is scoped to one outbound operation, never to the whole webhook.
// An ordinary AI task cannot inherit the funnel's exemption after it returns.
const permission = new AsyncLocalStorage<"funnel" | "human">();

export async function isBotFrozen(): Promise<boolean> {
  return (await getSetting("botFrozen")) === "true";
}

export async function assertAutomationAllowed(): Promise<void> {
  if (await isBotFrozen()) throw new Error("Bot automation is frozen");
}

export async function assertMessagingAllowed(): Promise<void> {
  if (!permission.getStore()) await assertAutomationAllowed();
}

export function withMessagingPermission<T>(kind: "funnel" | "human", send: () => Promise<T>): Promise<T> {
  return permission.run(kind, send);
}
