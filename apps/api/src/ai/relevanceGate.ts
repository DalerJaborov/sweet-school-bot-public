import { prisma, getSetting, logError, logWarn, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { currentWhatsAppTurn } from "../whatsapp/context.js";
import { generateWithFallback, thinkingConfigFor } from "../gemini.js";
import { resolveGeminiKeys } from "./geminiKeys.js";
import { logAiCall } from "./aiLog.js";
import { voiceToText } from "./voiceToText.js";
import type { Attachment } from "./media.js";
import type { ClientLanguage } from "./clientLanguage.js";
import { classifyRelevance, decideAction, clarifyText, type RelevanceVerdict, type RelevanceAction } from "./relevance.js";
import type { Contact } from "@prisma/client";

/**
 * Шлюз «не по делу — молчать»: вызывается из aiReply ДО генерации ответа.
 *
 * Применяется только к НОВОМУ собеседнику (см. isEstablished): человек, который
 * уже платил или с которым уже шёл разговор, не должен получить молчание из-за
 * одного короткого «да». Вложения-картинки пропускаем всегда — это могут быть чеки,
 * их ведёт отдельный надёжный путь (rescueIncomingImages).
 *
 * Модель и рубильник — настройками без пересборки:
 *   replyGateEnabled  «false» выключает шлюз целиком;
 *   aiModelGate       модель разбора (по умолчанию gemini-3.1-flash-lite);
 *   aiModelGateStt    модель расшифровки голосового для разбора (та же по умолчанию).
 */
export const GATE_MODEL = "gemini-3.1-flash-lite";
const GATE_TIMEOUT_MS = 20_000;

export class RelevanceRetry extends Error {
  constructor(message: string) {
    super(`WhatsAppGenerationRetry: ${message}`);
  }
}

async function isEstablished(contact: Contact): Promise<boolean> {
  if (contact.paid || contact.accessRevokedAt) return true;
  if ((await prisma.purchase.count({ where: { contactId: contact.id } })) > 0) return true;
  // Уже признанный «по делу» — шлюз его не трогает дальше.
  if ((await prisma.replyGate.count({ where: { contactId: contact.id, cls: "on_topic" } })) > 0) return true;
  // Мы (бот или Ширин) уже отвечали этому человеку, кроме уточняющих вопросов шлюза, — разговор идёт.
  // Молчать на человека, которому уже отвечали, нельзя никогда (ревью 08.11.2026).
  const [outs, clarifies] = await Promise.all([
    prisma.message.count({ where: { contactId: contact.id, direction: "OUT" } }),
    prisma.replyGate.count({ where: { contactId: contact.id, action: "clarify" } }),
  ]);
  return outs > clarifies;
}

async function journal(contact: Contact, text: string, v: RelevanceVerdict, action: RelevanceAction): Promise<void> {
  await prisma.replyGate
    .create({
      data: {
        contactId: contact.id,
        channel: contact.channel,
        cls: v.cls,
        action,
        source: v.source,
        reason: v.reason.slice(0, 200),
        preview: text.slice(0, 200),
      },
    })
    .catch((err) => logError("relevanceGate:journal", err));
}

/** Вызов дешёвой модели для разбора. */
async function generateForGate(system: string, user: string, apiKeys: string[]): Promise<string | null> {
  const model = (await getSetting("aiModelGate"))?.trim() || GATE_MODEL;
  const startedAt = Date.now();
  const r = await generateWithFallback(
    apiKeys,
    model,
    (m) =>
      JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          thinkingConfig: thinkingConfigFor(m),
          maxOutputTokens: 200,
          responseMimeType: "application/json",
        },
      }),
    GATE_TIMEOUT_MS
  );
  if ("error" in r) {
    void logAiCall({ endpoint: "relevance-gate", ms: Date.now() - startedAt, ok: false });
    return null;
  }
  void logAiCall({ endpoint: "relevance-gate", model: r.model, usage: r.usage, ms: Date.now() - startedAt, ok: true });
  return r.text;
}

/**
 * true — идти дальше обычным путём (ответ по делу); false — шлюз всё решил сам
 * (промолчал, задал уточняющий вопрос или отдал человеку), aiReply должен выйти.
 */
