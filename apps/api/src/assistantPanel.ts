import { Router } from "express";
import { z } from "zod";
import { prisma, getSetting, logError } from "./db.js";
import { autoCatch } from "./asyncRoute.js";
import { generateWithFallback, thinkingConfigFor } from "./gemini.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { isBudgetExceeded, recordAiCall } from "./ai/dailyBudget.js";
import { logAiCall } from "./ai/aiLog.js";
import { buildRevenue, buildFunnel, buildStudent, daysParam } from "./metrics.js";
import { searchStudents } from "./search.js";
import { listNotOpened } from "./notOpened.js";
import { todaySnapshot } from "./today.js";
import { answerFromRecipes } from "./course/assistant.js";

/**
 * «СПРОСИТЬ ПОМОЩНИЦУ» («Утро Ширин» §21, волна 3C).
 *
 *   POST /admin/assistant/ask { question, history? } → { answer, sources, draft? }
 *
 * ЧТО ЭТО. Поле на главной: «сколько продали на этой неделе?», «кто не
 * открыл урок?», «напиши Мадине ответ про сливки». Модель здесь — не
 * оракул, а ДИСПЕТЧЕР над закрытым набором безопасных инструментов
 * (`TOOLS` ниже): она выбирает, какой вызвать и с какими аргументами, а
 * цифры берёт только из того, что инструмент вернул. Каждый вызов уходит
 * в ответ как «источник», и панель показывает его под ответом — Ширин
 * видит, откуда взялось число, а не верит на слово.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ — по замыслу, а не по настройке:
 *   - не отправляет ничего никому: черновик ответа ученице ложится в
 *     карточку с «Скопировать» / «Открыть вопросы», кнопка «Отправить» —
 *     в inbox вопросов, у человека;
 *   - не ходит в базу произвольными запросами: инструменты — те же функции,
 *     что кормят «Деньги», «Сегодня» и поиск (metrics.ts, today.ts,
 *     search.ts, notOpened.ts); нового SQL здесь нет.
 *
 * ПРЕДЕЛЫ. Суточный бюджет — общий с ботом (isBudgetExceeded/recordAiCall,
 * один ход на вопрос, сколько бы инструментов ни вызвала модель), 20
 * вопросов в час на панель, 30 с на всё, не больше 3 кругов инструментов.
 * Если модель молчит, ключей нет или бюджет кончился — два самых частых
 * вопроса (деньги за неделю, кто не открыл) считаются БЕЗ ИИ, чтобы поле
 * никогда не было бесполезным.
 */
export const assistantRouter = autoCatch(Router());

/** Счёт бюджета для панели — один на всех, кто в неё заходит. */
export const PANEL_CONTACT_ID = "owner-panel";
const HOURLY_CAP = 20;
const TOTAL_BUDGET_MS = 30_000;
export const MAX_TOOL_ROUNDS = 3;
const HISTORY_LIMIT = 6;
const ENDPOINT = "panel-assistant";

// ---------- инструменты ----------

export type ToolResult = {
  /** Одна строка для списка источников и для модели. */
  summary: string;
  /** Структура для компактной таблицы в панели; модель видит её же. */
  data: unknown;
  /** Только у draftReply: текст черновика и кому он. */
  draft?: { text: string; forContactId: string };
};

