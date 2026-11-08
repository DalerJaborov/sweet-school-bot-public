import { prisma, getSetting, logError } from "../db.js";
import { reactToInstagramMessage } from "../instagram.js";
import { sendWhatsAppReaction } from "../whatsapp/transport.js";
import { assertAutomationAllowed } from "../messaging/automation.js";
import type { Contact } from "@prisma/client";

/**
 * РЕАКЦИИ КАК У ЖИВОГО ЧЕЛОВЕКА (решение владельца 08.11.2026).
 *
 * «Спасибо» от клиентки не требует текста в ответ: человек ставит сердечко и идёт дальше.
 * Бот делал наоборот — писал ещё одно сообщение. Теперь на чистую благодарность
 * ставится реакция (Instagram — sender_action=react по официальной документации Meta,
 * WhatsApp — через мост), а текст не отправляется.
 *
 * Рубильник: настройка reactionsEnabled = "false" возвращает старое поведение.
 */

/** Только благодарность и ничего больше (иначе это уже вопрос, и на него отвечаем текстом). */
const PURE_THANKS =
  /^[\s\p{P}\p{S}\p{M}]*(спасибо|благодарю|благодарствую|рахмат|раҳмат|ташаккур|мерси|спс|thanks|thank\s+you)(\s+(большое|огромное|вам|вас|калон|зиёд|бисёр))*(\s+(апачон|апаҷон|апа|ширин|хохарчон|хоҳарҷон))?[\s\p{P}\p{S}\p{M}]*$/iu;

export function isPureThanks(text: string): boolean {
  const t = (text ?? "").trim();
  return t.length > 0 && t.length <= 60 && PURE_THANKS.test(t);
}

/** Тёплые реакции для женского аккаунта кондитерской: без «деловых» жестов вроде 👍 и 🤝. */
export const REACTIONS = ["❤️", "🥰", "🌸", "💚", "🤍", "😊"] as const;

export function pickReaction(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return REACTIONS[h % REACTIONS.length];
}

/**
 * true — реакция поставлена, текстом отвечать не надо. Любая ошибка (окно 24 часа
 * закрыто, мост недоступен) → false, и бот отвечает обычным текстом: клиентка не
 * должна остаться без ответа из-за украшения.
 */
export async function reactInsteadOfReply(contact: Contact, text: string): Promise<boolean> {
  if (!isPureThanks(text)) return false;
  if ((await getSetting("reactionsEnabled")) === "false") return false;
  try {
    await assertAutomationAllowed();
    if (contact.channel === "WHATSAPP") {
      await sendWhatsAppReaction(contact, pickReaction(contact.id + text));
      return true;
    }
    if (contact.channel === "INSTAGRAM") {
      const last = await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "IN", mid: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { mid: true },
      });
      if (!last?.mid) return false;
      await reactToInstagramMessage(contact.igUserId, last.mid, pickReaction(last.mid));
      return true;
    }
    return false;
  } catch (err) {
    logError("reactions:react", err);
    return false;
  }
}
