import { createHash } from "node:crypto";
import type { Contact } from "@prisma/client";
import { prisma, getSetting, logError } from "./db.js";
import { toSomoni } from "./exchangeRates.js";

/**
 * ПОКУПКИ — В РЕКЛАМУ META (Conversions API for Business Messaging, 08.11.2026).
 *
 * Зачем. Реклама «клик в переписку» учится на том, о чём ей сообщают. Без
 * сигнала об оплате она ищет тех, кто охотно пишет; с ним — тех, кто платит.
 * Единственная дверь: оплату в очередь кладёт только enqueuePurchaseConversion,
 * в Meta отправляет только runMetaConversions. Сторож — metaConversionsDoor.test.ts.
 *
 * Первоисточник (developers.facebook.com/documentation/ads-commerce/conversions-api/
 * business-messaging, проверено 08.11.2026):
 *  — POST /{dataset_id}/events, action_source=business_messaging, messaging_channel;
 *  — Instagram: user_data.instagram_business_account_id + ig_sid;
 *    оптимизация рекламы на покупки для Instagram НЕ доступна — только отчёт;
 *  — Messenger: page_id + page_scoped_user_id;
 *  — WhatsApp: whatsapp_business_account_id + ctwa_clid; без ctwa_clid —
 *    page_id + WABA + хешированный телефон. Нужен официальный WhatsApp Cloud API:
 *    у школы WhatsApp идёт через мост на WhatsApp Web, WABA нет — такие оплаты
 *    помечаются skipped, пока номер не подключён к Cloud API;
 *  — Meta НЕ убирает дубли сама: защита — уникальный eventId в нашей очереди.
 *
 * Валюта: деньги считаются в сомони, кабинет рекламы в долларах. Отправляем в
 * USD по курсу дня (exchangeRates.ts): поддерживает ли Meta TJS — по
 * первоисточнику НЕ подтверждено, а ошибка тут тихо портит ценность покупок.
 */

const GRAPH = "https://graph.facebook.com/v27.0";
/** Meta не принимает события старше 7 дней (общее правило Conversions API). */
const MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAX_ATTEMPTS = 8;

export type ConversionSettings = {
  enabled: boolean;
  datasetId: string;
  token: string;
  testEventCode: string;
  igAccountId: string;
  pageId: string;
  wabaId: string;
};

export async function readConversionSettings(): Promise<ConversionSettings> {
  const get = async (key: string) => (await getSetting(key))?.trim() ?? "";
  return {
    enabled: (await get("metaCapiEnabled")) === "true",
    datasetId: await get("metaCapiDatasetId"),
    token: await get("metaCapiToken"),
    testEventCode: await get("metaCapiTestEventCode"),
    // Id профессионального аккаунта Instagram = entry.id вебхука; уже хранится для импорта истории.
    igAccountId: (await get("metaCapiIgAccountId")) || (await get("igBusinessId")),
    pageId: await get("fbPageId"),
    wabaId: await get("metaCapiWabaId"),
  };
}

/* ------------------------- откуда пришёл человек ------------------------- */

export type AdReferral = { source?: string | null; adId?: string | null; ctwaClid?: string | null };

/**
 * Первое касание из рекламы. Пишется один раз: повторный заход с другого
 * объявления не переписывает, кто привёл человека впервые. Без id объявления и
 * без click id запись бессмысленна — пропускаем (ссылка-«m.me» без рекламы).
 */
export async function recordAdReferral(contactId: string, ref: AdReferral): Promise<void> {
  const adId = ref.adId?.trim() || null;
  const ctwaClid = ref.ctwaClid?.trim() || null;
  if (!adId && !ctwaClid) return;
  await prisma.contact.updateMany({
    where: { id: contactId, adReferralAt: null },
    data: { adId, adCtwaClid: ctwaClid, adSource: ref.source?.slice(0, 40) ?? null, adReferralAt: new Date() },
  });
}

/** referral из вебхука Instagram/Messenger: { source, type, ad_id, ref, ads_context_data }. */
export function referralFromMeta(raw: unknown): AdReferral | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const adId = typeof r.ad_id === "string" ? r.ad_id : typeof r.ad_id === "number" ? String(r.ad_id) : null;
  if (!adId) return null;
  return { adId, source: typeof r.source === "string" ? r.source : "ADS" };
}

/* ------------------------------ очередь ------------------------------ */

/** Детерминированный id оплаты: одна оплата = одно событие, сколько бы раз её ни выдавали. */
export function purchaseEventId(purchaseIds: string[]): string {
  return `purchase:${[...purchaseIds].sort()[0]}`;
}

/**
 * Единственная дверь: «эти покупки только что оплачены». Вызывается после
 * создания Purchase. Никогда не бросает — сбой рекламной статистики не должен
 * сорвать выдачу доступа к оплаченному курсу.
 */
