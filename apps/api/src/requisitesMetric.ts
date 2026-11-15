import { prisma, logError } from "./db.js";
import { mentionsPaymentPhone } from "./ai/repeatGuard.js";
import { getSalesTexts } from "./services/salesTextsService.js";
import { notifyOwnerDirect } from "./systemAlerts.js";

/**
 * «ПОЛУЧИЛИ НОМЕР КАРТЫ» — ОДНО ОПРЕДЕЛЕНИЕ НА ПАНЕЛЬ И СВОДКУ (16.11.2026).
 *
 * Разбор 16.11: после #86 номер карты доходил 1–3 людям в день вместо 7–17, а
 * заметили это только по упавшим оплатам через четыре дня. Теперь число в сводке
 * и тревога владельцу, если оно резко упало.
 *
 * Человек «получил номер», если в НАШИХ сообщениях ему есть номер для оплаты из
 * «Тексты и цены» (paymentPhone), с пробелами, дефисами или без. Раньше панель
 * (admin.ts /admin/funnel-stats) держала свой список с номером, вписанным в код,
 * и считала «получил» ещё по слову «Алиф» или имени получателя.
 */
export function gotRequisites(ourTexts: readonly (string | null | undefined)[], phone: string): boolean {
  return ourTexts.some((t) => mentionsPaymentPhone(t ?? "", phone));
}

const DAY = 86_400_000;

export type RequisitesReach = {
  /** Получили номер за последние 24 часа (разных людей). */
  last24h: number;
  /** То же за предыдущие 24 часа. */
  prev24h: number;
  /** Среднее за 7 суток до последних 24 часов. */
  avg7: number;
  /** Новых людей, написавших за последние 24 часа. */
  newContacts24h: number;
};

/**
 * Скользящие сутки, а не календарные: сводка уходит в настроенный час, и утренняя
 * сводка «с полуночи» показала бы треть дня и ложную тревогу.
 */
export async function requisitesReach(now = Date.now()): Promise<RequisitesReach> {
  const [texts, rows, newContacts24h] = await Promise.all([
    getSalesTexts(),
    prisma.message.findMany({
      where: { direction: "OUT", text: { not: null }, createdAt: { gte: new Date(now - 8 * DAY), lte: new Date(now) } },
      select: { contactId: true, text: true, createdAt: true },
    }),
    prisma.contact.count({
      where: { createdAt: { gte: new Date(now - DAY) }, personal: false, messages: { some: { direction: "IN" } } },
    }),
  ]);
  const buckets: Set<string>[] = Array.from({ length: 8 }, () => new Set<string>());
  for (const m of rows ?? []) {
    if (!mentionsPaymentPhone(m.text ?? "", texts.paymentPhone)) continue;
    const k = Math.floor((now - m.createdAt.getTime()) / DAY);
    if (k >= 0 && k < 8) buckets[k].add(m.contactId);
  }
  const week = buckets.slice(1).map((b) => b.size);
  return {
    last24h: buckets[0].size,
    prev24h: buckets[1].size,
    avg7: Math.round((week.reduce((a, b) => a + b, 0) / week.length) * 10) / 10,
    newContacts24h: newContacts24h ?? 0,
  };
}

/** Строка сводки. */
export function requisitesReachLine(r: RequisitesReach): string {
  return `💳 номер карты получили: ${r.last24h} за сутки (вчера ${r.prev24h} · в среднем ${r.avg7})`;
}

/** Порог тревоги: меньше половины среднего за неделю при хотя бы 20 новых людях за сутки. */
export const REQUISITES_DROP_RATIO = 0.5;
export const REQUISITES_DROP_MIN_NEW = 20;

export function requisitesDropped(r: RequisitesReach): boolean {
  return r.newContacts24h >= REQUISITES_DROP_MIN_NEW && r.avg7 > 0 && r.last24h < r.avg7 * REQUISITES_DROP_RATIO;
}

/**
 * Тревога — только владельцу (вид «Сбои», Ширин его не получает — решение 11.11:
 * ей только деньги и офлайн-записи), не чаще раза в 20 часов.
 */
export async function alertIfRequisitesDropped(r: RequisitesReach): Promise<boolean> {
  if (!requisitesDropped(r)) return false;
  try {
    await notifyOwnerDirect(
      `⚠️ Номер карты получили ${r.last24h} за сутки при ${r.newContacts24h} новых людях, а в среднем за неделю ${r.avg7}. ` +
        "Похоже, бот перестал давать номер: откройте последние переписки в панели.",
      { dedupeKey: "requisites-drop", cooldownMs: 20 * 3_600_000 },
    );
    return true;
  } catch (err) {
    logError("requisitesMetric:alert", err);
    return false;
  }
}
