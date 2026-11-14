import { prisma, logError } from "../db.js";
import { conversationLanguage, languageSignal, type ClientLanguage } from "./clientLanguage.js";

/** Сколько последних написанных сообщений клиента смотреть. */
const HISTORY = 10;

/**
 * ЯЗЫК КОНТАКТА — ЕДИНСТВЕННАЯ ДВЕРЬ для всех шаблонов и ответов бота.
 *
 * Цепочка (08.11.2026):
 *  1) явный сигнал в текущем сообщении («Салом, сколько стоит» — русский,
 *     «Салом хуб хастед» — таджикский);
 *  2) прошлые написанные сообщения клиента, свежие первыми (голосовое, фото,
 *     одно «Салом» языка не показывают). Нажатия кнопок воронки не в счёт:
 *     это текст владельца, а не клиента;
 *  3) язык, выбранный на сайте (preferredLanguage);
 *  4) русский — ОЦЕНКА: следствие правила «одно Салом не значит таджикский»,
 *     отдельного решения владельца нет.
 *
 * Сбой базы — не падаем: идём дальше по цепочке.
 */
export async function contactLanguage(contactId: string, currentText = ""): Promise<ClientLanguage> {
  const own = languageSignal(currentText);
  if (own) return own;
  try {
    const rows = await prisma.message.findMany({
      where: { contactId, direction: "IN", text: { not: null }, payload: null },
      orderBy: { createdAt: "desc" },
      take: HISTORY,
      select: { text: true },
    });
    const fromHistory = conversationLanguage((rows ?? []).map((r) => r.text));
    if (fromHistory) return fromHistory;
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { preferredLanguage: true } });
    const preferred = contact?.preferredLanguage;
    if (preferred === "ru" || preferred === "tg" || preferred === "en") return preferred;
  } catch (err) {
    logError("language:contact", err);
  }
  return "ru";
}