export async function enqueuePurchaseConversion(contactId: string, purchaseIds: string[]): Promise<void> {
  try {
    if (purchaseIds.length === 0) return;
    if ((await getSetting("metaCapiEnabled"))?.trim() !== "true") return;
    // Только то, что реально осталось оплаченным: при заморозке бота свежие
    // покупки откатываются, отозванные (фальшивый чек) — не покупка.
    const rows = (await prisma.purchase.findMany({
      where: { id: { in: purchaseIds }, contactId, revokedAt: null },
      select: { id: true, amount: true },
    })) ?? [];
    if (rows.length === 0) return;
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { channel: true } });
    if (!contact) return;
    const ids = rows.map((r) => r.id);
    await prisma.metaConversion.upsert({
      where: { eventId: purchaseEventId(ids) },
      create: {
        eventId: purchaseEventId(ids), contactId, channel: contact.channel,
        purchaseIds: JSON.stringify(ids), valueTjs: rows.reduce((s, r) => s + r.amount, 0),
      },
      update: {},
    });
  } catch (err) {
    logError("metaConversions:enqueue", err);
  }
}

/* --------------------------- кодирование события --------------------------- */

export type BuiltEvent = { ok: true; body: Record<string, unknown> } | { ok: false; skip: string };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Телефон WhatsApp из id контакта моста: "<accountId>:992900000000@c.us" → "992900000000". */
export function whatsappPhone(contact: Pick<Contact, "igUserId" | "name">): string | null {
  const fromChat = contact.igUserId.match(/:(\d{7,15})@c\.us$/)?.[1];
  if (fromChat) return fromChat;
  const fromName = contact.name?.match(/^\+(\d{7,15})$/)?.[1];
  return fromName ?? null;
}

/**
 * Чистая функция: строка очереди + контакт + настройки → тело запроса в Meta
 * или причина, почему отправлять нечего. Тесты — metaConversions.test.ts.
 */
export function buildPurchaseEvent(
  row: { eventId: string; createdAt: Date; channel: string },
  contact: Pick<Contact, "igUserId" | "name" | "adCtwaClid">,
  valueUsd: number,
  s: ConversionSettings,
): BuiltEvent {
  let messagingChannel: string;
  let userData: Record<string, unknown>;
  switch (row.channel) {
    case "INSTAGRAM":
      if (!s.igAccountId) return { ok: false, skip: "Не задан id аккаунта Instagram" };
      messagingChannel = "instagram";
      userData = { instagram_business_account_id: s.igAccountId, ig_sid: contact.igUserId };
      break;
    case "MESSENGER":
      if (!s.pageId) return { ok: false, skip: "Не задан id страницы Facebook" };
      messagingChannel = "messenger";
      userData = { page_id: s.pageId, page_scoped_user_id: contact.igUserId };
      break;
    case "WHATSAPP": {
      if (!s.wabaId) return { ok: false, skip: "WhatsApp не подключён к официальному API Meta (нет WABA)" };
      messagingChannel = "whatsapp";
      if (contact.adCtwaClid) {
        userData = { whatsapp_business_account_id: s.wabaId, ctwa_clid: contact.adCtwaClid };
      } else {
        const phone = whatsappPhone(contact);
        if (!phone || !s.pageId) return { ok: false, skip: "Нет метки рекламы и телефона для сопоставления" };
        userData = { page_id: s.pageId, whatsapp_business_account_id: s.wabaId, ph: [sha256(phone)] };
      }
      break;
    }
    default:
      // Сайт и ручная запись — не покупка «в переписке»; для них другой продукт Meta.
      return { ok: false, skip: `Канал ${row.channel} не переписка` };
  }
  const event = {
    event_name: "Purchase",
    event_time: Math.floor(row.createdAt.getTime() / 1000),
    event_id: row.eventId,
    action_source: "business_messaging",
    messaging_channel: messagingChannel,
    user_data: userData,
    custom_data: { currency: "USD", value: Math.round(valueUsd * 100) / 100 },
  };
  return { ok: true, body: { data: [event], ...(s.testEventCode ? { test_event_code: s.testEventCode } : {}) } };
}

/* ------------------------------ отправка ------------------------------ */

/** Ошибки, при которых повтор не поможет: неверный параметр, нет прав, не тот dataset. */
function isPermanent(status: number): boolean {
  return status === 400 || status === 403 || status === 404;
}

function backoffMs(attempt: number): number {
  return Math.min(6 * 3_600_000, 60_000 * 2 ** attempt);
}

let running = false;

/** Разносчик очереди: раз в несколько минут из index.ts. Повтор при сбое с растущей паузой. */
export async function runMetaConversions(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const s = await readConversionSettings();
    if (!s.enabled || !s.datasetId || !s.token) return;
    const due = await prisma.metaConversion.findMany({
      where: { status: "pending", nextAttemptAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: 20,
      include: { contact: { select: { igUserId: true, name: true, adCtwaClid: true } } },
    });
    for (const row of due) await sendOne(row, s, now);
  } finally {
    running = false;
  }
}

