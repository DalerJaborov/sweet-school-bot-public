import crypto from "node:crypto";
import { prisma, getSetting, logError } from "../db.js";
import { generateWithFallback } from "../gemini.js";
import { resolveGeminiKeys } from "../ai/geminiKeys.js";

/**
 * ПЕРЕВОД СОДЕРЖИМОГО КУРСА НА ЯЗЫК УЧЕНИЦЫ.
 *
 * Владелец захотел (03.09.2026), чтобы перед входом человек выбирал русский
 * или таджикский и дальше видел платформу на своём языке. Надписи интерфейса
 * переведены заранее и лежат в коде — они не меняются. А вот названия уроков,
 * описание курса и рецепты Ширин пишет по-русски и правит когда захочет:
 * держать их перевод руками значит однажды забыть и показать половину экрана
 * на чужом языке.
 *
 * Поэтому содержимое переводит Gemini. Три правила, каждое из которых важнее
 * качества перевода:
 *
 *  1. ОДИН РАЗ. Перевод кладётся в Translation по хешу исходного текста. Список
 *     уроков открывают десятки раз в день — платить за это каждый раз незачем.
 *  2. НИКОГДА НЕ ЛОМАЕТ ЭКРАН. Gemini недоступен, кончилась квота, вышло
 *     время — возвращаем исходный русский текст. Русский текст таджикоязычной
 *     ученице неприятен; пустой экран вместо урока — беда.
 *  3. НЕ ЗАДЕРЖИВАЕТ. Общий потолок на всю пачку небольшой: список уроков
 *     должен открыться сразу, даже если перевод не поспел. Не поспел — в
 *     следующий раз он уже будет в кеше.
 */

export type CourseLanguage = "ru" | "tg";

export function isCourseLanguage(value: unknown): value is CourseLanguage {
  return value === "ru" || value === "tg";
}

/** Потолок на всю пачку. Дальше отдаём что есть — экран важнее перевода. */
const BUDGET_MS = 12_000;
/** Больше — уже не «пачка», а простыня: режем на части, чтобы модель не
 *  потеряла соответствие строк. */
const CHUNK = 25;

function hashOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Перевести набор строк. Возвращает массив ТОЙ ЖЕ длины и в том же порядке:
 * вызывающий подставляет перевод по индексу, и рассинхрон здесь означал бы
 * название одного урока под другим.
 */
export async function translateMany(texts: string[], lang: CourseLanguage): Promise<string[]> {
  const result = [...texts];
  if (lang === "ru") return result;

  // Индексы, которые реально надо переводить: пустые строки и повторы не в счёт.
  const wanted = new Map<string, number[]>();
  texts.forEach((text, i) => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const list = wanted.get(trimmed);
    if (list) list.push(i);
    else wanted.set(trimmed, [i]);
  });
  if (wanted.size === 0) return result;

  const unique = [...wanted.keys()];
  const hashes = unique.map(hashOf);

  const cached = await prisma.translation.findMany({ where: { lang, hash: { in: hashes } } });
  const byHash = new Map(cached.map((row) => [row.hash, row.text]));

  const missing: string[] = [];
  unique.forEach((text, i) => {
    const hit = byHash.get(hashes[i]);
    if (hit) for (const idx of wanted.get(text)!) result[idx] = hit;
    else missing.push(text);
  });

  if (missing.length === 0) return result;

  const deadline = Date.now() + BUDGET_MS;
  for (let offset = 0; offset < missing.length; offset += CHUNK) {
    if (Date.now() >= deadline) break;
    const chunk = missing.slice(offset, offset + CHUNK);
    const translated = await askGemini(chunk, lang, deadline - Date.now());
    if (!translated) break;
    for (let i = 0; i < chunk.length; i++) {
      const value = translated[i]?.trim();
      if (!value) continue;
      for (const idx of wanted.get(chunk[i]) ?? []) result[idx] = value;
      // Кладём в кеш по одному: одна кривая строка не должна отменить остальные.
      await prisma.translation
        .create({ data: { hash: hashOf(chunk[i]), lang, text: value } })
        .catch(() => undefined); // гонка двух учениц на одном тексте — не ошибка
    }
  }

  return result;
}

/** Одна строка — частый случай (описание курса), незачем городить массив. */
export async function translateOne(text: string | null, lang: CourseLanguage): Promise<string | null> {
  if (!text) return text;
  const [out] = await translateMany([text], lang);
  return out ?? text;
}

const SYSTEM = `Ты переводчик кондитерской школы в Душанбе. Переводишь с русского на таджикский.
Правила:
- Перевод должен звучать так, как говорят в Душанбе, а не как в учебнике.
- Названия десертов, брендов и торговых марок оставляй как есть (Наполеон, Медовик, Rafaello).
- Числа, единицы измерения, граммы, градусы и время не меняй.
- Сохраняй переносы строк и значки исходного текста.
- Ничего не добавляй от себя и ничего не поясняй.
Ответ — СТРОГО массив JSON из строк той же длины и в том же порядке, что вход. Без разметки, без пояснений.`;

/** null — перевод не получился; вызывающий оставит русский текст. */
async function askGemini(texts: string[], lang: CourseLanguage, budgetMs: number): Promise<string[] | null> {
  if (budgetMs < 1500) return null;
  const keys = await resolveGeminiKeys();
  if (keys.length === 0) return null;
  const model = (await getSetting("aiModel"))?.trim() || "gemini-3.6-flash";

  const build = (_m: string) =>
    JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(texts) }] }],
      generationConfig: {
        temperature: 0.2,
        // Просим сам API вернуть массив строк: разбирать свободный текст
        // модели значит однажды получить "Вот перевод:" первой строкой.
        responseMimeType: "application/json",
        responseSchema: { type: "ARRAY", items: { type: "STRING" } },
        maxOutputTokens: 4096,
        // Без thinkingConfig: перевод — не рассуждение, а резервная модель
        // gemini-3-flash-preview на «thinkingLevel» отвечает 400 (живой случай
        // 03.09.2026: перевод падал, ученица видела русский).
      },
    });

  const res = await generateWithFallback(keys, model, build, Math.min(budgetMs, BUDGET_MS));
  if ("error" in res || !res.text) {
    const why = "error" in res ? res.error : "пустой ответ";
    logError("course:i18n", new Error(`${lang}, строк ${texts.length}: ${why}`));
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(res.text);
    if (!Array.isArray(parsed)) return null;
    // Длина не совпала — соответствие строк потеряно, а подставить перевод не
    // к той строке хуже, чем не перевести вовсе.
    if (parsed.length !== texts.length) return null;
    return parsed.map((v) => (typeof v === "string" ? v : ""));
  } catch {
    return null;
  }
}
