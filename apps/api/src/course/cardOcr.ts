import { getSetting, logError, logInfo } from "../db.js";
import { generateWithFallback } from "../gemini.js";
import { resolveGeminiKeys } from "../ai/geminiKeys.js";

/**
 * РАСПОЗНАВАНИЕ КАРТОЧКИ РЕЦЕПТА.
 *
 * В канале школы рецепт не написан текстом — он нарисован на картинке:
 * «ДАРСИ 3 / ТВОРОЖНЫЙ ПИРОГ» и ингредиенты по компонентам (хамир, крем…)
 * на таджикском. Ученице картинка и так покажется (recipePhotos), но
 * помощнику в чате нужен ТЕКСТ: по картинке он на вопрос «сколько муки»
 * не ответит. Поэтому при импорте карточку один раз читает Gemini и кладёт
 * результат в Lesson.recipeText как markdown — на таджикском, как есть,
 * без перевода: перевод делает i18n при показе.
 *
 * Три предохранителя:
 *  • ТОЛЬКО В ПУСТОЕ ПОЛЕ. Написанный владельцем рецепт распознавание не
 *    трогает никогда.
 *  • ПОМЕТКА. Lesson.recipeSource = "card-ocr" — владелец знает, что текст
 *    машинный, и проверит цифры: модель может прочитать «250» как «260».
 *  • НЕ РОНЯЕТ ИМПОРТ. Нет ключа, кончилась квота, картинка не разобралась —
 *    урок импортируется без текста, а причина — в лог.
 */

export type RecipeCardItem = {
  ingredient: string;
  amount: string | null;
  unit: string | null;
  note: string | null;
  /** Эмодзи ингредиента («🥚», «🧈»…) — как на оригинальных карточках Telegram.
   *  Просит модель сама (см. INSTRUCTION): угадывать его на клиенте по строке
   *  названия — ненадёжно, особенно для таджикского текста. */
  emoji: string | null;
};
export type RecipeCardComponent = { name: string; items: RecipeCardItem[] };
export type RecipeCard = { title: string; components: RecipeCardComponent[]; language: string };

/** Одна карточка — один вызов; больше минуты ждать незачем, это импорт. */
const BUDGET_MS = 60_000;
/** Больше — не карточка, а фотография кухни; Gemini inline-лимит 20 МБ. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const INSTRUCTION = [
  "На картинке — карточка рецепта кондитерской школы (обычно на таджикском языке).",
  "Перепиши ВСЁ, что на ней написано, в JSON по схеме, ничего не переводя и не додумывая.",
  "title — название десерта без слов «Дарси N»/«Урок N» и без номера.",
  "components — части рецепта в порядке на карточке (хамир, крем, ганаш…); если частей нет, одна с пустым name.",
  "items — ингредиенты: ingredient — как написано; amount — число как написано («250», «1/2», «2-3»); unit — единица как написано (г, мл, дона, қошуқ…); note — уточнение в скобках, если есть. Чего нет — null.",
  "emoji — одно эмодзи, которое лучше всего изображает этот ингредиент (яйцо — 🥚, масло/маргарин — 🧈, шоколад — 🍫, мука — 🌾, сахар — 🍬, молоко — 🥛 и так далее по смыслу названия). Не можешь подобрать — null.",
  "language — код языка текста: tg, ru или en.",
  "Числа переписывай особенно внимательно: они важнее всего.",
].join("\n");

// propertyOrdering — задаёт Gemini порядок заполнения полей ЯВНО. Без него
// модель иногда меняет порядок и вместе с этим протаскивает свои внутренние
// рассуждения в значение поля («unit»: «г Serge\n\nWait, no control tokens
// like \n in JSON!...») — известный сбой structured output у Gemini, когда
// схема ограничивает форму, но не порядок и не содержимое строк (issue
// google-gemini/cookbook#354). Найдено 06.09.2026: испортило 23 из 31
// карточки рецептов на проде, почищено вручную — это на будущее.
const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    language: { type: "STRING" },
    components: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                ingredient: { type: "STRING" },
                amount: { type: "STRING", nullable: true },
                unit: { type: "STRING", nullable: true },
                note: { type: "STRING", nullable: true },
                emoji: { type: "STRING", nullable: true },
              },
              required: ["ingredient"],
              propertyOrdering: ["ingredient", "amount", "unit", "note", "emoji"],
            },
          },
        },
        required: ["name", "items"],
        propertyOrdering: ["name", "items"],
      },
    },
  },
  required: ["title", "components", "language"],
  propertyOrdering: ["title", "language", "components"],
};

/**
 * ЗАЩИТА ОТ УТЕЧКИ РАССУЖДЕНИЙ В ПОЛЕ (второй, независимый слой — на случай,
 * если propertyOrdering выше не спасёт). Настоящие значения полей карточки —
 * короткие: число, «г», «дона», «Сорбон ё Кен». Утечка рассуждений выглядит
 * иначе: либо очень длинная строка, либо содержит связный латинский текст
 * («Wait, no control tokens», «Jeffrey null», «standard json output»), либо
 * посторонние символы вне кириллицы/таджикских букв/латиницы естественных
 * брендов. Тот же принцип, что уже есть в transcribe.ts (NO_SPEECH,
 * MAX_CHARS_PER_SEC) — там для расшифровки, здесь для карточки.
 */
