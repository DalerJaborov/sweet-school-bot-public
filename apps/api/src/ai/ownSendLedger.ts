/**
 * ЖУРНАЛ СВОИХ ОТПРАВОК: «это эхо нашего же сообщения, а не хозяйка».
 *
 * Эхо в Instagram/Messenger приходит вебхуком на КАЖДОЕ исходящее. Если mid в базе
 * нет, handleEcho считает, что ответила живая Ширин, и навсегда выключает бота для
 * клиента. Раньше свои сообщения опознавались только по записи mid в базе, которую
 * делает вызывающий код ПОСЛЕ отправки. Дыры (инцидент 08.11.2026 и родственные):
 *   1) эхо прилетает раньше, чем Graph вернул нам mid (гонка) — запись ещё не сделана;
 *   2) Graph не ответил или ответил без message_id (AMBIGUOUS), хотя сообщение ушло —
 *      mid мы не узнаем никогда, а эхо придёт;
 *   3) вызывающий код забыл записать mid (как было с картинками воронки).
 *
 * Журнал живёт в памяти процесса (один контейнер, как debounce.ts) и закрывает
 * 1) и 2) без участия вызывающего кода. Пункт 3 лечит самолечение (takeoverHeal.ts).
 */

import { metaFailureKind } from "../messaging/metaErrors.js";

const OWN_MID_TTL_MS = 10 * 60_000;
const AMBIGUOUS_TTL_MS = 3 * 60_000;
/** Типичная отправка (в том числе вложения) укладывается в 30 с; дольше эхо не держим: оно держит всю
 *  пачку из десяти событий вебхука. Если отправка закончится позже, лечит самолечение (takeoverHeal.ts). */
const MAX_WAIT_MS = 30_000;
/** Вложение без mid сопоставляем только с эхом в ближайшие секунды: у вложения нет текста,
 *  и иначе настоящее фото/голосовое хозяйки приняли бы за наше. */
const AMBIGUOUS_ATTACHMENT_TTL_MS = 30_000;
const POLL_MS = 100;

const ownMids = new Map<string, number>();
/** Сколько запросов отправки к Graph сейчас в полёте, по получателю (id в Meta). */
const inflight = new Map<string, number>();
/** Отправки без подтверждения: сообщение могло уйти, а mid мы не знаем. */
type Ambiguous = { recipient: string; text: string | null; at: number };
let ambiguous: Ambiguous[] = [];
/** Ответ на комментарий (private reply) не знает id получателя — считаем отдельно. */
const ANY = "*";

function prune(now = Date.now()): void {
  for (const [mid, at] of ownMids) if (now - at > OWN_MID_TTL_MS) ownMids.delete(mid);
  ambiguous = ambiguous.filter((a) => now - a.at < AMBIGUOUS_TTL_MS);
}

function bumpPrune(): void { prune(); }

function bump(key: string, delta: number): void {
  const next = (inflight.get(key) ?? 0) + delta;
  if (next <= 0) inflight.delete(key);
  else inflight.set(key, next);
}

/**
 * Обернуть запрос отправки в Graph: пока он в полёте, эхо этого получателя ждёт.
 * `text` нужен для сопоставления в неоднозначном случае (null — вложение).
 */
export async function trackOwnSend(
  recipient: string | null,
  text: string | null,
  send: () => Promise<{ message_id?: unknown }>,
): Promise<string | null> {
  const key = recipient ?? ANY;
  bumpPrune();
  bump(key, 1);
  try {
    const res = await send();
    const mid = typeof res.message_id === "string" && res.message_id ? res.message_id : null;
    if (mid) ownMids.set(mid, Date.now());
    else if (recipient) ambiguous.push({ recipient, text, at: Date.now() });
    return mid;
  } catch (err) {
    // Ответа не было — сообщение могло дойти. Запоминаем, чтобы эхо не сочли хозяйкой.
    // Окончательные отказы (токен, окно 24 ч, лимит) ничего не доставили — их не помним.
    const kind = metaFailureKind(err);
    if (recipient && (kind === null || kind === "AMBIGUOUS" || kind === "TRANSIENT")) {
      ambiguous.push({ recipient, text, at: Date.now() });
    }
    throw err;
  } finally {
    bump(key, -1);
  }
}

export function isOwnMid(mid: string): boolean {
  prune();
  return ownMids.has(mid);
}

/** Ждём, пока отправки этому получателю (и ответы на комментарии) закончатся. */
async function waitInflight(recipient: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (((inflight.get(recipient) ?? 0) > 0 || (inflight.get(ANY) ?? 0) > 0) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export type OwnEchoVerdict = "own" | "ambiguous" | "unknown";

/**
 * Эхо пришло, а mid в базе нет. Решаем, наше ли оно.
 *  own        — mid подтверждён Graph'ом нам же (запись в базу ещё не сделана);
 *  ambiguous  — отправка без mid совпала по получателю, тексту и времени;
 *  unknown    — настоящее вмешательство человека.
 */
export async function classifyUnknownEcho(
  recipient: string,
  mid: string,
  text: string | null,
  hasAttachment: boolean,
): Promise<OwnEchoVerdict> {
  await waitInflight(recipient);
  prune();
  if (ownMids.has(mid)) return "own";
  const wanted = norm(text);
  const now = Date.now();
  const idx = ambiguous.findIndex(
    (a) =>
      a.recipient === recipient &&
      (wanted ? norm(a.text) === wanted : hasAttachment && a.text === null && now - a.at < AMBIGUOUS_ATTACHMENT_TTL_MS)
  );
  if (idx >= 0) {
    ambiguous.splice(idx, 1);
    return "ambiguous";
  }
  return "unknown";
}

/** Только для тестов. */
export function resetOwnSendLedger(): void {
  ownMids.clear();
  inflight.clear();
  ambiguous = [];
}
