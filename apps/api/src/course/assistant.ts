import { prisma, getSetting, logError } from "../db.js";
import { geminiGenerateUrl, geminiProxyHeaders, thinkingConfigFor, FALLBACK_MODELS, isRetryableStatus, RETRY_DELAYS_MS, sleep } from "../gemini.js";
import { resolveGeminiKeys } from "../ai/geminiKeys.js";
import type { ClientLanguage } from "../ai/clientLanguage.js";

/**
 * ПОМОЩНИК ПО РЕЦЕПТАМ — отвечает на вопросы ученицы по материалам курса.
 *
 * ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ ИИ-КОНСУЛЬТАНТА В ДИРЕКТЕ. Тот продаёт и разговаривает
 * свободно. Этот — только про содержание уроков, и ему запрещено выдумывать:
 * если ответа нет в рецептах, он обязан сказать это прямо, а вопрос уйдёт
 * Ширин. Выдуманная замена продукта или неверная температура портят десерт,
 * а вместе с ним — доверие к школе; молчание в этом месте дешевле догадки.
 *
 * ПОЧЕМУ ЭТО БЕЗОПАСНО ПРИ ВЫДУМКАХ МОДЕЛИ. Ответ строится ТОЛЬКО из текста
 * рецептов, который написала сама владелица, и модели явно велено вернуть
 * условное слово, если материала не хватает. Никакого «общего кулинарного
 * знания» она подмешивать не должна — об этом сказано в правилах ниже прямым
 * текстом и продублировано форматом ответа.
 */

/** Условный ответ «в материалах этого нет». Модель обязана вернуть ровно его. */
const UNKNOWN = "НЕ_ЗНАЮ";

const TIMEOUT_MS = 25_000;

/** Сколько рецептов подмешивать. Курс это десятки уроков; целиком они дадут
 *  огромный запрос, который дорог и медленен на каждый вопрос. */
const MAX_LESSONS = 40;

const RULES: Record<ClientLanguage, string> = {
  ru: "Отвечай по-русски, тепло и коротко, как учительница ученице.",
  tg: "Ҷавоб ба забони тоҷикӣ бидеҳ, гарм ва кӯтоҳ, мисли устод ба шогирд.",
  en: "Answer in English, warmly and briefly.",
};

export type AssistantAnswer = { text: string } | { text: null; reason: "no_material" | "unavailable" };

/**
 * Собирает знания курса: название, описание, рецепты и РАСШИФРОВКИ уроков.
 *
 * Урок, который ученица открыла прямо сейчас, идёт ПЕРВЫМ и целиком — вопрос
 * почти всегда про него («а сколько тут держать?»), и ответ должен приходить
 * из него, а не из похожего места соседнего урока. Остальные уроки идут следом
 * и в сокращённом виде: они нужны на случай «а в прошлый раз вы говорили…».
 *
 * Пусто — ни рецептов, ни расшифровок ещё нет, и помощнику отвечать нечем.
 */
async function courseKnowledge(courseId: string, currentLessonId?: string | null): Promise<string | null> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: {
      modules: {
        orderBy: { order: "asc" },
        include: { lessons: { where: { deletedAt: null }, orderBy: { order: "asc" } } },
      },
    },
  });
  if (!course) return null;

  const parts: string[] = [`КУРС: ${course.title}`];
  if (course.description) parts.push(course.description);

  const all = course.modules.flatMap((m) => m.lessons);
  // Открытый урок вперёд остальных.
  const ordered = currentLessonId
    ? [...all.filter((l) => l.id === currentLessonId), ...all.filter((l) => l.id !== currentLessonId)]
    : all;

  let used = 0;
  for (const lesson of ordered) {
    if (used >= MAX_LESSONS) break;
    const recipe = lesson.recipeText?.trim() ?? "";
    const said = lesson.transcript?.trim() ?? "";
    // Урок без рецепта и без расшифровки помощнику бесполезен: одно название
    // ничего не объясняет, а место в запросе занимает.
    if (!recipe && !said) continue;

    const isCurrent = lesson.id === currentLessonId;
    const header = isCurrent
      ? `\n--- УРОК, КОТОРЫЙ УЧЕНИЦА СМОТРИТ СЕЙЧАС: ${lesson.title} ---`
      : `\n--- УРОК: ${lesson.title} ---`;
    const block = [header];
    if (recipe) block.push(`РЕЦЕПТ:\n${recipe}`);
    if (said) {
      // Открытый урок берём целиком, прочие — началом: полные расшифровки всех
      // уроков не поместятся в запрос и сделают его дорогим и медленным.
      block.push(`ЧТО ГОВОРИТ ПРЕПОДАВАТЕЛЬ В ВИДЕО:\n${isCurrent ? said : said.slice(0, 2500)}`);
    }
    parts.push(block.join("\n"));
    used += 1;
  }
  return used > 0 ? parts.join("\n") : null;
}