export type Tool = {
  name: string;
  description: string;
  parameters: { type: "OBJECT"; properties: Record<string, { type: string; description: string }>; required?: string[] };
  run(args: Record<string, unknown>): Promise<ToolResult>;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function handleOf(c: { username: string | null; name?: string | null; igUserId: string }): string {
  return c.username ? `@${c.username}` : (c.name ?? `ID ···${c.igUserId.slice(-6)}`);
}

/**
 * ЗАКРЫТЫЙ НАБОР ИНСТРУМЕНТОВ. Порядок — по частоте вопросов. Чтобы добавить
 * новый, достаточно одной записи здесь: объявление для модели и исполнение
 * лежат рядом, и панель узнаёт о нём из GET /admin/assistant/tools.
 */
export const TOOLS: Tool[] = [
  {
    name: "money",
    description: "Выручка за последние N дней: итог, число оплат, по курсу и по каналу (Instagram, сайт, вручную). Для «на этой неделе» — days=7, «за месяц» — 30.",
    parameters: { type: "OBJECT", properties: { days: { type: "INTEGER", description: "Сколько последних дней считать, 1–365; по умолчанию 7" } } },
    async run(args) {
      const days = daysParam(args.days, 7);
      const r = await buildRevenue(days);
      const byCourse = r.byCourse.map((b) => `${b.title} — ${b.sum} с. (${b.count})`).join(", ") || "нет оплат";
      return {
        summary: `за ${days} дн.: ${r.total} с., ${r.count} оплат; ${byCourse}`,
        data: { days, total: r.total, count: r.count, byCourse: r.byCourse, byChannel: r.byChannel, timeToPay: r.timeToPay },
      };
    },
  },
  {
    name: "funnel",
    description: "Воронка за N дней: написали → прошли воронку → прислали чек → оплатили → открыли урок → досмотрели → сертификат, с процентами.",
    parameters: { type: "OBJECT", properties: { days: { type: "INTEGER", description: "Период в днях; по умолчанию 30" } } },
    async run(args) {
      const days = daysParam(args.days, 30);
      const f = await buildFunnel(days);
      return {
        summary: `за ${days} дн.: ${f.steps.map((s) => `${s.title} ${s.count}`).join(" → ")}`,
        data: { days, steps: f.steps },
      };
    },
  },
  {
    name: "notOpened",
    description: "Кто оплатил за последние 30 дней, но ещё не открыл ни одного урока (не вошёл): список с ником и сколько дней прошло.",
    parameters: { type: "OBJECT", properties: {} },
    async run() {
      const rows = await listNotOpened(10);
      return {
        summary: rows.length === 0 ? "все, кто оплатил, уже открыли уроки" : `${rows.length}: ${rows.map((r) => `${r.handle} (${r.daysAgo ?? "?"} дн.)`).join(", ")}`,
        data: rows,
      };
    },
  },
  {
    name: "student",
    description: "Найти ученицу по нику, имени или телефону и показать карточку: курсы, процент прохождения, когда открыла, вопросы без ответа, устройства.",
    parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "Ник, имя или телефон" } }, required: ["query"] },
    async run(args) {
      const query = str(args.query);
      if (query.length < 2) return { summary: "запрос слишком короткий", data: null };
      const hits = await searchStudents(query);
      if (hits.length === 0) return { summary: `по «${query}» никого не нашлось`, data: null };
      const card = await buildStudent(hits[0].id);
      if (!card) return { summary: `по «${query}» никого не нашлось`, data: null };
      const courses = card.courses.map((c) => ({
        title: c.title,
        amount: c.amount,
        boughtAt: c.boughtAt,
        firstOpenedAt: c.firstOpenedAt,
        percent: c.percent,
        lessonsDone: c.lessonsDone,
        lessonsTotal: c.lessonsTotal,
        finishedAt: c.finishedAt,
        certificate: c.certificate ? `№${c.certificate.number}` : null,
      }));
      const progress = courses.map((c) => `${c.title} ${c.percent}%`).join(", ") || "курсов нет";
      return {
        summary: `${card.contact.handle}${card.contact.studentName ? ` (${card.contact.studentName})` : ""}: ${progress}; вопросов без ответа ${card.unansweredQuestions}`,
        data: {
          contactId: card.contact.id,
          handle: card.contact.handle,
          name: card.contact.studentName ?? card.contact.name,
          channel: card.contact.channel,
          paidAt: card.contact.paidAt,
          unansweredQuestions: card.unansweredQuestions,
          devices: card.devices.length,
          courses,
          otherMatches: hits.slice(1).map((h) => h.handle),
        },
      };
    },
  },
  {
    name: "unansweredQuestions",
    description: "Вопросы учениц из приложения, на которые Ширин ещё не ответила: кто, что спросила, к какому уроку.",
    parameters: { type: "OBJECT", properties: {} },
    async run() {
      const rows = await prisma.courseChatMessage.findMany({
        where: { fromStudent: true, readByOwnerAt: null },
        orderBy: { createdAt: "asc" },
        take: 10,
        include: {
          lesson: { select: { title: true } },
          purchase: { include: { contact: { select: { id: true, username: true, name: true, igUserId: true } } } },
        },
      });
      const data = rows.map((q) => ({
        questionId: q.id,
        contactId: q.purchase.contact.id,
        handle: handleOf(q.purchase.contact),
        lesson: q.lesson?.title ?? null,
        text: q.text ?? "",
        createdAt: q.createdAt.toISOString(),
      }));
      return {
        summary: data.length === 0 ? "вопросов без ответа нет" : `${data.length}: ${data.map((d) => `${d.handle} — «${d.text.slice(0, 60)}»`).join("; ")}`,
        data,
      };
    },
  },
  {
    name: "draftReply",
    description:
      "Составить ЧЕРНОВИК ответа ученице по рецептам её курса (ничего не отправляет). studentQuery — ник или имя, topic — о чём вопрос (например «можно ли заменить сливки»).",
    parameters: {
      type: "OBJECT",
      properties: {
        studentQuery: { type: "STRING", description: "Ник или имя ученицы" },
        topic: { type: "STRING", description: "Суть вопроса, на который нужен ответ" },
      },
      required: ["studentQuery", "topic"],
    },
    async run(args) {
      const query = str(args.studentQuery);
      const topic = str(args.topic);
      if (query.length < 2 || !topic) return { summary: "нужны ник ученицы и суть вопроса", data: null };
      const hits = await searchStudents(query);
      if (hits.length === 0) return { summary: `по «${query}» никого не нашлось`, data: null };
      const student = hits[0];
      const purchase = await prisma.purchase.findFirst({
        where: { contactId: student.id, revokedAt: null, courseId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { courseId: true, courseRef: { select: { title: true } } },
      });
      if (!purchase?.courseId) return { summary: `у ${student.handle} нет действующего курса на платформе`, data: { handle: student.handle } };
      const answer = await answerFromRecipes(purchase.courseId, topic, "ru");
      if (answer.text === null) {
        const why = answer.reason === "no_material" ? "в рецептах курса ответа нет — лучше ответить самой" : "помощник по рецептам сейчас недоступен";
        return { summary: `${student.handle}: ${why}`, data: { handle: student.handle, course: purchase.courseRef?.title ?? null, reason: answer.reason } };
      }
      const source = `по рецептам курса «${purchase.courseRef?.title ?? purchase.courseId}»`;
      return {
        summary: `черновик для ${student.handle} ${source}`,
        data: { handle: student.handle, course: purchase.courseRef?.title ?? null, source, text: answer.text },
        draft: { text: answer.text, forContactId: student.id },
      };
    },
  },
  {
    name: "today",
    description: "Утренняя сводка: деньги за вчера и за неделю, оплаты, чеки в ожидании, вопросы без ответа, кто не открыл, расход Gemini.",
    parameters: { type: "OBJECT", properties: {} },
    async run() {
      const t = await todaySnapshot();
      const data = {
        moneyYesterday: t.money.yesterday,
        moneyWeek: t.money.week,
        moneyPrevWeek: t.money.prevWeek,
        salesYesterday: t.money.salesYesterday,
        salesWeek: t.money.salesWeek,
        pendingReceipts: t.pendingReceipts,
        unansweredQuestions: t.unansweredQuestions,
        notOpened: t.notOpened,
        gemini: t.system.gemini,
      };
      return {
        summary: `вчера ${data.moneyYesterday} с. (${data.salesYesterday} оплат), неделя ${data.moneyWeek} с.; чеков ${data.pendingReceipts}, вопросов ${data.unansweredQuestions}, не открыли ${data.notOpened}`,
        data,
      };
    },
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** Что видит модель — и что показывает GET /admin/assistant/tools владельцу. */
export function toolDeclarations(): { name: string; description: string; parameters: Tool["parameters"] }[] {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

// ---------- ответ ----------

export type Source = { tool: string; args: Record<string, unknown>; summary: string; data: unknown };
export type AskResponse = {
  answer: string;
  sources: Source[];
  draft?: { text: string; forContactId: string };
  /** true — ответ посчитан без модели (нет ключей, бюджет, сбой). */
  fallback?: boolean;
};

const askSchema = z.object({
  question: z.string().trim().min(2).max(500),
  history: z.array(z.object({ role: z.enum(["user", "model"]), text: z.string().max(2000) })).max(HISTORY_LIMIT).optional(),
});
export type AskInput = z.infer<typeof askSchema>;

function systemInstruction(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "Ты помощница Ширин — владелицы кондитерской онлайн-школы — внутри её панели управления.",
    `Сегодня ${today}. Деньги — в сомони (с.).`,
    "ПРАВИЛА:",
    "1. Любые цифры, имена и факты бери ТОЛЬКО из результатов инструментов. Не помнишь — вызови инструмент. Не выдумывай.",
    "2. Отвечай по-русски, коротко: 1–4 предложения или короткий список. Без приветствий.",
    "3. Ты ничего не отправляешь ученицам: черновик (draftReply) Ширин скопирует и отправит сама — так и говори.",
    "4. Если инструмента для вопроса нет (например, просят изменить цену или удалить что-то) — скажи, что это делается руками в панели, и не притворяйся, что сделала.",
    "5. Если инструмент вернул пустой результат — так и скажи, без домыслов.",
  ].join("\n");
}

type Part =
  | { text?: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
type Content = { role: "user" | "model"; parts: Part[] };

/** Ключи и модель — как у остального бота: из Настроек. */
async function geminiConfig(): Promise<{ keys: string[]; model: string }> {
  return { keys: await resolveGeminiKeys(), model: (await getSetting("aiModel"))?.trim() || "gemini-3.6-flash" };
}

/**
 * Само общение с моделью: круг = один вызов; если модель попросила
 * инструменты — исполняем, кладём ответы в разговор и идём на следующий
 * круг. После MAX_TOOL_ROUNDS кругов один финальный вызов уже без
 * инструментов — чтобы модель не могла крутиться бесконечно.
 */
async function converse(input: AskInput, cfg: { keys: string[]; model: string }, deadline: number): Promise<{ answer: string | null; sources: Source[]; draft?: AskResponse["draft"] }> {
  const contents: Content[] = [
    ...(input.history ?? []).slice(-HISTORY_LIMIT).map<Content>((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: input.question }] },
  ];
  const sources: Source[] = [];
  let draft: AskResponse["draft"];
  const declarations = toolDeclarations();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const left = deadline - Date.now();
    if (left < 1500) return { answer: null, sources, draft };
    const withTools = round < MAX_TOOL_ROUNDS;
    const startedAt = Date.now();
    const result = await generateWithFallback(
      cfg.keys,
      cfg.model,
      (m) =>
        JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction() }] },
          contents,
          ...(withTools ? { tools: [{ functionDeclarations: declarations }] } : { toolConfig: { functionCallingConfig: { mode: "NONE" } } }),
          generationConfig: { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: thinkingConfigFor(m) },
        }),
      left
    );
    if ("error" in result) {
      logError("assistantPanel", result.error);
      void logAiCall({ endpoint: ENDPOINT, ms: Date.now() - startedAt, ok: false });
      return { answer: null, sources, draft };
    }
    void logAiCall({ endpoint: ENDPOINT, model: result.model, usage: result.usage, ms: Date.now() - startedAt, ok: true });

    const calls = withTools ? (result.functionCalls ?? []) : [];
    if (calls.length === 0) return { answer: result.text, sources, draft };

    // Модель попросила инструменты: неизвестные имена молча пропускаем —
    // модель могла выдумать название, а исполнять только то, что в TOOLS.
    const responses: Part[] = [];
    const modelParts: Part[] = [];
    for (const call of calls) {
      const tool = toolByName.get(call.name);
      if (!tool) continue;
      const args = call.args ?? {};
      // Подпись рассуждения возвращаем как есть: без неё Gemini 3 отвечает 400.
      modelParts.push({ functionCall: { name: call.name, args }, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
      let out: ToolResult;
      try {
        out = await tool.run(args);
      } catch (err) {
        logError(`assistantPanel:${tool.name}`, err);
        out = { summary: "инструмент не ответил", data: null };
      }
      sources.push({ tool: tool.name, args, summary: out.summary, data: out.data });
      if (out.draft) draft = out.draft;
      responses.push({ functionResponse: { name: tool.name, response: { summary: out.summary, data: out.data ?? null } } });
    }
    if (responses.length === 0) return { answer: result.text, sources, draft };
    contents.push({ role: "model", parts: modelParts }, { role: "user", parts: responses });
  }
  return { answer: null, sources, draft };
}

