import express, { Router, type Request, type Response, type NextFunction } from "express";
import nodeCrypto from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "./env.js";
import { prisma, getSetting, logError } from "./db.js";
import { sendText } from "./instagram.js";
import { upload, handleUpload } from "./upload.js";
import { decideReceipt } from "./receiptDecision.js";
import { isSettingKey, readSettingsMasked, writeSetting, writeSettings } from "./services/settingsService.js";
import { styleImportJob, archiveTestimonialsImportJob } from "./services/importService.js";
import { parseStepButtonsJson, parseStringArray } from "./json.js";
import { courseAdminRouter } from "./course/adminRoutes.js";
import { importRouter } from "./course/importRoutes.js";
import { textsRouter } from "./textsRoutes.js";
import { todayRouter, resetTodayCache, guessCourse } from "./today.js";
import { metricsRouter } from "./metrics.js";
import { searchRouter } from "./search.js";
import { assistantRouter } from "./assistantPanel.js";
import { getPrices } from "./services/priceService.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { geminiGenerateUrl, geminiProxyHeaders } from "./gemini.js";
import { revokeAccess, restoreAccess } from "./groupAccess.js";
import { offsetMs, localDayStart } from "./dailyReport.js";
import { countNotOpened } from "./notOpened.js";

export const adminRouter = Router();

// ---------- вход ----------

adminRouter.post("/admin/login", (req, res) => {
  const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || parsed.data.password !== env.adminPassword) {
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }
  const token = jwt.sign({ role: "admin" }, env.jwtSecret, { expiresIn: "30d" });
  res.json({ token });
});

/**
 * ТОКЕН ДОЛЖЕН БЫТЬ ИМЕННО АДМИНСКИМ, а не просто верно подписанным.
 *
 * Разбор безопасности 03.09.2026 нашёл здесь дыру во всю стену: проверялась
 * ОДНА подпись, а тем же секретом подписывались ссылки на курс, которые
 * ученица видит прямо в адресной строке. То есть любая покупательница могла
 * взять свой токен и открыть им панель целиком — базу клиенток, переписки,
 * чеки, ключи — и перезаписать настройки.
 *
 * Теперь спрашиваем содержимое: роль «admin» выдаётся только за пароль
 * владельца (см. /admin/login выше). Токены учениц с 03.09.2026 подписываются
 * и вовсе другим секретом (course/tokenSecret.ts) — это второй рубеж на
 * случай, если в новом обработчике однажды забудут проверку роли.
 */
