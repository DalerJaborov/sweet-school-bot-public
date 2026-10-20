import { generateWithFallback, thinkingConfigFor } from "../gemini.js";
import { getSetting, logError } from "../db.js";
import { fetchAttachment, buildMediaPart } from "./media.js";
import { resolveGeminiKeys } from "./geminiKeys.js";
import { logAiCall } from "./aiLog.js";

/**
 * РАСШИФРОВКА ГОЛОСОВОГО В ТЕКСТ — отдельно от ответа клиенту.
 *
 * ЗАЧЕМ. Ширин часто отвечает клиенткам голосом прямо из приложения Instagram.
 * Для бота такое сообщение до 22.08.2026 было пустым: в историю переписки ложилась
 * запись без текста, а обучение манере (см. styleLearning) её просто не видело —
 * учиться было не на чем. Между тем именно голосовые ответы хозяйки — самый
 * живой образец её речи: там нет редактуры, там настоящий душанбинский разговор.
 *
 * Заодно чинится вторая беда: история диалога для модели была дырявой. Клиентка
 * спрашивает, Ширин отвечает голосом, клиентка продолжает — а бот видит вопрос,
 * пустоту и продолжение, и отвечает невпопад, потому что середину разговора ему
 * не показали.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ЧАСТЬ ai.ts. Там модель слушает голосовое КЛИЕНТА
 * и сразу пишет ответ — одним вызовом, чтобы разбор и ответ не разъехались по
 * смыслу. Здесь другая задача: ответ уже дан живым человеком, нужен только текст.
 */

/** Голосовые Ширин короткие; минуты хватает с запасом даже на медленном канале. */
const BUDGET_MS = 60_000;

const INSTRUCTION =
  "Это голосовое сообщение. Запиши его текстом дословно, ничего не добавляя и не пересказывая. " +
  "Речь таджикская (душанбинский разговорный), может быть с русскими словами — так и записывай, " +
  "как сказано. Не переводи. Ответь ТОЛЬКО текстом сказанного, без пояснений и кавычек. " +
  "Если речи нет или разобрать нельзя — ответь ровно: НЕТ_РЕЧИ";

/** Модель не разобрала — обычный исход (тишина, шум, гудки), а не поломка. */
const NOTHING = "НЕТ_РЕЧИ";

/**
 * Расшифровывает голосовое по ссылке. null — не получилось: ключей нет, файл не
 * скачался, модель не ответила или речи в записи не оказалось.
 *
 * Ошибку наружу не бросаем НАМЕРЕННО: расшифровка чужого голосового — приятное
 * дополнение, и падение здесь не должно ронять обработку вебхука, ради которой
 * всё и затевалось.
 */
export async function voiceToText(url: string): Promise<string | null> {
  try {
    const apiKeys = await resolveGeminiKeys();
    if (apiKeys.length === 0) return null;

    const downloaded = await fetchAttachment(url).catch((err) => {
      logError("voiceToText:fetchAttachment", err);
      return null;
    });
    if (!downloaded) return null;
    const part = await buildMediaPart(downloaded.buffer, downloaded.mimeType, apiKeys[0]);
    if (!part) return null;

    // Голос требует модели посильнее: дешёвые flash таджикскую речь на слух почти
    // не понимают (та же причина, по которой у голосовых клиента своя модель).
    const model = (await getSetting("aiModelVoice"))?.trim() || "gemini-3.1-pro-preview";
    const startedAt = Date.now();
    const result = await generateWithFallback(
      apiKeys,
      model,
      (used) =>
        JSON.stringify({
          contents: [{ role: "user", parts: [part, { text: INSTRUCTION }] }],
          // 24.08.2026: было `...thinkingConfigFor(used)` — разворачивало
          // thinkingLevel/thinkingBudget ПРЯМО в generationConfig, а Gemini
          // принимает их только вложенными под ключом thinkingConfig (см. как
          // это верно сделано в ai.ts). Из-за этого Gemini отвечал 400 Invalid
          // JSON payload... Unknown name "thinkingLevel" НА КАЖДОМ вызове —
          // расшифровка голосовых хозяйки не работала вообще ни разу, только
          // выглядело как обычный сбой ("голосовое не расшифровано").
          generationConfig: { thinkingConfig: thinkingConfigFor(used), maxOutputTokens: 800 },
        }),
      BUDGET_MS
    );
    if ("error" in result || !result.text) {
      void logAiCall({ endpoint: "voice-to-text", ms: Date.now() - startedAt, ok: false });
      return null;
    }
    void logAiCall({ endpoint: "voice-to-text", model: result.model, usage: result.usage, ms: Date.now() - startedAt, ok: true });

    const text = result.text.trim();
    if (!text || text.includes(NOTHING)) return null;
    return text;
  } catch (err) {
    logError("voiceToText", err);
    return null;
  }
}