// ---------- ответ без ИИ ----------

/** Два самых частых вопроса угадываем по словам — без модели. */
export function fallbackIntent(question: string): "money" | "notOpened" | null {
  const q = question.toLowerCase().replace(/ё/g, "е");
  if (/не\s*откры|не\s*зашл|не\s*вошл|не\s*начал|не\s*смотр/.test(q)) return "notOpened";
  if (/продал|выручк|деньг|заработ|оплат|сколько.*(с\.|сомони)/.test(q)) return "money";
  return null;
}

/** Собрать понятный ответ по результату одного инструмента — когда модели нет. */
export function composeFallback(intent: "money" | "notOpened", out: ToolResult, days: number): string {
  if (intent === "notOpened") {
    const rows = out.data as { handle: string; daysAgo: number | null }[];
    if (rows.length === 0) return "Все, кто оплатил за последние 30 дней, уже открыли уроки.";
    return `Оплатили, но не открыли уроки — ${rows.length}: ${rows.map((r) => `${r.handle} (${r.daysAgo ?? "?"} дн. назад)`).join(", ")}. Ссылка у них в переписке — нужно просто напомнить.`;
  }
  const d = out.data as { total: number; count: number; byCourse: { title: string; sum: number; count: number }[] };
  if (d.count === 0) return `За последние ${days} дн. оплат не было.`;
  const byCourse = d.byCourse.map((b) => `${b.title} — ${b.sum} с. (${b.count})`).join(", ");
  return `За последние ${days} дн. продали на ${d.total} с., ${d.count} оплат: ${byCourse}.`;
}