async function sendOne(
  row: { id: string; eventId: string; createdAt: Date; channel: string; valueTjs: number; attempts: number;
    contact: Pick<Contact, "igUserId" | "name" | "adCtwaClid"> },
  s: ConversionSettings,
  now: Date,
): Promise<void> {
  if (now.getTime() - row.createdAt.getTime() > MAX_AGE_MS) {
    await prisma.metaConversion.update({ where: { id: row.id }, data: { status: "expired", lastError: "Старше 7 дней — Meta не примет" } });
    return;
  }
  const somoniPerUsd = await toSomoni(1, "USD");
  if (!somoniPerUsd || somoniPerUsd <= 0) {
    await retryLater(row, "Нет курса доллара — повторим позже", now);
    return;
  }
  const built = buildPurchaseEvent(row, row.contact, row.valueTjs / somoniPerUsd, s);
  if (!built.ok) {
    await prisma.metaConversion.update({ where: { id: row.id }, data: { status: "skipped", lastError: built.skip } });
    return;
  }
  // Маркер — в теле, а не в адресе: адреса попадают в журналы прокси и ошибок.
  let status = 0;
  let detail = "";
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(s.datasetId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...built.body, access_token: s.token }),
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    detail = (await res.text()).slice(0, 300);
    if (res.ok) {
      await prisma.metaConversion.update({ where: { id: row.id }, data: { status: "sent", sentAt: now, attempts: row.attempts + 1, lastError: null } });
      return;
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  if (isPermanent(status) || row.attempts + 1 >= MAX_ATTEMPTS) {
    await prisma.metaConversion.update({ where: { id: row.id }, data: { status: "failed", attempts: row.attempts + 1, lastError: `${status || "сеть"}: ${detail}` } });
    logError("metaConversions:failed", new Error(`Meta отказала в событии ${row.eventId}: ${status} ${detail}`));
    return;
  }
  await retryLater(row, `${status || "сеть"}: ${detail}`, now);
}

async function retryLater(row: { id: string; attempts: number }, reason: string, now: Date): Promise<void> {
  await prisma.metaConversion.update({
    where: { id: row.id },
    data: { attempts: row.attempts + 1, lastError: reason, nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)) },
  });
}

/* ------------------------------ панель ------------------------------ */

/** Сводка для экрана настроек: сколько ушло, что застряло, сколько оплат из рекламы за 7 дней. */
export async function conversionStatus(now = new Date()) {
  const s = await readConversionSettings();
  const grouped = await prisma.metaConversion.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const lastProblem = await prisma.metaConversion.findFirst({
    where: { status: { in: ["failed", "skipped"] } },
    orderBy: { createdAt: "desc" },
    select: { status: true, lastError: true, createdAt: true },
  });
  const weekAgo = new Date(now.getTime() - MAX_AGE_MS);
  const paidFromAdsWeek = await prisma.purchase.count({
    where: { createdAt: { gte: weekAgo }, revokedAt: null, contact: { adReferralAt: { not: null } } },
  });
  const paidWeek = await prisma.purchase.count({ where: { createdAt: { gte: weekAgo }, revokedAt: null } });
  return {
    enabled: s.enabled,
    ready: !!(s.datasetId && s.token),
    testMode: !!s.testEventCode,
    counts,
    lastProblem,
    paidWeek,
    paidFromAdsWeek,
  };
}

/**
 * Проверочное событие для «Тестовых событий» Events Manager. Только с заданным
 * проверочным кодом — без него событие засчиталось бы как настоящая покупка.
 * Берём последнего купившего в Instagram/Messenger: Meta нужен реальный id из переписки.
 */
export async function sendTestEvent(): Promise<{ ok: boolean; detail: string }> {
  const s = await readConversionSettings();
  if (!s.testEventCode) return { ok: false, detail: "Сначала вставьте проверочный код из Events Manager → Тестовые события" };
  if (!s.datasetId || !s.token) return { ok: false, detail: "Не заданы набор данных или маркер" };
  const buyer = await prisma.purchase.findFirst({
    where: { revokedAt: null, contact: { channel: { in: ["INSTAGRAM", "MESSENGER"] } } },
    orderBy: { createdAt: "desc" },
    select: { amount: true, contact: { select: { channel: true, igUserId: true, name: true, adCtwaClid: true } } },
  });
  if (!buyer) return { ok: false, detail: "Нет ни одной покупки из Instagram или Messenger для проверки" };
  const somoniPerUsd = (await toSomoni(1, "USD")) ?? 0;
  if (somoniPerUsd <= 0) return { ok: false, detail: "Нет курса доллара" };
  const built = buildPurchaseEvent(
    { eventId: `test:${Date.now()}`, createdAt: new Date(), channel: buyer.contact.channel },
    buyer.contact, buyer.amount / somoniPerUsd, s,
  );
  if (!built.ok) return { ok: false, detail: built.skip };
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(s.datasetId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...built.body, access_token: s.token }),
      signal: AbortSignal.timeout(20_000),
    });
    return { ok: res.ok, detail: `${res.status}: ${(await res.text()).slice(0, 300)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
