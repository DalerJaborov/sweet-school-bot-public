import { prisma, logError, getSetting } from "../db.js";
import { clientUsesTajikLetters, humanizeBotText } from "../ai/humanText.js";

/** Сколько последних сообщений клиента смотреть, чтобы понять, пишет ли он особыми буквами. */
const STYLE_SAMPLE = 10;

/**
 * ТЕКСТ БОТА ПО-ЧЕЛОВЕЧЕСКИ — единственная дверь (ai/humanText.ts): без длинных
 * тире, без «апачон» и дежурных хвостов; особые таджикские буквы остаются, только
 * если клиент сам ими пишет. Вызывается в messaging/send.ts::sendToContact для всего, что не написала
 * Ширин; снаружи — там, где текст уходит мимо sendToContact (ответ на комментарий)
 * или где в историю нужно записать ровно то, что ушло (ai.ts). Идемпотентна.
 * Голосовой путь (ai/voiceReply.ts) сюда не заходит: озвучке нужны особые буквы.
 */
/**
 * ОСОБЫЕ БУКВЫ — ПО РЕШЕНИЮ ВЛАДЕЛЬЦА (11.11.2026): «разговорный душанбинский, без
 * книжных ҷ қ ӯ ғ ҳ ӣ». Раньше буквы оставались, если клиент сам ими пишет, — и
 * разбор переписок показал «книжный» бот. Теперь по умолчанию (`tajikLettersMode`
 * пусто или "plain") текст всегда без них; "mirror" — прежнее «как пишет клиент».
 */
export const TAJIK_LETTERS_SETTING = "tajikLettersMode";

export async function humanizeForContact(contactId: string, text: string, extraClientTexts: string[] = []): Promise<string> {
  let mirror = false;
  try {
    mirror = (await getSetting(TAJIK_LETTERS_SETTING))?.trim() === "mirror";
  } catch {
    mirror = false;
  }
  if (!mirror) return humanizeBotText(text, { keepTajikLetters: false });
  let recent: string[] = [];
  try {
    const rows = await prisma.message.findMany({
      // Нажатие кнопки воронки — это текст владельца, а не клиента: в стиль не считаем.
      where: { contactId, direction: "IN", text: { not: null }, payload: null },
      orderBy: { createdAt: "desc" },
      take: STYLE_SAMPLE,
      select: { text: true },
    });
    recent = (rows ?? []).map((r) => r.text ?? "");
  } catch (err) {
    // Не узнали стиль — пишем без особых букв: так пишет большинство клиенток.
    logError("send:clientStyle", err);
  }
  return humanizeBotText(text, { keepTajikLetters: clientUsesTajikLetters([...recent, ...extraClientTexts]) });
}