/** Ответ без ИИ: null — вопрос не из двух знакомых. */
export async function answerWithoutAi(question: string): Promise<AskResponse | null> {
  const intent = fallbackIntent(question);
  if (!intent) return null;
  const days = /месяц|30/.test(question) ? 30 : 7;
  const args = intent === "money" ? { days } : {};
  const out = await toolByName.get(intent)!.run(args);
  return { answer: composeFallback(intent, out, days), sources: [{ tool: intent, args, summary: out.summary, data: out.data }], fallback: true };
}

/** Когда модель не ответила, но инструменты уже посчитала — отдаём их сводки, чтобы работа не пропала. */
function answerFromSources(sources: Source[]): string {
  return `Помощница не смогла сформулировать ответ, но вот что посчитала: ${sources.map((s) => `${s.tool}: ${s.summary}`).join("; ")}.`;
}

// ---------- ограничение в час ----------

const askTimes: number[] = [];
function overHourlyCap(now = Date.now()): boolean {
  while (askTimes.length > 0 && now - askTimes[0] > 3_600_000) askTimes.shift();
  if (askTimes.length >= HOURLY_CAP) return true;
  askTimes.push(now);
  return false;
}
/** Для тестов. */
export function resetHourlyCap(): void {
  askTimes.length = 0;
}