function isAdminToken(token: string): boolean {
  try {
    const claims = jwt.verify(token, env.jwtSecret) as { role?: unknown };
    return claims?.role === "admin";
  } catch {
    return false;
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (isAdminToken(token)) next();
  else res.status(401).json({ error: "Нужен вход" });
}

adminRouter.use("/admin", (req, res, next) => {
  if (req.path === "/login") return next();
  requireAuth(req, res, next);
});

/**
 * Приём одной настройки обычной HTML-формой.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПУТЬ. Маркеры Meta показываются один раз во всплывающем окне
 * на developers.facebook.com, и когда владелец работает через удалённый рабочий
 * стол, буфер обмена между машинами не переносится — «скопировать и вставить»
 * физически не выходит. Отправить значение со страницы Meta нашим `fetch`
 * нельзя: её CSP запрещает запросы на чужие хосты. А вот отправку ФОРМЫ CSP
 * (connect-src) не касается — поэтому здесь urlencoded-форма, а не JSON.
 *
 * Защита та же, что у остального админ-API: тот же JWT, просто в поле формы,
 * а не в заголовке (форма не умеет слать заголовки).
 */
adminRouter.post("/admin-form/setting", express.urlencoded({ extended: false }), (req, res) => {
  const parsed = z
    .object({ auth: z.string().min(1), key: z.string().min(1), value: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).send("Ожидаются поля auth, key, value");
    return;
  }
  if (!isAdminToken(parsed.data.auth)) {
    res.status(401).send("Нужен вход");
    return;
  }
  const key = parsed.data.key;
  if (!isSettingKey(key)) {
    res.status(400).send("Неизвестная настройка");
    return;
  }
  void writeSetting(key, parsed.data.value).then(
    () => res.send("Сохранено. Можно закрыть эту страницу."),
    () => res.status(500).send("Не удалось сохранить")
  );
});

// ---------- настройки (список ключей и маскирование — services/settingsService.ts) ----------

adminRouter.get("/admin/settings", async (_req, res) => {
  res.json(await readSettingsMasked());
});

/**
 * ЖИВАЯ ПРОВЕРКА МОДЕЛИ — один настоящий вызов Google и его ответ дословно.
 *
 * Тот же приём, что заведён в основной CRM 22.08.2026, и по той же причине. За
 * август Google закрыл две модели без предупреждения: бот в эти дни отвечал хуже
 * или молчал, а понять почему было нельзя — за «не отвечает» одинаково прячутся
 * 404 (модель закрыта), 429 (кончилась квота), 401 (ключ мёртв) и 503 (перегрузка).
 * Четыре беды с четырьмя разными лечениями. 22.08 у школы, например, один ключ
 * упёрся в 429, а второй отвечал 401 — то есть ИИ не работал вовсе, и по внешним
 * признакам это выглядело просто как «бот поглупел».
 *
 * НИКАКОЙ СВОЕЙ ИНТЕРПРЕТАЦИИ: на экран уходит текст Google. Он сам говорит, что
 * делать («no longer available to new users» прямо называет замену), и не устареет
 * вместе с нашим словарём ошибок.
 *
 * Ходим ТЕМ ЖЕ путём, что бот, — через прокси и теми же ключами по очереди: у VPS
 * геоблок, и прямой вызов провалился бы там, где бот работает.
 */
/**
 * РАЗДЕЛ «КАЧЕСТВО» — где бот ответил плохо, и как надо было.
 *
 * ПОЧЕМУ БЕЗ КНОПКИ «ПЛОХОЙ ОТВЕТ». Такую кнопку пришлось бы нажимать Ширин, а она
 * читает переписки в самом Instagram и в панель ради этого не заходит — кнопка
 * висела бы неиспользованной. Между тем разметка уже происходит сама: КАЖДЫЙ раз,
 * когда она отвечает следом за ботом, это и значит «бот сказал не то, вот как надо».
 * Данные есть, их нужно только показать.
 *
 * Отбираем тройки «вопрос клиента → ответ бота → ответ Ширин», где её ответ пришёл
 * вскоре после ботовского. Дальше это и список проблем, и заготовка для проверки
 * промта: правку видно по тому, уменьшается ли поток таких случаев.
 */
const TAKEOVER_WINDOW_MS = 15 * 60_000;

/**
 * ВОРОНКА: где люди отваливаются.
 *
 * До этого разговор про «что чинить в первую очередь» шёл по впечатлениям от
 * прочитанных переписок — то есть по тем диалогам, которые попались на глаза.
 * Цифры показывают другое: не «бывает плохо», а «из ста написавших до чека дошло
 * восемь, и половина исчезла сразу после цены».
 *
 * Шаги считаются по СЛЕДАМ, а не по разметке: разметку пришлось бы кто-то ставить,
 * а следы остаются сами. «Спросил цену» — в сообщениях клиента есть слово про
 * деньги; «получил реквизиты» — мы отправили номер; дальше чек и покупка.
 */
const PRICE_ASKED = /нарх|цен[аыу]|чанд|сколько|почём|почем|сумай|пул/iu;
const REQUISITES_SENT = /905\s?355\s?355|алиф|душанбе\s*сити|фарангис/iu;

/**
 * ВОРОНКА ПРОВАЛОВ ПОСЛЕ РЕКВИЗИТОВ: на каком именно сообщении отваливаются.
 *
 * Считать «сколько получили реквизиты и не заплатили» уже умели (см. gotRequisites/
 * droppedAfter.requisites выше). Мало знать «сколько» — владелец читал переписки
 * одну за одной, чтобы нащупать, ЧТО именно отталкивает. Здесь то же самое числом:
 * группируем таких людей по последнему сообщению бота, чтобы одинаковые шаблонные
 * концовки схлопывались в один бакет, а не размазывались по десяткам «почти
 * одинаковых» строк из-за разной цены/номера в каждой.
 */
function normalizeLastBotMessage(text: string): string {
  const stripped = text
    // Цифры — это цена или номер реквизитов, они меняются от диалога к диалогу,
    // а сам шаблон текста нет. Без этого шага бакеты не схлопывались бы вовсе.
    .replace(/\d[\d\s-]*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (stripped || "[без текста]").slice(0, 100);
}

adminRouter.get("/admin/funnel-stats", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const contacts = await prisma.contact.findMany({
    where: { createdAt: { gte: since }, personal: false },
    select: {
      id: true,
      createdAt: true,
      messages: { select: { direction: true, text: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      purchases: { select: { id: true, revokedAt: true } },
      receiptChecks: { select: { kind: true } },
    },
  });

  let wrote = 0;
  let askedPrice = 0;
  let gotRequisites = 0;
  let sentReceipt = 0;
  let bought = 0;
  /** Последним в переписке говорили МЫ, и человек не ответил — вот где он ушёл. */
  const droppedAfter = { greeting: 0, price: 0, requisites: 0, other: 0 };
  /**
   * Получили реквизиты и не заплатили — независимо от того, кто написал
   * последним (droppedAfter.requisites уже требует, чтобы последним говорили
   * МЫ; здесь шире: человек мог что-то спросить после реквизитов и тоже
   * пропасть). Бакет — последнее сообщение БОТА в этой переписке.
   */
  let requisitesNoPay = 0;
  const requisitesNoPayBuckets = new Map<string, number>();

  for (const c of contacts) {
    const incoming = c.messages.filter((m) => m.direction === "IN");
    if (incoming.length === 0) continue;
    wrote++;

    const clientText = incoming.map((m) => m.text ?? "").join(" ");
    const ourText = c.messages.filter((m) => m.direction === "OUT").map((m) => m.text ?? "").join(" ");

    const asked = PRICE_ASKED.test(clientText);
    const gotReq = REQUISITES_SENT.test(ourText);
    const hasReceipt = c.receiptChecks.length > 0;
    const hasPurchase = c.purchases.some((p) => !p.revokedAt);

    if (asked) askedPrice++;
    if (gotReq) gotRequisites++;
    if (hasReceipt) sentReceipt++;
    if (hasPurchase) bought++;

    // Ушёл ли человек: последнее слово осталось за нами и покупки нет.
    const last = c.messages[c.messages.length - 1];
    if (!hasPurchase && last && last.direction === "OUT") {
      if (gotReq) droppedAfter.requisites++;
      else if (asked) droppedAfter.price++;
      else if (c.messages.length <= 3) droppedAfter.greeting++;
      else droppedAfter.other++;
    }

    if (gotReq && !hasPurchase) {
      requisitesNoPay++;
      const outgoing = c.messages.filter((m) => m.direction === "OUT");
      const lastOut = outgoing[outgoing.length - 1];
      const bucket = normalizeLastBotMessage(lastOut?.text ?? "");
      requisitesNoPayBuckets.set(bucket, (requisitesNoPayBuckets.get(bucket) ?? 0) + 1);
    }
  }

  const requisitesDropoff = {
    total: requisitesNoPay,
    // Топ-30 достаточно: смысл в том, чтобы увидеть самые частые формулировки,
    // а не выгрузить длинный хвост с count=1.
    buckets: [...requisitesNoPayBuckets.entries()]
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30),
  };

  res.json({ days, wrote, askedPrice, gotRequisites, sentReceipt, bought, droppedAfter, requisitesDropoff });
});

adminRouter.get("/admin/quality", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  // "Показать ещё" — курсор по времени, не skip: список не строка таблицы, а
  // производные тройки сообщений, offset по номеру случая тут не применим.
  // Раньше страницы вообще не было — всегда одни и те же 50 последних случаев,
  // старые не увидеть никак.
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  // Берём с запасом: тройки складываются из соседних сообщений, и часть отсеется.
  const rows = await prisma.message.findMany({
    where: before ? { createdAt: { lt: before } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit * 12,
    select: { contactId: true, direction: true, text: true, byHuman: true, createdAt: true },
  });

  const cases: {
    contactId: string;
    clientText: string;
    botText: string;
    humanText: string;
    at: Date;
  }[] = [];

  // Идём от новых к старым: для каждого ответа Ширин ищем прямо перед ним ответ
  // бота, а перед ним — вопрос клиента. limit+1 — тот же приём "лишняя запись
  // = есть ещё", что и в paginate() ниже, только вручную (cases — не срез rows).
  for (let i = 0; i < rows.length && cases.length < limit + 1; i++) {
    const human = rows[i];
    if (human.direction !== "OUT" || !human.byHuman || !human.text) continue;

    const bot = rows.slice(i + 1).find((m) => m.contactId === human.contactId && m.direction === "OUT");
    if (!bot || bot.byHuman || !bot.text) continue;
    if (human.createdAt.getTime() - bot.createdAt.getTime() > TAKEOVER_WINDOW_MS) continue;

    const client = rows
      .slice(rows.indexOf(bot) + 1)
      .find((m) => m.contactId === human.contactId && m.direction === "IN" && m.text);

    cases.push({
      contactId: human.contactId,
      clientText: client?.text ?? "",
      botText: bot.text,
      humanText: human.text,
      at: human.createdAt,
    });
  }

  const { rows: pageCases, hasMore } = paginate(cases, limit);
  res.json({ cases: pageCases, hasMore, windowMinutes: TAKEOVER_WINDOW_MS / 60_000 });
});

adminRouter.post("/admin/gemini-test", async (req, res) => {
  const parsed = z
    .object({ model: z.string().min(3).max(80).regex(/^[a-z0-9][a-z0-9.-]*$/) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Имя модели — латиница, цифры, точка и дефис (например gemini-3.7-flash)" });
    return;
  }
  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) {
    res.status(400).json({ error: "Ключ Gemini не задан — сначала сохраните ключ" });
    return;
  }

  const started = Date.now();
  let last = { ok: false, status: null as number | null, detail: "нет ключей для проверки", ms: 0 };
  for (const apiKey of apiKeys) {
    const attemptStarted = Date.now();
    try {
      const response = await fetch(geminiGenerateUrl(parsed.data.model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ок" }] }] }),
        signal: AbortSignal.timeout(25_000),
      });
      const text = (await response.text()).replace(/\s+/g, " ").trim();
      last = {
        ok: response.ok,
        status: response.status,
        detail: response.ok ? "Модель отвечает" : text.slice(0, 300),
        ms: Date.now() - attemptStarted,
      };
      // 401/403 — беда КЛЮЧА, а не модели: следующий ключ может ответить, и тогда
      // вердикт по модели должен быть его. Прочие коды относятся к самой модели.
      if (response.ok || (response.status !== 401 && response.status !== 403)) break;
    } catch (err) {
      last = {
        ok: false,
        status: null,
        detail: err instanceof Error ? err.message : "неизвестный сбой",
        ms: Date.now() - attemptStarted,
      };
    }
  }
  res.json({ ...last, ms: Date.now() - started });
});

adminRouter.put("/admin/settings", async (req, res) => {
  const parsed = z.record(z.string(), z.string()).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается объект ключ→значение" });
    return;
  }
  await writeSettings(parsed.data);
  res.json({ ok: true });
});

/**
 * ПОДКЛЮЧИТЬ ВЕБХУК TELEGRAM С СЕКРЕТОМ.
 *
 * До 03.09.2026 адрес вебхука был открыт всему интернету: проверка секрета в
 * заголовке существовала в коде, но задать сам секрет было нечем, и она всегда
 * пропускала. Здесь секрет придумывает сервер и сразу передаёт его Telegram —
 * владельцу вводить нечего и негде ошибиться.
 *
 * Нажимать эту кнопку можно сколько угодно: каждый раз выпускается новый
 * секрет, а Telegram узнаёт о нём в том же запросе.
 */
adminRouter.post("/admin/telegram/setup", async (_req, res) => {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) {
    res.status(400).json({ error: "Сначала впишите токен бота в настройках" });
    return;
  }
  const base = (env.publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    res.status(400).json({ error: "Не задан публичный адрес — вебхуку некуда приходить" });
    return;
  }

  const secret = nodeCrypto.randomBytes(24).toString("hex");
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${base}/webhooks/telegram`,
        secret_token: secret,
        // chat_member нужен, чтобы узнавать о входе в закрытую группу;
        // без него доступ по ссылке перестанет отмечаться.
        allowed_updates: ["message", "callback_query", "chat_member"],
      }),
    });
    const data = (await resp.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      res.status(502).json({ error: `Telegram отказал: ${data.description ?? resp.status}` });
      return;
    }
  } catch (err) {
    logError("telegram:setup", err);
    res.status(502).json({ error: "Не получилось связаться с Telegram" });
    return;
  }

  // Записываем ПОСЛЕ успеха: иначе при отказе Telegram у нас остался бы секрет,
  // которого он не знает, и все вебхуки начали бы отвергаться.
  await writeSettings({ telegramWebhookSecret: secret });
  res.json({ ok: true });
});

// ---------- воронки ----------

const buttonSchema = z.object({
  title: z.string().min(1).max(20),
  targetOrder: z.number().int().min(0),
});

const stepSchema = z.object({
  order: z.number().int().min(0),
  delaySeconds: z.number().int().min(0).max(24 * 3600),
  // Пустой текст разрешён нарочно: шаг может быть ЧИСТЫМ вложением — фото меню
  // или видео без подписи, ровно как это было в ManyChat. Проверка «шаг не
  // пустой совсем» ниже, в saveFunnel: текст ИЛИ вложение должны быть.
  text: z.string().max(1000),
  buttons: z.array(buttonSchema).max(3).default([]),
  mediaUrl: z.string().url().nullable().optional(),
  mediaType: z.enum(["video", "image", "file"]).nullable().optional(),
  stopAfter: z.boolean().default(false),
});

const funnelSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  trigger: z.enum(["COMMENT", "DM"]),
  postUrl: z.string().nullable().optional(),
  mediaIds: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  anyComment: z.boolean().default(false),
  startTag: z.string().min(1).max(100).default("kurs_started"),
  repeatAfterDays: z.number().int().min(0).max(365).default(30),
  steps: z.array(stepSchema).max(50),
});

adminRouter.get("/admin/funnels", async (_req, res) => {
  const funnels = await prisma.funnel.findMany({
    include: { steps: { orderBy: { order: "asc" } }, _count: { select: { deliveries: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Безопасный разбор JSON-колонок: одна битая запись раньше роняла весь
  // список 500-й ошибкой (см. json.ts).
  res.json(
    funnels.map((f) => ({
      ...f,
      keywords: parseStringArray(f.keywords),
      mediaIds: parseStringArray(f.mediaIds),
      steps: f.steps.map((s) => ({ ...s, buttons: parseStepButtonsJson(s.buttons) })),
    }))
  );
});

/** Копия воронки со всеми шагами — быстрый старт для новой кампании: скопировал,
 *  поменял ролик и пару текстов, включил. Копия создаётся выключенной нарочно,
 *  чтобы случайно не запустить дубль поверх работающей. */
adminRouter.post("/admin/funnels/:id/duplicate", async (req, res) => {
  const source = await prisma.funnel.findUnique({
    where: { id: req.params.id },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!source) {
    res.status(404).json({ error: "Воронка не найдена" });
    return;
  }
  const copy = await prisma.funnel.create({
    data: {
      name: `${source.name} (копия)`.slice(0, 200),
      enabled: false,
      trigger: source.trigger,
      postUrl: source.postUrl,
      mediaIds: source.mediaIds,
      keywords: source.keywords,
      anyComment: source.anyComment,
      startTag: source.startTag,
      repeatAfterDays: source.repeatAfterDays,
      steps: {
        create: source.steps.map((s) => ({
          order: s.order,
          delaySeconds: s.delaySeconds,
          text: s.text,
          buttons: s.buttons,
          mediaUrl: s.mediaUrl,
          mediaType: s.mediaType,
          stopAfter: s.stopAfter,
        })),
      },
    },
  });
  res.json({ id: copy.id });
});

async function saveFunnel(id: string | null, body: unknown, res: Response): Promise<void> {
  const parsed = funnelSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные воронки", details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const orders = d.steps.map((s) => s.order);
  if (new Set(orders).size !== orders.length) {
    res.status(400).json({ error: "Номера шагов не должны повторяться" });
    return;
  }
  for (const step of d.steps) {
    // Шаг без текста и без вложения отправлять нечего — это опечатка, а не
    // задумка (в отличие от шага-картинки без подписи, который законен).
    if (!step.text.trim() && !step.mediaUrl) {
      res.status(400).json({ error: `Шаг №${step.order} пустой: нужен текст или вложение` });
      return;
    }
    for (const b of step.buttons) {
      if (!orders.includes(b.targetOrder)) {
        res.status(400).json({ error: `Кнопка «${b.title}» ведёт на несуществующий шаг №${b.targetOrder}` });
        return;
      }
    }
  }

  const funnelData = {
    name: d.name,
    enabled: d.enabled,
    trigger: d.trigger,
    postUrl: d.postUrl ?? null,
    mediaIds: JSON.stringify(d.mediaIds),
    keywords: JSON.stringify(d.keywords),
    anyComment: d.anyComment,
    startTag: d.startTag,
    repeatAfterDays: d.repeatAfterDays,
  };
  const stepsData = d.steps.map((s) => ({
    order: s.order,
    delaySeconds: s.delaySeconds,
    text: s.text,
    buttons: JSON.stringify(s.buttons),
    mediaUrl: s.mediaUrl ?? null,
    mediaType: s.mediaType ?? null,
    stopAfter: s.stopAfter,
  }));

  const funnel = await prisma.$transaction(async (tx) => {
    const saved = id
      ? await tx.funnel.update({ where: { id }, data: funnelData })
      : await tx.funnel.create({ data: funnelData });
    // Шаги пересохраняются целиком — кнопки ссылаются на order, а не на id, так безопасно.
    await tx.funnelStep.deleteMany({ where: { funnelId: saved.id } });
    for (const step of stepsData) {
      await tx.funnelStep.create({ data: { ...step, funnelId: saved.id } });
    }
    return saved;
  });
  res.json({ id: funnel.id });
}

adminRouter.post("/admin/funnels", (req, res) => void saveFunnel(null, req.body, res));
adminRouter.put("/admin/funnels/:id", (req, res) => void saveFunnel(req.params.id, req.body, res));

adminRouter.delete("/admin/funnels/:id", async (req, res) => {
  try {
    await prisma.funnel.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    // P2025 — такой записи уже нет; для владельца это тоже «удалено», но
    // остальные сбои (закрыта база, конфликт) должны быть видны, а не молчать.
    logError("admin:deleteFunnel", err);
    res.status(404).json({ error: "Воронка уже удалена или не найдена" });
  }
});

// ---------- журнал ----------

/** Безопасный `take` из строки запроса: `?take=abc` или отрицательное число
 *  раньше давали Prisma NaN/минус, а с автоперехватом ошибок (asyncRoute.ts)
 *  такой запрос просто зависал бы навсегда вместо честного ответа. */
function takeParam(raw: unknown, fallback = 100, max = 500): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

/** Тот же принцип для смещения страницы: мусор в query не должен ронять запрос. */
function skipParam(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Берём take+1: если пришла лишняя запись — значит, есть следующая страница,
 *  и панели не нужен отдельный count(*) только ради кнопки «Ещё». */
function paginate<T>(rows: T[], take: number): { rows: T[]; hasMore: boolean } {
  return rows.length > take ? { rows: rows.slice(0, take), hasMore: true } : { rows, hasMore: false };
}

adminRouter.get("/admin/journal", async (req, res) => {
  const take = takeParam(req.query.take, 40, 200);
  const skip = skipParam(req.query.skip);
  const deliveries = await prisma.delivery.findMany({
    include: { contact: true, funnel: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    skip,
  });
  res.json(paginate(deliveries, take));
});

adminRouter.get("/admin/contacts/:id/messages", async (req, res) => {
  const messages = await prisma.message.findMany({
    where: { contactId: req.params.id },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  res.json(messages);
});

// ---------- чеки ----------

adminRouter.get("/admin/receipts", async (req, res) => {
  const take = takeParam(req.query.take, 40, 200);
  const skip = skipParam(req.query.skip);
  const [receipts, prices] = await Promise.all([
    prisma.receiptCheck.findMany({
      include: { contact: true },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      skip,
    }),
    getPrices(),
  ]);
  const { rows, hasMore } = paginate(receipts, take);
  // «Какой это курс, судя по сумме» — те же допуски, что у allocate(), чтобы
  // панель не держала свою копию цен (inbox чеков показывает это чипом).
  res.json({ hasMore, rows: rows.map((r) => ({ ...r, courseGuess: guessCourse(r.amount, prices) })) });
});

/**
 * Решение по чеку ПРЯМО ИЗ ПАНЕЛИ — раньше единственным способом подтвердить
 * или отклонить подозрительный чек была кнопка под карточкой в Telegram
 * (см. telegramWebhook.ts). Владелец смотрит чеки в панели и жаловался: тут
 * кнопок нет вообще, и решённые (по факту, глазами) чеки годами висят в
 * «Ждут решения» — нечем было записать решение. Логика та же самая
 * (receiptDecision.ts), общая с Telegram-путём.
 */
adminRouter.post("/admin/receipts/:id/decide", async (req, res) => {
  const parsed = z
    .object({
      action: z.enum(["approve", "reject"]),
      course: z.enum(["COURSE50", "COURSE70", "BOTH"]).optional(),
      // Причина отказа из чипов inbox чеков — в журнал, не клиентке.
      reason: z.string().trim().max(100).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { action: 'approve'|'reject', course?: 'COURSE50'|'COURSE70'|'BOTH', reason?: string }" });
    return;
  }
  const result = await decideReceipt(req.params.id, parsed.data.action, parsed.data.course, { reason: parsed.data.reason });
  // Очередь «Сделать сейчас» обязана забыть этот чек сразу, не через 30 с кэша.
  resetTodayCache();
  if (!result.ok) {
    // needs_course — не ошибка сервера, а честный статус "выберите курс": 409
    // тоже подходит (конфликт "нельзя решить без выбора"), но отдельный код
    // проще ловить на фронте, чем парсить текст.
    res.status(result.reason === "not_found" ? 404 : result.reason === "needs_course" ? 422 : 409).json({
      error: result.message,
      needsCourse: result.reason === "needs_course",
    });
    return;
  }
  res.json({ ok: true, status: result.status, message: result.message });
});

// ---------- самообучение стилю ----------

adminRouter.get("/admin/style", async (req, res) => {
  const take = takeParam(req.query.take, 40, 200);
  const skip = skipParam(req.query.skip);
  // Раньше take без skip — первая сотня всегда одна и та же, дальше примеров
  // не увидеть никак (при импорте истории их легко больше сотни). Тот же
  // паттерн take+1/paginate, что и в остальной панели (см. /admin/journal).
  const rows = await prisma.styleExample.findMany({
    orderBy: [{ ledToSale: "desc" }, { createdAt: "desc" }],
    take: take + 1,
    skip,
  });
  const total = await prisma.styleExample.count();
  res.json({ total, ...paginate(rows, take) });
});

/** Разовый импорт прошлых переписок — фоном, ответ сразу (см. services/importService.ts).
 *  Прогресс виден по счётчику в /admin/style. */
adminRouter.post("/admin/style/import", (_req, res) => {
  res.json(styleImportJob.start());
});

adminRouter.post("/admin/style/:id/toggle", async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { enabled: true|false }" });
    return;
  }
  try {
    await prisma.styleExample.update({ where: { id: req.params.id }, data: { enabled: parsed.data.enabled } });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:styleToggle", err);
    res.status(404).json({ error: "Пример не найден" });
  }
});

adminRouter.delete("/admin/style/:id", async (req, res) => {
  try {
    await prisma.styleExample.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    // P2025 — такой записи уже нет; остальные сбои (закрыта база, конфликт)
    // должны быть видны, а не маскироваться под успех (см. /admin/funnels/:id).
    logError("admin:deleteStyleExample", err);
    res.status(404).json({ error: "Пример уже удалён или не найден" });
  }
});

// ---------- медиа-примеры (голос/фото/видео Ширин — одобрение на повтор) ----------

/**
 * Объединённый список из двух пулов — StyleExample (продающая манера
 * Instagram-директа) и QaExample (техническая учебная Telegram-группа), там где
 * есть вложение. `pool` в ответе разделяет источник — переотправка клиенту
 * (Фаза 2) использует ТОЛЬКО approvedForReuse из StyleExample, QaExample пока
 * только копится и одобряется на будущее (см. план 24.08.2026).
 */
adminRouter.get("/admin/media-examples", async (req, res) => {
  const take = takeParam(req.query.take, 24, 100);
  const skip = skipParam(req.query.skip);
  // Пул из двух таблиц шире, чем одна страница, — тянем с запасом (300 с
  // каждой стороны), сливаем и сортируем по дате ЦЕЛИКОМ, а страницу уже
  // нарезаем из готового списка: иначе "новее" из одного пула мог бы вытеснить
  // "новее" из другого при пословной пагинации на уровне БД.
  const [style, qa] = await Promise.all([
    prisma.styleExample.findMany({
      where: { mediaUrl: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
    prisma.qaExample.findMany({
      where: { mediaUrl: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);
  const merged = [
    ...style.map((r) => ({
      pool: "style" as const,
      id: r.id,
      studentText: r.clientText,
      ownerText: r.ownerText,
      mediaUrl: r.mediaUrl,
      mediaType: r.mediaType,
      approvedForReuse: r.approvedForReuse,
      createdAt: r.createdAt,
    })),
    ...qa.map((r) => ({
      pool: "qa" as const,
      id: r.id,
      studentText: r.studentText,
      ownerText: r.ownerText,
      mediaUrl: r.mediaUrl,
      mediaType: r.mediaType,
      approvedForReuse: r.approvedForReuse,
      createdAt: r.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  res.json(paginate(merged.slice(skip, skip + take + 1), take));
});

function mediaExampleModel(pool: string) {
  if (pool === "style") return prisma.styleExample;
  if (pool === "qa") return prisma.qaExample;
  return null;
}

adminRouter.post("/admin/media-examples/:pool/:id/approve", async (req, res) => {
  const model = mediaExampleModel(req.params.pool);
  if (!model) {
    res.status(400).json({ error: "Неизвестный источник" });
    return;
  }
  const parsed = z.object({ approvedForReuse: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { approvedForReuse: true|false }" });
    return;
  }
  try {
    await (model as typeof prisma.styleExample).update({
      where: { id: req.params.id },
      data: { approvedForReuse: parsed.data.approvedForReuse },
    });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:mediaExampleApprove", err);
    res.status(404).json({ error: "Пример не найден" });
  }
});

adminRouter.delete("/admin/media-examples/:pool/:id", async (req, res) => {
  const model = mediaExampleModel(req.params.pool);
  if (!model) {
    res.status(400).json({ error: "Неизвестный источник" });
    return;
  }
  try {
    await (model as typeof prisma.styleExample).delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:deleteMediaExample", err);
    res.status(404).json({ error: "Пример уже удалён или не найден" });
  }
});

// ---------- догоняющие сообщения ----------

const followUpSchema = z.object({
  afterHours: z.number().int().min(1).max(23),
  text: z.string().min(1).max(1000),
  mediaUrl: z.string().url().nullable().optional(),
  mediaType: z.enum(["video", "image", "file"]).nullable().optional(),
  enabled: z.boolean().default(true),
});

adminRouter.get("/admin/followups", async (_req, res) => {
  const rows = await prisma.followUp.findMany({
    orderBy: { afterHours: "asc" },
    include: { _count: { select: { sends: true } } },
  });
  res.json(rows);
});

adminRouter.post("/admin/followups", async (req, res) => {
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    return;
  }
  const created = await prisma.followUp.create({
    data: { ...parsed.data, mediaUrl: parsed.data.mediaUrl ?? null, mediaType: parsed.data.mediaType ?? null },
  });
  res.json({ id: created.id });
});

adminRouter.put("/admin/followups/:id", async (req, res) => {
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    return;
  }
  try {
    await prisma.followUp.update({
      where: { id: req.params.id },
      data: { ...parsed.data, mediaUrl: parsed.data.mediaUrl ?? null, mediaType: parsed.data.mediaType ?? null },
    });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:followUpUpdate", err);
    res.status(404).json({ error: "Догоняющее не найдено" });
  }
});

adminRouter.delete("/admin/followups/:id", async (req, res) => {
  try {
    await prisma.followUp.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:deleteFollowUp", err);
    res.status(404).json({ error: "Догоняющее уже удалено или не найдено" });
  }
});

// ---------- клиенты ----------

adminRouter.get("/admin/contacts", async (req, res) => {
  const take = takeParam(req.query.take, 30, 200);
  const skip = skipParam(req.query.skip);
  // Поиск по имени/нику/идентификатору. SQLite сравнивает LIKE без учёта
  // регистра только для ASCII — на кириллице регистр значения не играет роли
  // в практике владельца (ники Instagram латиницей), уточнено в hint на фронте.
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const where = q
    ? {
        OR: [
          { username: { contains: q } },
          { name: { contains: q } },
          { igUserId: { contains: q } },
        ],
      }
    : {};

  const contacts = await prisma.contact.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: take + 1,
    skip,
    include: {
      deliveries: { include: { funnel: { select: { name: true } } }, orderBy: { updatedAt: "desc" }, take: 1 },
      _count: { select: { messages: true } },
    },
  });
  const { rows, hasMore } = paginate(contacts, take);
  res.json({
    hasMore,
    rows: rows.map((c) => ({
      id: c.id,
      igUserId: c.igUserId,
      username: c.username,
      name: c.name,
      avatarUrl: c.avatarUrl,
      channel: c.channel,
      paid: c.paid,
      paidAt: c.paidAt,
      personal: c.personal,
      spamBlockedAt: c.spamBlockedAt,
      spamReason: c.spamReason,
      // Дошёл ли человек до уроков и не отобран ли доступ — по этим полям
      // владелец видит, за кем идти, и кого выгонять за фальшивый чек.
      joinedGroupAt: c.joinedGroupAt,
      accessRevokedAt: c.accessRevokedAt,
      inGroup: Boolean(c.telegramUserId),
      tags: parseStringArray(c.tags),
      messages: c._count.messages,
      updatedAt: c.updatedAt,
      lastFunnel: c.deliveries[0]?.funnel.name ?? null,
      lastState: c.deliveries[0]?.state ?? null,
      lastStep: c.deliveries[0]?.nextOrder ?? null,
    })),
  });
});

/**
 * ОТОБРАТЬ ДОСТУП одной кнопкой. Нужен, когда чек оказался фальшивым уже после
 * выдачи ссылки: человека выгоняет из обеих групп, снимает отметку об оплате и
 * отзывает ссылку — иначе искать его в Telegram руками полчаса.
 */
adminRouter.post("/admin/contacts/:id/revoke", async (req, res) => {
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : "фальшивый чек";

  // Атомарная заявка на отзыв ПРЯМО В БАЗЕ: если два быстрых тапа пришли почти
  // одновременно, только один из них увидит count:1 и реально выполнит откат
  // (бан в Telegram, письмо владельцу) — второй узнает, что уже отозвано, без
  // повторных внешних вызовов.
  const claimed = await prisma.contact.updateMany({
    where: { id: req.params.id, accessRevokedAt: null },
    data: { accessRevokedAt: new Date() },
  });
  if (claimed.count === 0) {
    res.json({ ok: true, details: "уже отозвано" });
    return;
  }

  const result = await revokeAccess(req.params.id, reason);
  if (!result.ok) {
    // revokeAccess не дошёл до реального отзыва (нет токена бота и т.п.) —
    // откатываем заявку, иначе повторная попытка увидит accessRevokedAt уже
    // проставленным и соврёт «уже отозвано», хотя ничего не произошло.
    await prisma.contact.updateMany({ where: { id: req.params.id, accessRevokedAt: { not: null } }, data: { accessRevokedAt: null } });
    res.status(400).json({ error: result.details });
    return;
  }
  res.json({ ok: true, details: result.details });
});

/**
 * ВЕРНУТЬ ОШИБОЧНО ОТОБРАННЫЙ ДОСТУП. Та же атомарная заявка, что у отзыва:
 * два быстрых тапа не выдадут человеку ссылку дважды.
 */
adminRouter.post("/admin/contacts/:id/restore", async (req, res) => {
  const claimed = await prisma.contact.updateMany({
    where: { id: req.params.id, accessRevokedAt: { not: null } },
    data: { accessRevokedAt: null },
  });
  if (claimed.count === 0) {
    res.json({ ok: true, details: "доступ и так не был отозван" });
    return;
  }

  const result = await restoreAccess(req.params.id);
  if (!result.ok) {
    // restoreAccess не дошёл до реального восстановления (нет токена бота и
    // т.п.) — откатываем снятую заявку, иначе повторная попытка увидит
    // accessRevokedAt уже пустым и соврёт «и так не был отозван».
    await prisma.contact.updateMany({ where: { id: req.params.id, accessRevokedAt: null }, data: { accessRevokedAt: new Date() } });
    res.status(400).json({ error: result.details });
    return;
  }
  res.json({ ok: true, details: result.details });
});

const RU_MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
/** Сколько дней назад можно долистать на Главной — месяц с запасом, дальше
 *  смотреть по дням не нужно, для этого есть «Деньги» с настоящим периодом. */
const MAX_DAY_OFFSET = 30;

function dayLabel(dayOffset: number, dayStart: Date, offset: number): string {
  if (dayOffset === 0) return "Сегодня";
  if (dayOffset === 1) return "Вчера";
  // Тот же приём сдвига, что в localDayStart: превращаем UTC-момент назад в
  // «местные» календарные поля, читая их как UTC.
  const local = new Date(dayStart.getTime() + offset);
  return `${local.getUTCDate()} ${RU_MONTHS[local.getUTCMonth()]}`;
}

/**
 * ГЛАВНЫЙ ЭКРАН. Один запрос вместо пяти — на телефоне каждый лишний поход в
 * сеть это заметная пауза, а первый экран должен появляться мгновенно.
 *
 * `dayOffset` (0 — сегодня, 1 — вчера, ...) листает только блок «Сегодня» —
 * владелец попросил свайп по дням назад. «За неделю»/«Требует внимания» —
 * это состояние ПРЯМО СЕЙЧАС, не имеет смысла смотреть на них «вчерашними» и
 * dayOffset не затрагивает.
 *
 * Границы суток — ТЕПЕРЬ по Душанбе (offsetMs/localDayStart из dailyReport.ts,
 * та же пара, что уже используют stuckAlert.ts и сама вечерняя сводка), а не
 * setHours(0,0,0,0) в часовом поясе контейнера (UTC) — старый код называл
 * "сегодня" полночь UTC, то есть суммы "за сегодня" до 5 утра по Душанбе на
 * самом деле показывали ещё вчерашний день, а после — теряли первые 5 часов.
 */
adminRouter.get("/admin/dashboard", async (req, res) => {
  const dayOffset = Math.min(Math.max(Math.trunc(Number(req.query.dayOffset)) || 0, 0), MAX_DAY_OFFSET);
  const offset = await offsetMs();
  const dayStart = localDayStart(dayOffset, offset);
  const dayEnd = localDayStart(dayOffset - 1, offset);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [todaySales, weekSales, todayPeople, weekPeople, pending, unchecked, notJoined, offline, funnelsOn, aiOn] =
    await Promise.all([
      prisma.purchase.findMany({ where: { createdAt: { gte: dayStart, lt: dayEnd }, revokedAt: null }, select: { amount: true } }),
      prisma.purchase.findMany({ where: { createdAt: { gte: weekAgo }, revokedAt: null }, select: { amount: true } }),
      prisma.message.findMany({
        where: { direction: "IN", createdAt: { gte: dayStart, lt: dayEnd } },
        select: { contactId: true },
        distinct: ["contactId"],
      }),
      prisma.message.findMany({
        where: { direction: "IN", createdAt: { gte: weekAgo } },
        select: { contactId: true },
        distinct: ["contactId"],
      }),
      prisma.receiptCheck.count({ where: { ownerDecision: "PENDING" } }),
      prisma.receiptCheck.count({ where: { kind: "unchecked" } }),
      countNotOpened(),
      prisma.offlineSignup.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.funnel.count({ where: { enabled: true } }),
      getSetting("aiEnabled"),
    ]);

  const sum = (rows: { amount: number }[]) => rows.reduce((acc, r) => acc + r.amount, 0);
  res.json({
    dayOffset,
    dayLabel: dayLabel(dayOffset, dayStart, offset),
    canGoOlder: dayOffset < MAX_DAY_OFFSET,
    today: { money: sum(todaySales), sales: todaySales.length, people: todayPeople.length },
    week: { money: sum(weekSales), sales: weekSales.length, people: weekPeople.length },
    attention: { pending, unchecked, notJoined },
    offline,
    funnelsOn,
    aiOn: aiOn === "true",
  });
});

/**
 * ЭКРАН «ДЕНЬГИ» — полная картина продаж за период.
 *
 * Считается по покупкам (Purchase), а не по чекам: доступ мог открыть бот,
 * владелец кнопкой в Telegram или живая хозяйка руками — продажа во всех трёх
 * случаях одна и та же. Чеки идут отдельной строкой, как «что ждёт решения».
 */
adminRouter.get("/admin/money", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86_400_000);

  const rowsTake = takeParam(req.query.rowsTake, 30, 100);
  const rowsSkip = skipParam(req.query.rowsSkip);

  const [totals, rowsPage, revoked, pending, unchecked, blocked, offline] = await Promise.all([
    // Без ограничения на количество строк — иначе при days=365 и продажах
    // больше пары сотен старые продажи периода молча выпадали бы из итогов
    // (раньше total/byCourse/byDay считались по тому же срезу в 500 строк,
    // что и таблица на странице).
    prisma.purchase.findMany({
      where: { createdAt: { gte: from }, revokedAt: null },
      select: { course: true, amount: true, createdAt: true },
    }),
    prisma.purchase.findMany({
      where: { createdAt: { gte: from }, revokedAt: null },
      include: { contact: { select: { username: true, igUserId: true, joinedGroupAt: true } } },
      orderBy: { createdAt: "desc" },
      take: rowsTake + 1,
      skip: rowsSkip,
    }),
    prisma.purchase.count({ where: { createdAt: { gte: from }, revokedAt: { not: null } } }),
    prisma.receiptCheck.count({ where: { ownerDecision: "PENDING" } }),
    prisma.receiptCheck.count({ where: { kind: "unchecked" } }),
    prisma.blockedReceipt.count(),
    prisma.offlineSignup.count({ where: { createdAt: { gte: from } } }),
  ]);

  const byCourse: Record<string, { count: number; sum: number }> = {};
  const byDay: Record<string, number> = {};
  let total = 0;
  for (const p of totals) {
    const c = (byCourse[p.course] ??= { count: 0, sum: 0 });
    c.count += 1;
    c.sum += p.amount;
    total += p.amount;
    const day = p.createdAt.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + p.amount;
  }

  res.json({
    days,
    total,
    count: totals.length,
    byCourse,
    byDay,
    revoked,
    pending,
    unchecked,
    blocked,
    offline,
    ...(() => {
      const { rows, hasMore } = paginate(rowsPage, rowsTake);
      return {
        hasMore,
        rows: rows.map((p) => ({
          id: p.id,
          who: p.contact.username ? `@${p.contact.username}` : p.contact.igUserId,
          course: p.course,
          amount: p.amount,
          rawAmount: p.rawAmount,
          currency: p.currency,
          // «Вошла» зависит от того, куда выдаём доступ: в группу Telegram —
          // joinedGroupAt, на платформу — первое открытие ссылки. Раньше
          // смотрелось только первое, и все ушедшие на платформу навсегда
          // числились непришедшими (разбор 03.09.2026).
          joined: Boolean(p.contact.joinedGroupAt) || Boolean(p.firstOpenedAt),
          // Начала ли реально учиться (ответила на проверочное «как первый урок»),
          // а не просто зашла в группу — см. learningCheckIn.ts.
          startedLearning: p.startedLearning,
          createdAt: p.createdAt,
        })),
      };
    })(),
  });
});

// ---------- статистика по шагам воронки ----------

adminRouter.get("/admin/funnels/:id/stats", async (req, res) => {
  const funnel = await prisma.funnel.findUnique({
    where: { id: req.params.id },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!funnel) {
    res.status(404).json({ error: "Воронка не найдена" });
    return;
  }
  const deliveries = await prisma.delivery.findMany({
    where: { funnelId: funnel.id },
    select: { nextOrder: true, state: true, contact: { select: { paid: true } } },
  });

  // На каком шаге человек стоит сейчас — по нему и видно, где отваливаются.
  const stuckByStep = new Map<number, number>();
  for (const d of deliveries) {
    if (d.state === "DONE") continue;
    stuckByStep.set(d.nextOrder, (stuckByStep.get(d.nextOrder) ?? 0) + 1);
  }

  res.json({
    total: deliveries.length,
    done: deliveries.filter((d) => d.state === "DONE").length,
    paid: deliveries.filter((d) => d.contact.paid).length,
    steps: funnel.steps.map((s) => ({
      order: s.order,
      text: s.text.slice(0, 60),
      stuckHere: stuckByStep.get(s.order) ?? 0,
    })),
  });
});

// ---------- личные контакты (бот молчит навсегда) ----------

adminRouter.get("/admin/personal", async (_req, res) => {
  const rows = await prisma.contact.findMany({
    where: { personal: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  res.json(rows);
});

/** Пометить/снять «личный контакт». Бот с такими не разговаривает вообще: это
 *  родня и знакомые хозяйки, а не клиенты. */
adminRouter.post("/admin/contacts/:id/personal", async (req, res) => {
  const parsed = z.object({ personal: z.boolean(), reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { personal: true|false }" });
    return;
  }
  try {
    await prisma.contact.update({
      where: { id: req.params.id },
      data: {
        personal: parsed.data.personal,
        personalReason: parsed.data.personal ? parsed.data.reason ?? "Отмечен вручную" : null,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:setPersonal", err);
    res.status(404).json({ error: "Клиент не найден" });
  }
});

/** Снять/поставить блок за спам вручную (webhook.ts ставит его сам по abuseFilter). */
adminRouter.post("/admin/contacts/:id/spam", async (req, res) => {
  const parsed = z.object({ blocked: z.boolean(), reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { blocked: true|false }" });
    return;
  }
  try {
    await prisma.contact.update({
      where: { id: req.params.id },
      data: parsed.data.blocked
        ? { spamBlockedAt: new Date(), spamReason: parsed.data.reason ?? "Заблокирован вручную" }
        : { spamBlockedAt: null, spamReason: null },
    });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:setSpam", err);
    res.status(404).json({ error: "Клиент не найден" });
  }
});

/** Владелец сам решил, что с клиентом делать (например, вручную вывел из доступа
 *  после подозрительного чека) — снимаем отметку «оплатил», чтобы при следующем
 *  настоящем чеке ссылка ушла заново. */
adminRouter.post("/admin/contacts/:id/unpay", async (req, res) => {
  try {
    await prisma.contact.update({ where: { id: req.params.id }, data: { paid: false, paidAt: null } });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:unpay", err);
    res.status(404).json({ error: "Клиент не найден" });
  }
});

// ---------- загрузка файлов для шагов воронки ----------

adminRouter.post("/admin/upload", upload.single("file"), handleUpload);

// ---------- платформа курсов ----------
// Отдельным файлом (course/adminRoutes.ts): курсы, уроки, загрузка видео,
// рецепты, устройства и вопросы учениц — это самостоятельный раздел, а admin.ts
// и так был god-file. Пароль уже проверен выше, повторно не проверяем.
adminRouter.use(courseAdminRouter);
adminRouter.use(importRouter);
// «Тексты и цены» — цены, реквизиты, сертификат, офлайн (textsRoutes.ts).
adminRouter.use(textsRouter);
// Главный экран «Сегодня» — очередь дел и утренние числа (today.ts).
adminRouter.use(todayRouter);
// Воронка, выручка по каналам, карточка ученицы (metrics.ts). Внутри
// adminRouter, а не в index.ts, — иначе /admin/metrics/* обошёл бы проверку
// пароля выше.
adminRouter.use(metricsRouter);
adminRouter.use(searchRouter);
// «Спросить помощницу» — ИИ-диспетчер над закрытым набором read-only
// инструментов (assistantPanel.ts); ничего не отправляет, SQL не пишет.
adminRouter.use(assistantRouter);

// ---------- отзывы (реальные скриншоты, см. ai/testimonials.ts) ----------
//
// Загрузка картинки идёт тем же общим /admin/upload выше — здесь только
// сохраняем ссылку, которую он вернул, вместе с подписью.

const testimonialSchema = z.object({
  imageUrl: z.string().url(),
  caption: z.string().max(500).nullable().optional(),
});

adminRouter.get("/admin/testimonials", async (req, res) => {
  const take = takeParam(req.query.take, 24, 100);
  const skip = skipParam(req.query.skip);
  const rows = await prisma.testimonial.findMany({ orderBy: { createdAt: "desc" }, take: take + 1, skip });
  res.json(paginate(rows, take));
});

adminRouter.post("/admin/testimonials", async (req, res) => {
  const parsed = testimonialSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    return;
  }
  const created = await prisma.testimonial.create({
    data: { imageUrl: parsed.data.imageUrl, caption: parsed.data.caption ?? null },
  });
  res.json({ id: created.id });
});

adminRouter.put("/admin/testimonials/:id", async (req, res) => {
  const parsed = z
    .object({ caption: z.string().max(500).nullable().optional(), active: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужен caption (строка или null) и/или active (bool)" });
    return;
  }
  try {
    await prisma.testimonial.update({
      where: { id: req.params.id },
      data: { caption: parsed.data.caption, active: parsed.data.active },
    });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:testimonialUpdate", err);
    res.status(404).json({ error: "Отзыв не найден" });
  }
});

adminRouter.delete("/admin/testimonials/:id", async (req, res) => {
  try {
    await prisma.testimonial.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    logError("admin:deleteTestimonial", err);
    res.status(404).json({ error: "Отзыв уже удалён или не найден" });
  }
});

/** Разовый разбор архива учебной группы на отзывы (Фаза 3, Источник B) — тот же
 *  фоновый запуск, что у /admin/style/import (см. services/importService.ts). */
adminRouter.post("/admin/testimonials/import-archive", (_req, res) => {
  res.json(archiveTestimonialsImportJob.start());
});

// ---------- проверка отправки (нужен подключённый Instagram) ----------

adminRouter.post("/admin/test-send", async (req, res) => {
  const parsed = z.object({ igUserId: z.string().min(1), text: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужны igUserId и text" });
    return;
  }
  try {
    const mid = await sendText(parsed.data.igUserId, parsed.data.text);
    res.json({ ok: true, mid });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