const MAX_FIELD_LEN = 40;
const LATIN_RUN = /[A-Za-z]{3,}/;
/** Настоящие иноязычные слова, которые легитимно встречаются в карточках
 *  (бренды сливок/шоколада) — не считаем их подозрительными сами по себе. */
const KNOWN_LATIN_WORDS = /^(Ken|Petmol|Sorbon|Callebaut|Oreo|Nutella|Milka|Twix|Snickers)$/i;

function looksCorrupted(v: string | null): boolean {
  if (!v) return false;
  if (v.length > MAX_FIELD_LEN) return true;
  if (/\n/.test(v)) return true;
  const words = v.match(LATIN_RUN) ?? [];
  return words.some((w) => !KNOWN_LATIN_WORDS.test(w));
}

function str(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * Разбор ответа модели. Терпимый к мелочам (обёртка ```json, числа вместо
 * строк, пропущенные null), строгий к сути: без единого ингредиента карточки
 * нет — лучше пустое поле, чем «рецепт» из одного заголовка.
 */
export function parseRecipeCard(text: string): RecipeCard | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const components: RecipeCardComponent[] = [];
  for (const c of Array.isArray(o.components) ? o.components : []) {
    if (!c || typeof c !== "object") continue;
    const co = c as Record<string, unknown>;
    // Дубли ингредиента внутри одного компонента (по имени+количеству+
    // единице) — тот же паттерн, что учетверил сахар в «Вупи пай»: две
    // фотографии одной и той же строки карточки распознались отдельно и
    // склеились без дедупа. Строка со свежими данными остаётся первой.
    const seen = new Set<string>();
    const items: RecipeCardItem[] = [];
    for (const it of Array.isArray(co.items) ? co.items : []) {
      if (!it || typeof it !== "object") continue;
      const io = it as Record<string, unknown>;
      let ingredient = str(io.ingredient);
      if (!ingredient) continue;
      // Утечка рассуждений режется до чистой части, а не выбрасывает всю
      // строку — настоящие ингредиент/число почти всегда стоят ПЕРЕД мусором
      // (ровно то, что вручную чинили 06.09.2026 у 6 уроков).
      if (looksCorrupted(ingredient)) ingredient = ingredient.slice(0, MAX_FIELD_LEN).trim();
      let amount = str(io.amount);
      let unit = str(io.unit);
      let note = str(io.note);
      if (looksCorrupted(unit)) unit = null;
      if (looksCorrupted(note)) note = null;
      if (looksCorrupted(amount)) amount = null;
      const sig = `${ingredient}|${amount}|${unit}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      items.push({ ingredient, amount, unit, note, emoji: str(io.emoji) });
    }
    if (items.length) components.push({ name: str(co.name) ?? "", items });
  }
  if (!components.length) return null;
  return { title: str(o.title) ?? "", components, language: (str(o.language) ?? "tg").toLowerCase() };
}

/** Markdown для Lesson.recipeText: компоненты жирным, ингредиенты списком. */
export function recipeCardToMarkdown(card: RecipeCard): string {
  const blocks = card.components.map((c) => {
    const lines = c.items.map((it) => {
      const qty = [it.amount, it.unit].filter(Boolean).join(" ");
      const note = it.note ? ` (${it.note})` : "";
      return `- ${it.ingredient}${qty ? ` — ${qty}` : ""}${note}`;
    });
    return (c.name ? `**${c.name}**\n` : "") + lines.join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * Слить несколько распознанных карточек одного урока (хамир на одном фото,
 * крем на другом — обычное дело) в одну структуру для Lesson.recipeData: так
 * же, как recipeCardToMarkdown склеивает их текст через "\n\n". Название и
 * язык — от первой карточки, у которой они есть; компоненты — по порядку
 * карточек. Пустой список или карточки без единого компонента — null: пустой
 * recipeData хуже, чем его отсутствие (фронт тогда честно покажет recipeText).
 */
export function mergeRecipeCards(cards: RecipeCard[]): RecipeCard | null {
  const components = cards.flatMap((c) => c.components);
  if (!components.length) return null;
  const title = cards.find((c) => c.title)?.title ?? "";
  const language = cards.find((c) => c.language)?.language ?? "tg";
  return { title, components, language };
}

/**
 * Прочитать карточку. null — не вышло (и почему — в логе); бросать нельзя:
 * вызывающий — импорт, ему падать из-за картинки не положено.
 */
export async function ocrRecipeCard(image: Buffer, mimeType: string): Promise<RecipeCard | null> {
  if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) return null;
  const keys = await resolveGeminiKeys();
  if (keys.length === 0) return null;
  const model = (await getSetting("aiModel"))?.trim() || "gemini-3.6-flash";

  const build = () =>
    JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: mimeType, data: image.toString("base64") } }, { text: INSTRUCTION }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        maxOutputTokens: 4096,
        // Без thinkingConfig — резервная модель на нём отвечает 400 (см. i18n.ts).
      },
    });

  try {
    const res = await generateWithFallback(keys, model, build, BUDGET_MS);
    if ("error" in res || !res.text) {
      logError("course:cardOcr", new Error("error" in res ? res.error : "пустой ответ"));
      return null;
    }
    const card = parseRecipeCard(res.text);
    if (!card) logError("course:cardOcr", new Error(`ответ не разобран: ${res.text.slice(0, 200)}`));
    else logInfo("course:cardOcr", `карточка «${card.title}»: компонентов ${card.components.length}`);
    return card;
  } catch (err) {
    logError("course:cardOcr", err);
    return null;
  }
}