// ---------- сборка ----------

export type AskOutcome = { status: 200 | 429 | 503; body: AskResponse | { error: string; fallback?: AskResponse } };

export async function ask(input: AskInput): Promise<AskOutcome> {
  const fallback = () => answerWithoutAi(input.question);
  if (overHourlyCap()) {
    return { status: 429, body: { error: `Больше ${HOURLY_CAP} вопросов в час — подождите немного`, fallback: (await fallback()) ?? undefined } };
  }
  if (await isBudgetExceeded(PANEL_CONTACT_ID)) {
    return { status: 429, body: { error: "Суточный лимит ИИ исчерпан — помощница отвечает только на простые вопросы", fallback: (await fallback()) ?? undefined } };
  }
  const cfg = await geminiConfig();
  if (cfg.keys.length === 0) {
    const plain = await fallback();
    return plain ? { status: 200, body: plain } : { status: 503, body: { error: "Ключ Gemini не задан в Настройках" } };
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let result: Awaited<ReturnType<typeof converse>>;
  try {
    result = await converse(input, cfg, deadline);
  } catch (err) {
    logError("assistantPanel:converse", err);
    result = { answer: null, sources: [] };
  }
  // Один ход бюджета на вопрос — сколько бы кругов ни было.
  await recordAiCall(PANEL_CONTACT_ID);

  if (result.answer) {
    return { status: 200, body: { answer: result.answer, sources: result.sources, ...(result.draft ? { draft: result.draft } : {}) } };
  }
  if (result.sources.length > 0) {
    return { status: 200, body: { answer: answerFromSources(result.sources), sources: result.sources, ...(result.draft ? { draft: result.draft } : {}), fallback: true } };
  }
  const plain = await fallback();
  return plain ? { status: 200, body: plain } : { status: 503, body: { error: "Помощница сейчас не отвечает — попробуйте ещё раз через минуту" } };
}

assistantRouter.get("/admin/assistant/tools", (_req, res) => {
  res.json({ tools: toolDeclarations() });
});

assistantRouter.post("/admin/assistant/ask", async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Напишите вопрос — от 2 до 500 символов" });
    return;
  }
  const out = await ask(parsed.data);
  res.status(out.status).json(out.body);
});