function buildPrompt(knowledge: string, question: string, language: ClientLanguage): string {
  return [
    "Ты помощник Ширин на её авторском кондитерском курсе. Отвечаешь ученице, которая уже купила курс,",
    "на вопросы по материалам этого курса.",
    "",
    "ЖЁСТКИЕ ПРАВИЛА:",
    `1. Отвечай ТОЛЬКО тем, что есть в материалах ниже. Своих кулинарных знаний не добавляй.`,
    "   Если урок помечен «СМОТРИТ СЕЙЧАС» — ищи ответ сначала в нём: вопрос почти всегда про него.",
    `2. Если ответа в материалах нет или ты не уверена — верни ровно одно слово: ${UNKNOWN}`,
    "   Ничего не додумывай: неверная замена продукта или температура испортят десерт.",
    "3. Не выдумывай граммовки, время и температуры, которых нет в тексте.",
    "4. Не обсуждай цены, оплату, доступ к курсу и другие курсы — на это отвечают люди.",
    `5. ${RULES[language]}`,
    "6. Без приветствий и подписи — только ответ по делу, 1-4 предложения.",
    "",
    "=== МАТЕРИАЛЫ КУРСА ===",
    knowledge,
    "=== КОНЕЦ МАТЕРИАЛОВ ===",
    "",
    `ВОПРОС УЧЕНИЦЫ: ${question}`,
  ].join("\n");
}

/**
 * Спрашивает модель. Возвращает null-текст, если материала не хватило или
 * модель недоступна — вызывающий код в обоих случаях зовёт Ширин, но по
 * разным причинам, поэтому они различимы.
 */
export async function answerFromRecipes(
  courseId: string,
  question: string,
  language: ClientLanguage,
  currentLessonId?: string | null
): Promise<AssistantAnswer> {
  const knowledge = await courseKnowledge(courseId, currentLessonId);
  if (!knowledge) return { text: null, reason: "no_material" };

  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) return { text: null, reason: "unavailable" };

  const model = (await getSetting("aiModel"))?.trim() || "gemini-3.7-flash";
  const prompt = buildPrompt(knowledge, question, language);

  const raw = await generate(model, prompt, apiKeys);
  if (raw === null) return { text: null, reason: "unavailable" };

  const answer = raw.trim();
  // Модель может вернуть условное слово внутри фразы («НЕ_ЗНАЮ, спросите
  // учительницу») — этого достаточно, чтобы не показывать ответ ученице.
  if (!answer || answer.includes(UNKNOWN)) return { text: null, reason: "no_material" };
  return { text: answer };
}

/** Вызов Gemini с теми же повторами и запасными моделями, что и остальной бот. */
async function generate(model: string, prompt: string, apiKeys: string[]): Promise<string | null> {
  const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  for (const candidate of models) {
    for (const apiKey of apiKeys) {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          const res = await fetch(geminiGenerateUrl(candidate), {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                // Помощник должен быть предсказуемым: один и тот же вопрос —
                // один и тот же ответ, без фантазии.
                temperature: 0.2,
                maxOutputTokens: 400,
                ...thinkingConfigFor(candidate),
              },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });

          if (isRetryableStatus(res.status) && attempt < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt]);
            continue;
          }
          if (!res.ok) break; // ключ или модель не подходят — пробуем следующие

          const data = (await res.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          if (text.trim()) return text;
          break;
        } catch (err) {
          if (attempt >= RETRY_DELAYS_MS.length) {
            logError("courseAssistant:generate", err);
            break;
          }
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }
  }
  return null;
}