export async function passesRelevanceGate(
  contact: Contact,
  text: string,
  attachments: Attachment[],
  hasRescuedImages: boolean,
  language: ClientLanguage
): Promise<boolean> {
  if ((await getSetting("replyGateEnabled")) === "false") return true;
  // Чат на сайте — посетитель сам открыл окно школы: курьеров и знакомых там нет, а молчание хуже шума.
  if (contact.channel === "WEB") return true;
  if (hasRescuedImages || attachments.some((a) => a.kind === "image")) return true;
  if (await isEstablished(contact)) return true;

  const apiKeys = await resolveGeminiKeys();
  let body = text.trim();
  const audio = attachments.find((a) => a.kind === "audio");
  if (!body && audio) {
    // Таджикскую речь дешёвые модели понимают плохо: если aiModelGateStt не задана, берётся модель голоса (aiModelVoice / pro).
    const stt = (await getSetting("aiModelGateStt"))?.trim() || undefined;
    body = (await voiceToText(audio.url, stt)) ?? "";
    if (!body) {
      // Голос не расшифровался: гадать нельзя ни в одну сторону.
      if (contact.channel !== "WHATSAPP") return true; // Instagram: как раньше — голос уходит модели целиком
      const v: RelevanceVerdict = { cls: "unclear", source: "fallback", reason: "голосовое не удалось расшифровать" };
      await journal(contact, "[голосовое]", v, "attention");
      await markAttention(contact, "voice_unreadable");
      return false;
    }
  }
  const hasMedia = attachments.length > 0;
  // Файл без подписи (PDF, видео): не гадаем и не переспрашиваем «что вас интересует» — дальше решает обычный путь.
  if (!body && hasMedia) return true;

  const recentRows = await prisma.message.findMany({
    where: { contactId: contact.id, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { direction: true, text: true },
  });
  // Последнее входящее — это и есть разбираемый текст: в контекст его не дублируем.
  const recent = recentRows
    .reverse()
    .filter((m) => m.text)
    .map((m) => ({ direction: m.direction as "IN" | "OUT", text: m.text as string }));
  if (recent.length && recent[recent.length - 1].direction === "IN" && recent[recent.length - 1].text === text) recent.pop();

  const verdict = await classifyRelevance(
    body,
    recent,
    { generate: (system, user) => generateForGate(system, user, apiKeys) },
    hasMedia
  );

  if (verdict.source === "fallback") {
    // Не смогли разобрать (модель легла). WhatsApp: повторим позже, потом к человеку.
    // Instagram и сайт повторов не имеют — отвечаем как раньше, лучше шум, чем потерянная покупательница.
    logWarn("relevanceGate:fallback", `${contact.id}: ${verdict.reason}`);
    if (contact.channel === "WHATSAPP") throw new RelevanceRetry("relevance gate unavailable");
    return true;
  }

  const clarifiedBefore = await prisma.replyGate.count({ where: { contactId: contact.id, action: "clarify" } });
  let action = decideAction(verdict, { clarifiedBefore });
  // «Нужен человек» есть только в списке WhatsApp. Instagram: после одного вопроса отвечаем как обычно,
  // молча пропадать хуже.
  if (action === "attention" && contact.channel !== "WHATSAPP") action = "reply";

  if (action === "clarify") {
    // Сначала отправка, потом запись в журнал: упавшая отправка не должна считаться заданным вопросом.
    const reply = clarifyText(language);
    const mid = await sendToContact(contact, reply);
    await recordOutgoingMessage(contact.id, reply, mid);
  }
  await journal(contact, body, verdict, action);

  if (action === "reply") return true;
  if (action === "attention") await markAttention(contact, "unclear_message");
  return false;
}

/** Список «нужен человек»: в WhatsApp это строка очереди со статусом attention. */
async function markAttention(contact: Contact, reason: string): Promise<void> {
  const turn = currentWhatsAppTurn();
  if (!turn) return;
  await prisma.whatsAppInbox
    .update({ where: { id: turn.inboxId }, data: { status: "attention", attentionReason: reason } })
    .catch((err) => logError("relevanceGate:attention", err));
}
