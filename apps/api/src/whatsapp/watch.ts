import { getSetting, setSetting, logError } from "../db.js";
import { shouldSendAlert } from "../alertGate.js";
import { sendTelegramMessage, techChatIds } from "../telegram.js";
import { bridgeRequest, whatsappConfigured } from "./client.js";

/**
 * СТОРОЖ СВЯЗИ С WHATSAPP (08.11.2026).
 *
 * Сессия WhatsApp живёт в мосте (services/whatsapp-bridge). Если вход слетел
 * (state pairing / disconnected / auth_failure), мост не отвечает или контакты не
 * загрузились — бот молча перестаёт отвечать в WhatsApp. Раз в минуту спрашиваем
 * статус моста; если плохо ДОЛЬШЕ 10 минут подряд:
 *   • в панели («Сегодня» → «Что-то работает не так») появляется строка с подсказкой;
 *   • владельцу (и только ему — techChatIds) уходит одно сообщение, не чаще раза в 6 ч
 *     (alertGate). Короткие перезапуски моста никого не будят.
 *
 * Пока WhatsApp ни разу не был подключён (`whatsappEverReady` пуст), молчим: нечему
 * «отключаться». /health сюда НЕ подмешиваем: перезапуск api WhatsApp не лечит, а сторож
 * сервера стал бы перезапускать контейнер впустую.
 */

export const WHATSAPP_SUSTAINED_MS = 10 * 60_000;
const EVER_READY_KEY = "whatsappEverReady";

type BridgeStatus = { state?: string; contactsReady?: boolean };
type Kind = "down" | "unlinked";
let problem: { since: number; kind: Kind } | null = null;

const HINT = "Настройки → WhatsApp → Подключить.";

function textFor(kind: Kind): string {
  return kind === "down"
    ? `WhatsApp: мост связи не отвечает, ответы клиентам в WhatsApp не идут. Если не пройдёт само — ${HINT}`
    : `WhatsApp отключился, нужна повторная привязка: ${HINT}`;
}

/** Строка для панели: только когда плохо уже дольше порога. */
export function whatsappProblem(now = Date.now()): string | null {
  return problem && now - problem.since >= WHATSAPP_SUSTAINED_MS ? textFor(problem.kind) : null;
}

export function resetWhatsappWatch(): void {
  problem = null;
}

export async function checkWhatsappConnection(now = Date.now()): Promise<void> {
  if (!whatsappConfigured()) {
    problem = null;
    return;
  }
  let status: BridgeStatus | null = null;
  try {
    status = await bridgeRequest<BridgeStatus>("/status");
  } catch {
    status = null;
  }

  const good = !!status && (status.state === "ready" || status.state === "paused") && status.contactsReady !== false;
  if (good) {
    problem = null;
    if (!(await getSetting(EVER_READY_KEY))) await setSetting(EVER_READY_KEY, "1");
    return;
  }
  if (!(await getSetting(EVER_READY_KEY))) {
    problem = null; // ещё ни разу не подключали — отключаться нечему
    return;
  }
  const kind: Kind = status ? "unlinked" : "down";
  if (!problem || problem.kind !== kind) problem = { since: problem?.since ?? now, kind };
  if (now - problem.since < WHATSAPP_SUSTAINED_MS) return;

  if (!(await shouldSendAlert(`whatsapp:${kind}`))) return;
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  for (const chatId of await techChatIds()) {
    await sendTelegramMessage(botToken, chatId, `📵 ${textFor(kind)}`).catch((err) => logError("whatsappWatch:send", err));
  }
}
