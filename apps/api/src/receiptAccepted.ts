/**
 * ОДНО ПОНЯТИЕ "ЧЕК ПРИНЯТ" (ревью PR 67, 08.11.2026): все проверки повторов,
 * уборка тревог и защита от второго платежа берут его ОТСЮДА. Сторож -
 * tests/unit/receiptAlerts.test.ts (сторож): свои копии условия запрещены.
 */
export function receiptAccepted(r: {
  linkSent: boolean;
  ownerDecision: string | null;
  kind: string;
  awaitingDeliveryChoice: boolean;
}): boolean {
  return r.linkSent || r.ownerDecision === "APPROVED" || r.ownerDecision === "HANDLED" || (r.kind === "valid" && r.awaitingDeliveryChoice);
}

/** То же условие для запросов к базе (Prisma OR). */
export const ACCEPTED_WHERE = [
  { linkSent: true },
  { ownerDecision: "APPROVED" },
  { ownerDecision: "HANDLED" },
  { kind: "valid", awaitingDeliveryChoice: true },
];
