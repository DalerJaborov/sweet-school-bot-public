import crypto from "node:crypto";
import { prisma, getSetting, logError, logWarn, recordOutgoingMessage } from "./db.js";
import { sendPrivateReply, metaChannelOf } from "./instagram.js";
import { sendToContact } from "./messaging/send.js";
import { guardOffTopic, guardReply, isGuardReply, isSilentKind, MAX_GUARD_REPLIES, MAX_RECIPE_REPLIES, ABOUT_COURSE, detectMenuQuestion } from "./ai/offTopicGuard.js";
import { sendMenuImages } from "./ai/menuImages.js";
import { findReusableMedia, sendReusedMedia } from "./ai/mediaReuse.js";
import { detectClientLanguage, detectReplyLanguage, type ClientLanguage } from "./ai/clientLanguage.js";
import { claimsReceiptSent, receiptNotSeenReply } from "./ai/receiptClaim.js";
import { BUDGET_FALLBACK } from "./ai/prompts.js";
import { buildSystemPrompt } from "./services/salesTextsService.js";
import { isBudgetExceeded, recordAiCall } from "./ai/dailyBudget.js";
import { fetchAttachment, buildMediaPart, type Attachment, type MediaPart } from "./ai/media.js";
import { checkReceipt, pickReceiptVerdict, type ReceiptVerdict } from "./ai/receiptCheck.js";
import { queueUncheckedReceipt } from "./receiptRetry.js";
import { queuePendingAiReply } from "./aiReplyRetry.js";
import { logAiCall } from "./ai/aiLog.js";
import { registerOfflineSignup } from "./ai/offlineSignup.js";
import { maybeSendOfflineCard } from "./ai/offlineCourse.js";
import { courseDateLabel } from "./ai/courseDate.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { buildStyleBlock } from "./ai/styleLearning.js";
import { ownerAlertChatIds, sendMessageWithButtons } from "./telegram.js";
import { getQuickReplies } from "./quickReplies.js";
import { saveReceiptImage } from "./upload.js";
import { generateWithFallback, thinkingConfigFor } from "./gemini.js";
import { markStartedLearningIfReplied } from "./learningCheckIn.js";
import { notifyIfStuck } from "./stuckAlert.js";
import { maybeSendTestimonial } from "./ai/testimonials.js";
import { ownedCourses, COURSE_TITLE, COURSE_50, COURSE_70 } from "./courses.js";
import { buildInsightsBlock } from "./nightlyLearning.js";
import { buildObjectionsBlock } from "./ai/objectionLibrary.js";
import { maybeRestoreAccess } from "./course/recovery.js";
import type { Contact } from "@prisma/client";


const TIMEOUT_MS = 60_000;
/**
 * ГОЛОСОВЫЕ РАЗБИРАЕТ САМАЯ СИЛЬНАЯ МОДЕЛЬ.
 *
 * Дешёвые flash-модели таджикскую речь на слух почти не понимают — выдают кашу
 * или «не разобрал», и человек получает ответ невпопад. Pro слышит диалект
 * заметно лучше. Она медленнее (около 20 секунд против трёх), но голосовое и так
 * не ждут мгновенно, а неверно понятый вопрос стоит дороже задержки.
 *
 * Меняется настройкой `aiModelVoice` без пересборки.
 */
const VOICE_MODEL = "gemini-3.1-pro-preview";
/** Pro думает дольше — с обычными 60 секундами она не успевала бы. */
const VOICE_TIMEOUT_MS = 120_000;
const HISTORY_LIMIT = 20;
/** Больше вложений в одном сообщении — редкость, и каждое лишнее — это лишние
 *  мегабайты в запросе и лишние секунды ожидания клиента. */
const MAX_ATTACHMENTS_PER_MESSAGE = 3;

// DEFAULT_PROMPT, ALWAYS_RULES, BUDGET_FALLBACK живут в ai/prompts.ts —
// отдельно от логики, чтобы правило «без слова школа» проверялось тестом.

/**
 * РАЗБИВКА ОТВЕТА НА НЕСКОЛЬКО СООБЩЕНИЙ (решение владельца 22.08.2026).
 *
 * «Огромные куски не нужны — люди любят коротко, и сами пишут несколько сообщений
 * подряд». В живой переписке так и есть: человек шлёт две-три короткие реплики, а
 * не одно полотно. Полотно в мессенджере не читают — его пролистывают.
 *
 * Разделитель просит ставить сам промт (правило 5). Разбор терпимый: модель может
 * поставить «---» с пробелами или лишними дефисами, и придираться тут не к чему.
 *
 * ПОТОЛОК В ТРИ СООБЩЕНИЯ — защита от обратной крайности: получив право слать
 * несколько, модель однажды пришлёт восемь, и это уже не переписка, а очередь
 * уведомлений. Лишние части не теряются — они склеиваются в последнее сообщение.
 */
const MAX_REPLY_PARTS = 3;

export function splitReplyParts(text: string): string[] {
  const parts = text
    .split(/^\s*-{3,}\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [text.trim()].filter(Boolean);
  if (parts.length <= MAX_REPLY_PARTS) return parts;
  const head = parts.slice(0, MAX_REPLY_PARTS - 1);
  return [...head, parts.slice(MAX_REPLY_PARTS - 1).join(" ")];
}


/** Скачанная картинка вместе со всем, что нужно для разбора чека. */
/** Сколько фото из одного сообщения проверяем как чек — больше трёх подряд не шлют. */
const MAX_RECEIPT_IMAGES = 3;

export type RescuedImage = {
  buffer: Buffer;
  mimeType: string;
  hash: string;
  url: string | null;
  /** Строка очереди, созданная под эту картинку (её потом обновит вердикт). */
  queuedId: string | null;
};

/**
 * Скачивает КАЖДУЮ присланную картинку, сохраняет свою копию и ставит в очередь
 * разбора.
 *
 * ВЫЗЫВАЕТСЯ В webhook.ts, ДО проверки isHumanSilenced — не здесь, в aiReply.
 * Раньше вызывалась первой строкой aiReply, и комментарий об этом гордо говорил
 * «до любых проверок» — но самих проверок в webhook.ts, из-за которых aiReply
 * мог вообще не вызваться (человек-хозяйка ведёт разговор сама), это не
 * касалось. Чек, присланный именно в это окно, скачивался, но нигде не
 * сохранялся и не вставал в очередь — уходил в никуда молча (живой случай
 * 23.08.2026: roza97788 прислала чек и «Алоо» во время паузы после ответа
 * Ширин, бот не увидел ни то, ни другое, ссылку так и не выдали). aiReply
 * теперь только использует то, что ему передали, а не скачивает заново.
 *
 * Разбираем не только первую картинку: человек часто шлёт пакетом фото десерта и
 * следом чек, а дебаунс склеивает их в одно сообщение — раньше чек в такой паре
 * просто не замечали.
 */
export async function rescueIncomingImages(contact: Contact, attachments: Attachment[]): Promise<RescuedImage[]> {
  const out: RescuedImage[] = [];
  for (const att of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (att.kind !== "image") continue;
    const downloaded = await fetchAttachment(att.url).catch((err) => {
      logError("ai:rescueIncomingImages:fetchAttachment", err);
      return null;
    });
    if (!downloaded) continue;
    out.push(await rescueImage(contact, downloaded.buffer, downloaded.mimeType));
  }
  return out;
}

/**
 * Спасти ОДНУ уже скачанную картинку: своя копия на диске + очередь разбора.
 * Вынесено из цикла выше, потому что чат на сайте получает файл прямо из
 * формы — скачивать его по ссылке, как у Instagram, там нечего и незачем.
 */
export async function rescueImage(contact: Contact, buffer: Buffer, mimeType: string): Promise<RescuedImage> {
  // Отпечаток КАРТИНКИ, а не ссылки — тот же чек, пересланный другому человеку
  // и загруженный заново, даёт другой URL, но те же самые байты.
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  // Своя копия: ссылка Instagram живёт недолго и требует маркера, а карточку
  // владельцу в Telegram надо показать позже и по публичному адресу.
  const url = saveReceiptImage(buffer, mimeType);
  const queuedId = url
    ? await queueUncheckedReceipt(contact.id, hash, url).catch((err) => {
        logError("ai:rescueIncomingImages:queueUncheckedReceipt", err);
        return null;
      })
    : null;
  return { buffer, mimeType, hash, url, queuedId };
}

async function recentOutgoingTexts(contactId: string, take: number): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", text: { not: null } },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map((m) => m.text as string);
}

/**
 * Отвечает на свободный вопрос через Gemini — сначала проверяет защиту:
 *  1) не разведка и не «сделай мне работу» (бесплатный regex, до платного хода);
 *  2) не третий шаблонный ответ подряд (человек не по делу — молчим совсем);
 *  3) в пределах суточного бюджета на счёт и на весь бот;
 *  4) сама модель — только если первые три слоя пропустили.
 * Фото, видео и голосовые уходят в модель ВМЕСТЕ с текстом, тем же запросом — бот
 * видит и слышит вложение, а не только читает подпись к нему.
 */
export async function aiReply(
  contact: Contact,
  text: string,
  attachments: Attachment[] = [],
  rescuedImages: RescuedImage[] = []
): Promise<void> {
  // ЭКСТРЕННАЯ ПАУЗА (владелец 13.09.2026): «всё, кроме воронки». Гасит и
  // выдачу ссылки на курс (maybeRestoreAccess ниже — обычно работает ДАЖЕ при
  // выключенном aiEnabled, см. её комментарий), и отзыв-скриншот, и сам ИИ-ответ
  // одним ранним выходом. Воронка (funnel.ts) вызывается из webhook.ts до
  // aiReply и этой проверки не видит вовсе — её выключить нельзя тем же флагом.
  if ((await getSetting("botFrozen")) === "true") return;

  // Побочный эффект, не влияющий на сам ответ: если человеку уже уходило
  // проверочное «как первый урок» (learningCheckIn.ts) и она хоть что-то
  // написала после этого — считаем, что учиться начала. Fire-and-forget: сбой
  // здесь не должен трогать реальный ответ бота ниже.
  markStartedLearningIfReplied(contact.id).catch((err) => logError("learningCheckIn:reply", err));

  // Реальный скриншот отзыва в директ, если человек засомневался — своё
  // отдельное сообщение, независимое от ответа модели ниже (см. ai/testimonials.ts).
  // Fire-and-forget тем же способом, что и остальные побочные эффекты здесь:
  // сбой не должен ни задержать, ни оборвать основной ответ бота.
  maybeSendTestimonial(contact, text).catch((err) => logError("testimonial:send", err));

  // Картинки уже спасены выше по цепочке, в webhook.ts (rescueIncomingImages),
  // до проверки isHumanSilenced — см. её комментарий. Здесь просто используем
  // то, что уже скачано, сохранено и стоит в очереди разбора; повторно скачивать
  // и класть в очередь ту же картинку не нужно.
  const images = rescuedImages;

  // «Не открывается курс, дайте ссылку заново» — разбираем ДО ИИ и до проверки
  // aiEnabled: человек уже заплатил, и техническая заминка не должна зависеть
  // ни от настроения модели, ни от того, включён ли консультант вообще.
  // Выдача идёт по данным (покупка + чек в базе), а не по словам — см.
  // course/recovery.ts.
  if (text) {
    const recovery = await maybeRestoreAccess(contact, text).catch((err) => {
      logError("ai:recovery", err);
      return { handled: false as const };
    });
    // Разобрано — молчим: иначе поверх выданной ссылки консультант скажет своё,
    // и человек получит два разных ответа на один вопрос.
    if (recovery.handled) return;
  }

  const enabled = (await getSetting("aiEnabled")) === "true";
  if (!enabled) return;
  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) {
    logError("ai:aiReply:noGeminiKeys", new Error("Gemini API keys not configured — AI reply skipped"));
    return;
  }
  const primaryKey = apiKeys[0];

  const language = detectClientLanguage(text);

  // «Я отправила чек» — а картинки в сообщении нет и в этот ход ничего не
  // спасено. Модели такое не показываем: она верит слову «чек» и отвечает
  // «принято, открываю» (живой прогон 05.09.2026). Ответ детерминированный,
  // см. ai/receiptClaim.ts.
  if (text && claimsReceiptSent(text) && !attachments.some((a) => a.kind === "image") && images.length === 0) {
    const reply = receiptNotSeenReply(language, contact.channel === "WEB");
    const mid = await sendToContact(contact, reply);
    await recordOutgoingMessage(contact.id, reply, mid);
    notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
    return;
  }

  // Защита смотрит только на текст — вложение без подписи её не проходит вовсе,
  // это ниже отдаётся модели как есть (её решает промт: чек, фото десерта, спам).
  if (text) {
    const verdict = guardOffTopic(text);
    if (verdict) {
      // Вопрос про еду — особый случай: отвечаем ОДИН раз (отправляем в чат
      // телеграм-группы) и дальше молчим совсем, даже если спросят про другой
      // десерт. Поэтому считаем по всей переписке, а не по последним сообщениям.
      // Молчаливые виды («пустите бесплатно», назойливость) — ни слова в ответ.
      if (isSilentKind(verdict.kind)) return;
      const isRecipe = verdict.kind === "recipe_question";
      const limit = isRecipe ? MAX_RECIPE_REPLIES : MAX_GUARD_REPLIES;
      const recent = await recentOutgoingTexts(contact.id, isRecipe ? 50 : MAX_GUARD_REPLIES);
      const said = recent.filter((t) => isGuardReply(t, isRecipe ? "recipe_question" : undefined)).length;
      if (said >= limit) return; // уже сказали — дальше отвечает сама Ширин, бот молчит
      // Звать в закрытый телеграм-чат можно только тем, кто оплатил курс:
      // группа закрытая, и приглашать туда всех подряд нельзя (см. guardReply).
      const isStudent =
        isRecipe &&
        // revokedAt: доступ отозвали — человек больше не ученица, и звать её в
        // закрытый чат снова нельзя.
        (await prisma.purchase.count({ where: { contactId: contact.id, revokedAt: null } })) > 0;
      const reply = guardReply(verdict.kind, language, isStudent);
      // Обещали позвать Ширин — зовём и замолкаем (см. callOwnerToChat).
      if (verdict.kind === "wants_human") await callOwnerToChat(contact, text);
      const mid = await sendToContact(contact, reply);
      await recordOutgoingMessage(contact.id, reply, mid);
      // Реалтайм-версия «где бот застрял» (см. stuckAlert.ts) — заглушка
      // офф-топика тоже полноценный ответ бота, и именно на неё чаще всего
      // натыкается человек, чей вопрос бот раз за разом не понимает.
      notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      return;
    }

    // Просят список десертов курса — код отвечает готовой картинкой-меню, а не
    // модель полотном текста (см. detectMenuQuestion). Настоящий ход модели
    // сюда не доходит вовсе — то же рассуждение, что у guardOffTopic выше.
    if (detectMenuQuestion(text)) {
      await sendMenuImages(contact, text);
      notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      return;
    }

    // Фаза 2 «максимального использования архива» — на похожий вопрос шлём её
    // реальный одобренный голос/фото/видео вместо хода модели (см. ai/mediaReuse.ts).
    // Ничего не подошло — самый частый случай, отвечает модель как обычно.
    const reusableMedia = await findReusableMedia(text);
    if (reusableMedia) {
      await sendReusedMedia(contact, reusableMedia);
      notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      return;
    }
  }

  if (await isBudgetExceeded(contact.id)) {
    const reply = BUDGET_FALLBACK[language];
    const mid = await sendToContact(contact, reply);
    await recordOutgoingMessage(contact.id, reply, mid);
    notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
    return;
  }

  // Промт владельца + живые образцы его собственных ответов (самообучение —
  // см. ai/styleLearning.ts). Сам промт не переписывается никогда.
  // Промт владельца + незыблемые правила с текущими ценами/реквизитами из
  // раздела «Тексты и цены» (services/salesTextsService.ts).
  const prompt =
    (await buildSystemPrompt()) +
    (await buildStyleBlock(text)) +
    (await buildInsightsBlock()) +
    (await buildObjectionsBlock()) +
    (await buildSocialProofBlock()) +
    (await alreadyOwnedBlock(contact, text)) +
    (await coldLeadNudge(contact, text)) +
    (await offlineSignupBlock(contact, text)) +
    webChannelBlock(contact);
  // gemini-2.5-flash закрыта Google (404 на каждый вызов) — та же модель, что
  // сейчас реально отвечает в основной CRM (см. GEMINI_MODEL там).
  let model = (await getSetting("aiModel")) || "gemini-3.7-flash";
  let timeout = TIMEOUT_MS;
  // Есть голосовое — переключаемся на сильную модель целиком: она же пишет и
  // ответ, иначе разбор и ответ разъедутся по смыслу.
  if (attachments.some((a) => a.kind === "audio")) {
    model = (await getSetting("aiModelVoice"))?.trim() || VOICE_MODEL;
    timeout = VOICE_TIMEOUT_MS;
  }

  // Крупное видео уходит через File API и живёт под тем ключом/проектом, который
  // его залил — на генерации нельзя подсунуть другой ключ, "file_uri" чужого
  // проекта не примет. Поэтому если в сообщении есть хоть один такой файл, весь
  // ход генерации ниже закреплён за ПЕРВЫМ ключом (без перебора); маленькие
  // вложения (inline) от ключа не зависят — для них перебор работает как обычно.
  const mediaParts: MediaPart[] = [];
  // Каждая картинка вместе со своей частью для модели: чек проверяем у ВСЕХ
  // фото сообщения, а не только у первого (см. pickReceiptVerdict ниже).
  const imageParts: { image: RescuedImage; part: MediaPart }[] = [];
  let usedFileApi = false;
  // Картинки уже скачаны выше (страховка чека) — второй раз их не тянем.
  const imageQueue = [...images];
  for (const att of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const cached = att.kind === "image" ? imageQueue.shift() : null;
    const downloaded = cached
      ? { buffer: cached.buffer, mimeType: cached.mimeType }
      : await fetchAttachment(att.url);
    if (!downloaded) continue;
    const part = await buildMediaPart(downloaded.buffer, downloaded.mimeType, primaryKey);
    if (!part) continue;
    mediaParts.push(part);
    if ("file_data" in part) usedFileApi = true;
    if (att.kind === "image" && cached) imageParts.push({ image: cached, part });
  }
  const firstImagePart = imageParts[0]?.part ?? null;
  const keysForGenerate = usedFileApi ? [primaryKey] : apiKeys;

  const history = await prisma.message.findMany({
    where: { contactId: contact.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  type Part = MediaPart | { text: string };
  const contents: { role: string; parts: Part[] }[] = history
    .reverse()
    .filter((m) => m.text)
    .map((m) => ({ role: m.direction === "IN" ? "user" : "model", parts: [{ text: m.text as string }] }));

  // Текущее сообщение — со вложениями, если есть; вложение впереди текста
  // (так модель разбирает файл до того, как читает вопрос про него).
  const currentParts: Part[] = [...mediaParts];
  if (text || currentParts.length === 0) currentParts.push({ text });
  const last = contents[contents.length - 1];
  if (!last || last.role !== "user") {
    contents.push({ role: "user", parts: currentParts });
  } else {
    last.parts = currentParts;
  }

  // Разбор чека — отдельный запрос, параллельно с обычным ответом: он не должен
  // задерживать разговор, а обычный ответ по промту владельца уже знает, что
  // сказать на присланный чек («Хозир мебинам» и т.п.) — здесь только решаем,
  // отправлять ли следом ссылку доступа.
  // Тот же принцип для чека: если фото ушло через File API, вердикт спрашиваем
  // тем же ключом, который его заливал.
  // Несколько фото в одном сообщении (чек + экран проверки получателя — так
  // делают часто): раньше смотрели только первое, и бот одновременно выдавал
  // ссылку по чеку и просил «прислать ещё» из-за второго фото. Теперь
  // проверяем каждое и берём лучший вердикт — pickReceiptVerdict.
  const receiptPromise: Promise<{ verdict: ReceiptVerdict; image: RescuedImage } | null> = firstImagePart
    ? Promise.all(
        imageParts.slice(0, MAX_RECEIPT_IMAGES).map(async ({ image, part }) => {
          const keys = "file_data" in part ? [primaryKey] : apiKeys;
          const verdict = await checkReceipt(part, model, keys);
          return verdict ? { verdict, image } : null;
        })
      ).then(pickReceiptVerdict)
    : Promise.resolve(null);

  const generate = (systemPrompt: string) => {
    const startedAt = Date.now();
    return generateWithFallback(
      keysForGenerate,
      model,
      (m) =>
        JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { thinkingConfig: thinkingConfigFor(m), maxOutputTokens: 500 },
        }),
      timeout
    ).then((r) => {
      if ("error" in r) void logAiCall({ endpoint: "ai-reply", ms: Date.now() - startedAt, ok: false });
      else void logAiCall({ endpoint: "ai-reply", model: r.model, usage: r.usage, ms: Date.now() - startedAt, ok: true });
      return r;
    });
  };

  const result = await generate(prompt);
  if ("error" in result) {
    logError("ai:reply", result.error);
    // Ни разу не ответили — раньше здесь была тишина навсегда (см. aiReplyRetry.ts).
    // Кладём ход в очередь: фоновый тик попробует снова, пока не получится или не
    // кончатся попытки (~13 часов), и владелец узнает, только если так и не вышло.
    await queuePendingAiReply(contact.id, text).catch((err) => logError("aiReplyRetry:queue", err));
  } else {
    await recordAiCall(contact.id);
    // Пустой ответ — иногда штатный исход: промт сам просит модель промолчать
    // (например, на присланное фото без подписи, которое не про десерт).
    // Отправка обёрнута нарочно: отказ Meta (закрылось окно 24 ч, 429) не должен
    // уносить с собой разбор чека, который ждёт ниже — он дороже ответа.
    const replyText = result.text ? await enforceReplyLanguage(contact, text, language, result.text, prompt, generate) : null;
    if (replyText) {
      try {
        // Несколько коротких сообщений вместо одного полотна — см. splitReplyParts.
        // Паузу между ними держит sendText сам (человеческий темп набора; на
        // сайте паузы нет — см. messaging/send.ts).
        for (const part of splitReplyParts(replyText)) {
          const mid = await sendToContact(contact, part);
          await recordOutgoingMessage(contact.id, part, mid);
        }
        // Реалтайм-версия «где бот застрял» — см. stuckAlert.ts. Fire-and-forget,
        // как markStartedLearningIfReplied выше: сбой здесь не должен трогать
        // уже отправленный ответ.
        notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      } catch (err) {
        logError("ai:send", err);
      }
    }
  }

  const picked = await receiptPromise;
  const verdict = picked?.verdict ?? null;
  const firstImage = picked?.image ?? null;
  // Остальные фото сообщения (не выбранные) больше не чеки в очереди — иначе
  // фоновая перепроверка разобрала бы их отдельно и снова написала клиентке.
  const otherQueued = imageParts.map((ip) => ip.image.queuedId).filter((id): id is string => Boolean(id) && id !== firstImage?.queuedId);
  if (picked && otherQueued.length > 0) {
    await prisma.receiptCheck.deleteMany({ where: { id: { in: otherQueued } } }).catch((err) => logError("ai:receiptVerdict:dropSiblings", err));
  }
  // ИИ не ответил вовсе (таймаут, кончился бюджет, сеть) — картинка уже лежит в
  // очереди (её положил rescueIncomingImages), фоновый разбор попробует ещё раз.
  if (verdict?.kind === "pre_transfer" && firstImage) {
    // Экран ДО перевода: человек проверяет, туда ли переводит. Отвечаем сами
    // и сразу — «да, номер и имя верные», без ИИ и без просьбы «прислать ещё».
    await recordAiCall(contact.id);
    if (firstImage.queuedId) {
      await prisma.receiptCheck.delete({ where: { id: firstImage.queuedId } }).catch((err) => {
        if ((err as { code?: string })?.code !== "P2025") logError("ai:receiptVerdict:preTransfer:delete", err);
      });
    }
    await confirmRequisitesToCustomer(contact, text).catch((err) => logError("ai:receiptVerdict:preTransfer", err));
  } else if (verdict && verdict.kind !== "not_receipt" && verdict.kind !== "pre_transfer" && firstImage) {
    // Тип сужается на месте, но узость не переживёт await ниже — фиксируем.
    const kind = verdict.kind;
    await recordAiCall(contact.id);
    await handleReceiptVerdict(
      contact,
      {
        kind,
        confidence: verdict.confidence,
        amount: verdict.amount,
        currency: verdict.currency,
        receiptAt: verdict.receiptAt,
        tamperingSuspected: verdict.tamperingSuspected,
        reason: verdict.reason,
        imageHash: firstImage.hash,
        imageUrl: firstImage.url,
      },
      // Обновляем строку, которую создала страховка, а не плодим вторую.
      firstImage.queuedId ?? undefined
    ).catch((err) => logError("ai:receiptVerdict", err));
  } else if (verdict?.kind === "not_receipt" && firstImage?.queuedId) {
    // Это было не чеком (фото десерта, мем) — убираем из очереди, чтобы вкладка
    // «Чеки» не зарастала шумом и фоновый разбор не тратил на него запросы.
    await prisma.receiptCheck.delete({ where: { id: firstImage.queuedId } }).catch((err) => {
      // P2025 = запись уже удалена (race с другим обработчиком) — это нормально.
      if ((err as { code?: string })?.code !== "P2025") {
        logError("ai:receiptVerdict:notReceipt:delete", err);
      }
    });
  }
}

/**
 * Ответ ИИ на комментарий под роликом, который НЕ входит в продающую воронку.
 * Тот же промт и та же защита, но доставка — приватным ответом на комментарий
 * (единственный способ написать первым тому, кто ещё не писал в директ), и без
 * кнопок: человек просто спросил что-то под роликом, продавать ему нечего.
 */
export async function aiReplyToComment(contact: Contact, commentId: string, text: string): Promise<void> {
  // Свой флаг, не aiEnabled — владелец 13.09.2026 попросил заглушить обычный
  // ИИ-ответ в директе, но оставить живыми ответы под комментариями; общий
  // флаг гасил бы оба сразу.
  const enabled = (await getSetting("aiCommentRepliesEnabled")) === "true";
  if (!enabled) return;
  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) {
    logError("ai:aiReplyToComment:noGeminiKeys", new Error("Gemini API keys not configured — comment reply skipped"));
    return;
  }

  const language = detectClientLanguage(text);
  const verdict = guardOffTopic(text);
  if (verdict) {
    // «Пустите бесплатно» и назойливое дёрганье под роликом — молчим совсем.
    if (isSilentKind(verdict.kind)) return;
    // Под роликом отвечаем шаблоном ровно один раз и не спорим дальше: в
    // комментариях нет «разговора», в который бот мог бы встрять повторно.
    await sendPrivateReply(commentId, guardReply(verdict.kind, language), [], metaChannelOf(contact)).catch((err) => {
      logError("ai:commentGuard:sendPrivateReply", err);
    });
    return;
  }
  if (await isBudgetExceeded(contact.id)) return;

  // Комментарий — это всегда текст, голосовых под роликами не бывает: модель
  // обычная, время обычное.
  const prompt = await buildSystemPrompt();
  const model = (await getSetting("aiModel")) || "gemini-3.7-flash";

  const startedAt = Date.now();
  const result = await generateWithFallback(
    apiKeys,
    model,
    (m) =>
      JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  `Человек написал это комментарием под нашим роликом в Instagram (не в личке): «${text}». ` +
                  "Ответь коротко и по-человечески, как обычный живой ответ под постом. НЕ продавай жёстко, " +
                  "не перечисляй все курсы и цены, не проси купить — просто ответь на то, что человек написал.",
              },
            ],
          },
        ],
        // 300 было впритык: живая проверка 22.08.2026 показала, что даже
        // thinkingLevel:"low" тратит на "размышление" по этому промту ~290
        // токенов сам по себе — на видимый ответ оставалось десять с небольшим,
        // и Gemini обрывался финишем MAX_TOKENS (см. gemini.ts — теперь это
        // само по себе перехватывается, но лучше не упираться в лимит вообще).
        generationConfig: { thinkingConfig: thinkingConfigFor(m), maxOutputTokens: 900 },
      }),
    TIMEOUT_MS
  );
  if ("error" in result) {
    logError("ai:commentReply", result.error);
    void logAiCall({ endpoint: "comment-reply", ms: Date.now() - startedAt, ok: false });
    return;
  }
  void logAiCall({ endpoint: "comment-reply", model: result.model, usage: result.usage, ms: Date.now() - startedAt, ok: true });
  await recordAiCall(contact.id);
  if (!result.text) return;

  const mid = await sendPrivateReply(commentId, result.text, [], metaChannelOf(contact));
  await recordOutgoingMessage(contact.id, result.text, mid);
}

/**
 * Похоже на настоящий чек — отправляем одноразовую ссылку в НУЖНУЮ группу (по сумме
 * на чеке: 50 сомони или 70) и помечаем клиента оплатившим. Перед этим — три
 * проверки от накрутки:
 *  1) ТОТ ЖЕ скриншот уже когда-то получал ссылку (неважно, от этого же человека
 *     или от другого, кому его переслали) — по SHA-256 самой картинки;
 *  2) дата/время НА чеке слишком старые или из будущего — пересланный старый чек,
 *     а не только что оплаченный курс;
 *  3) гонка: два сообщения с одним и тем же чеком пришли почти одновременно —
 *     атомарное условие `paid=false` в самом UPDATE не даст выдать две ссылки.
 * Сумма не читается — ссылку САМИ не угадываем, какую группу выбрать. Похоже на
 * чек, но что-то не сходится — ссылку тоже не шлём, владелец сам решает, выводить
 * человека или нет («я скам потом клиента выведу» — его прямые слова), бот здесь
 * не судья, а фильтр первого взгляда — всё видно во вкладке «Чеки».
 */
/**
 * Открывает купленные группы: на каждую — своя одноразовая ссылка, своя запись о
 * покупке. Возвращает те курсы, доступ к которым реально ушёл человеку.
 *
 * Запись о покупке создаётся ДО отправки и с уникальностью «человек+курс»: если
 * два одинаковых чека пришли почти одновременно, вторая попытка упрётся в базу и
 * второй ссылки не будет. Не удалось отправить — запись убираем, чтобы человек
 * не числился купившим то, чего не получил.
 */
// grantCourses извлечён в ai/grantCourses.ts для снижения сложности god-file.
// Реэкспорт здесь сохраняет совместимость с внешними импортами из "./ai.js".
import { grantCourses } from "./ai/grantCourses.js";
export { grantCourses };

/**
 * Клиент попросил живого человека — зовём Ширин и замолкаем.
 *
 * Обещание «сейчас она ответит» обязано быть правдой: уведомление уходит ей в
 * Telegram, а бот замолкает на то же время, что и после её собственного ответа.
 * Иначе следом за обещанием прилетел бы очередной ответ бота — и человек, уже
 * попросивший человека, получил бы ровно то, от чего отказывался.
 */
async function callOwnerToChat(contact: Contact, lastText: string): Promise<void> {
  await prisma.contact
    .update({
      where: { id: contact.id },
      data: { humanSilencedUntil: new Date(Date.now() + HUMAN_REQUESTED_SILENCE_MS) },
    })
    .catch((err) => {
      logError("ai:callOwnerToChat:silence", err);
    });

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await ownerAlertChatIds())[0]; // личный чат владельца, иначе чат сводок (telegram.ts)
  if (!botToken || !chatId) return;
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  // Кнопки быстрых ответов под уведомлением — чтобы не набирать с телефона,
  // достаточно нажать (см. quickReplies.ts, telegramWebhook.ts ветка `qr:`).
  // callback_data короткий (индекс, не текст) — лимит Telegram 64 байта.
  const quickReplies = await getQuickReplies();
  const buttons = quickReplies.map((qr, i) => [{ text: qr.label, callback_data: `qr:${contact.id}:${i}` }]);
  await sendMessageWithButtons(
    botToken,
    chatId,
    `🙋 ${who} просит поговорить с вами лично.

Последнее сообщение: «${lastText.slice(0, 200)}»

Бот замолчал, ждёт вас. Можно ответить одной из кнопок ниже — уйдёт клиенту сразу:`,
    buttons
  );
}

/** Сколько бот молчит, если клиент попросил живого человека. Дольше обычной паузы:
 *  она рассчитана на «хозяйка уже в разговоре», а тут ей ещё надо его увидеть. */
const HUMAN_REQUESTED_SILENCE_MS = 60 * 60_000;

/**
 * Запись на ОФЛАЙН-курс. Предоплаты нет — от человека нужны только имя и номер,
 * и как только они прозвучали, запись уходит сестре в Telegram СРАЗУ.
 *
 * Модели не даём «действовать»: код сам решает, состоялась запись или нет, а в
 * промт добавляется одна строка — что именно сказать. Иначе бот начнёт обещать
 * запись, которой в базе нет.
 */
/** Какой язык считаем «не тем»: русский вопрос — таджикский ответ и наоборот.
 *  Английский не трогаем: детектор ответа на латинице слишком груб, а промт с
 *  английским справляется. */
const OPPOSITE: Partial<Record<ClientLanguage, ClientLanguage>> = { ru: "tg", tg: "ru" };

const LANGUAGE_FIX: Record<"ru" | "tg", string> = {
  ru:
    "\n\nСРОЧНОЕ ИСПРАВЛЕНИЕ: клиент написал ПО-РУССКИ. Отвечай ТОЛЬКО на русском языке — " +
    "ни одного таджикского слова, ни одной таджикской фразы.",
  tg:
    "\n\nСРОЧНОЕ ИСПРАВЛЕНИЕ: клиент написал ПО-ТАДЖИКСКИ. Отвечай ТОЛЬКО по-таджикски " +
    "(разговорный душанбинский) — ни одного русского предложения.",
};

/**
 * ЯЗЫК ОТВЕТА ПРОВЕРЯЕТ КОД, А НЕ ТОЛЬКО ПРОМТ (05.09.2026).
 *
 * Правило 3 в ALWAYS_RULES стоит давно, и всё же живой прогон показал: после
 * нескольких русских сообщений подряд модель уходит в таджикский. Русская
 * покупательница в этот момент решает, что ей ответил автомат, и уходит.
 *
 * Схема: ответ не на языке вопроса — один повторный ход с прямым приказом в
 * системном промте. Снова не тот — отдаём то, что есть (ответ хуже молчания
 * только в этом одном случае, а молчать после оплаты нельзя), и пишем
 * предупреждение в лог. Никаких циклов: максимум два хода на сообщение.
 */
async function enforceReplyLanguage(
  contact: Contact,
  incoming: string,
  language: ClientLanguage,
  reply: string,
  prompt: string,
  generate: (systemPrompt: string) => Promise<{ text: string | null } | { error: string }>
): Promise<string> {
  const wrong = OPPOSITE[language];
  if (!wrong || !incoming.trim()) return reply;
  if (detectReplyLanguage(reply) !== wrong) return reply;

  const retry = await generate(prompt + LANGUAGE_FIX[language as "ru" | "tg"]);
  if ("error" in retry || !retry.text) {
    logWarn("ai:languageMismatch", `${contact.id}: ответ не на языке клиента (${language}), повтор не удался — отдаю как есть`);
    return reply;
  }
  await recordAiCall(contact.id);
  if (detectReplyLanguage(retry.text) === wrong) {
    logWarn("ai:languageMismatch", `${contact.id}: ответ снова не на языке клиента (${language}) после повтора — отдаю повторный`);
  }
  return retry.text;
}

/**
 * Клиентка пишет с сайта shirinsweets.online, а не из Instagram. Промт
 * владельца писался под директ и Telegram-группы: «добавлю вас в группу»,
 * «уроки в Телеграме». На сайте это ложь — уроки открываются по ссылке на
 * самом сайте, а ссылка приходит прямо в этот чат после чека. Не трогаем
 * промт владельца, а добавляем поправку только для канала WEB.
 */
function webChannelBlock(contact: Contact): string {
  if (contact.channel !== "WEB") return "";
  return (
    "\n\nВАЖНО — КАНАЛ: клиентка пишет в чат на нашем сайте shirinsweets.online. " +
    "Онлайн-уроки открываются ПРЯМО НА САЙТЕ по личной ссылке, в телефоне, без Telegram и без групп. " +
    "Никогда не говори «в Телеграме», «добавлю в группу», «пришлю ссылку на группу». " +
    "После оплаты попроси прислать чек прямо сюда, в этот чат: ссылка на уроки придёт сюда же автоматически. " +
    "Уроки можно смотреть с любого телефона, сохранять офлайн, в конце — сертификат."
  );
}

/**
 * Детерминированная запись на офлайн-курс ДО хода модели (webhook.ts). Раньше
 * запись жила только внутри offlineSignupBlock, а до него не доходили ходы,
 * перехваченные воронкой, guard-ом, паузой хозяйки или бюджетом — в сводке
 * «записались на офлайн» стояло 0 при живых желающих (владелец 05.09.2026).
 * Условие то же: в тексте номер телефона, а желание офлайна — в этом или
 * недавних сообщениях.
 */
export async function registerOfflineIfAsked(contact: Contact, text: string | null): Promise<boolean> {
  if (!text || contact.paid) return false;
  if (!WANTS_OFFLINE_RE.test(text) && !(await recentIncomingWantsOffline(contact.id))) return false;
  return registerOfflineSignup(contact, text);
}

async function offlineSignupBlock(contact: Contact, text: string): Promise<string> {
  if (!text) return "";
  if (!WANTS_OFFLINE_RE.test(text)) {
    // Человек мог написать номер отдельным сообщением, уже после просьбы записать.
    const asked = await recentIncomingWantsOffline(contact.id);
    if (!asked) return "";
  }

  const date = await courseDateLabel();

  const registered = await registerOfflineSignup(contact, text);
  if (registered) {
    return `\n\nВАЖНО СЕЙЧАС: человека уже ЗАПИСАЛИ на офлайн-курс (${date}). Коротко подтверди это, скажи, что предоплаты не нужно и что за день до курса ему позвонят. Больше ничего не спрашивай.`;
  }

  // Условия набора уходят ОТДЕЛЬНЫМ сообщением и дословно так, как их написал
  // владелец (см. ai/offlineCourse.ts). Пересказывать их модели нельзя: она
  // меняет порядок, теряет адрес и сливает всё в абзац, который на телефоне
  // просто не читают.
  const cardSent = await maybeSendOfflineCard(contact, text);
  return cardSent
    ? `\n\nВАЖНО СЕЙЧАС: человеку УЖЕ отправлено отдельное сообщение со всеми условиями офлайн-курса — цена, даты, адрес. Не повторяй их. Одной короткой фразой попроси имя и номер телефона для записи.`
    : `\n\nВАЖНО СЕЙЧАС: человек хочет на ОФЛАЙН-курс (${date}). Попроси у него имя и номер телефона одним коротким сообщением. Предоплаты нет — про оплату не заговаривай.`;
}

/**
 * ОФЛАЙН-КУРС В ДУШАНБЕ — значения по умолчанию.
 *
 * Живут в коде только как запасной вариант: набор меняется каждый месяц, и
 * править его должен владелец в панели (Настройки → «Офлайн-курс»), а не
 * программист деплоем. Здесь то, что действует на 03.09.2026 — чтобы после
 * обновления бот сразу говорил правду, даже пока владелец не заглянул в панель.
 */

/** Просьба записать на курс — по-таджикски и по-русски. */
const WANTS_OFFLINE_RE =
  /(запиш|записат|записыва|навис(ед|ет|ен)|сабт|ба курс мехохам|хочу на курс|офлайн|оффлайн|дар назди ман|назди худат)/i;

/**
 * Шёл ли недавно разговор про офлайн-курс — по сообщениям В ОБЕ СТОРОНЫ.
 * Раньше смотрели только на входящие: если офлайн упомянул БОТ («офлайн курс
 * хеле хуб аст...»), а человек дальше просто спрашивал «кай мешава» (когда)
 * без слова «офлайн», дату в промт не подставляли — модель осталась без
 * фактов и один раз придумала число (владелец 06.09.2026, живой чек Ширин
 * поймала и поправила клиента вручную). Окно шире (10, не 4): направления
 * чередуются, и той же глубины в парах реплик уже не хватает.
 */
export async function recentIncomingWantsOffline(contactId: string): Promise<boolean> {
  const recent = await prisma.message.findMany({
    where: { contactId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { text: true },
  });
  return recent.some((m) => m.text && WANTS_OFFLINE_RE.test(m.text));
}

/**
 * Человек уже купил один или оба курса, а разговор снова про курс/оплату —
 * предупреждаем МОДЕЛЬ заранее, а не только код на этапе разбора чека.
 *
 * Живой случай 23.08: покупательница уже забрала оба курса, но переписка
 * дальше шла как с новым человеком (реквизиты, «пришлите чек»), и она
 * заплатила третий раз, никто не заметил. `allocate()` в courses.ts уже не
 * даст выдать доступ повторно на этапе чека — но это срабатывает, только
 * когда чек УЖЕ прислан и деньги УЖЕ ушли. Эта проверка — до оплаты: пока
 * человек ещё спрашивает цену/реквизиты, а не после того как заплатил.
 *
 * Дешёвый ранний выход: ABOUT_COURSE — тот же самый признак «речь о курсе»,
 * что и в offTopicGuard, чтобы не дёргать базу на каждом «спасибо» и «ок».
 */
async function alreadyOwnedBlock(contact: Contact, text: string): Promise<string> {
  if (!text || !ABOUT_COURSE.test(text)) return "";
  const owned = await ownedCourses(contact.id);
  if (owned.length === 0) return "";

  if (owned.includes(COURSE_50) && owned.includes(COURSE_70)) {
    return (
      "\n\nВАЖНО СЕЙЧАС: человек УЖЕ купил ОБА курса (Арт-десерты и 21 рецепт) — доступ в обеих " +
      "Телеграм-группах у него уже есть. НЕ отправляй реквизиты оплаты и не проси чек — скажи, что доступ " +
      "уже выдан, и предложи написать в группу, если что-то не открывается."
    );
  }
  const already = owned.includes(COURSE_50) ? COURSE_TITLE[COURSE_50] : COURSE_TITLE[COURSE_70];
  const other = owned.includes(COURSE_50) ? COURSE_TITLE[COURSE_70] : COURSE_TITLE[COURSE_50];
  return (
    `\n\nВАЖНО СЕЙЧАС: человек уже купил курс «${already}» — доступ у него уже есть, второй раз за него не ` +
    `проси оплату. Если спрашивает именно про этот курс — скажи, что доступ уже выдан. Если хочет ВТОРОЙ курс ` +
    `«${other}» — это можно, продолжай как обычно.`
  );
}

/**
 * Новый, ещё не разговорившийся человек — мягкая подсказка предложить бесплатный
 * пример урока РАНЬШЕ, чем заходить про оплату.
 *
 * Промт владельца уже разрешает делиться бесплатным примером (ссылка — его, не
 * наша, и меняться может в любой момент — здесь её нарочно нет и не будет), но
 * только РЕАКТИВНО, когда человек сам засомневался. Ранний разговор — тот
 * момент, когда сомнение чаще всего ещё не озвучено словами, а просто есть.
 * Подсказка не обязывает ничего конкретного — «не навязывай» в духе ALWAYS_RULES.
 *
 * Холодный = первое-второе сообщение за всю историю переписки и ещё не купил.
 * Дешёвый ранний выход до счёта в базе: нет текста — разговора ещё нет вовсе.
 */
async function coldLeadNudge(contact: Contact, text: string): Promise<string> {
  if (!text) return "";
  if (contact.paid) return ""; // уже купил — греть незачем
  const incomingCount = await prisma.message.count({ where: { contactId: contact.id, direction: "IN" } });
  if (incomingCount > 2) return ""; // это уже не первое знакомство, а обычный разговор
  return (
    "\n\nВАЖНО СЕЙЧАС: это самое начало разговора с новым человеком. Сначала пойми, что ему нужно, " +
    "ответь на его вопрос, покажи, что уроки настоящие (сайт shirinsweets.online, что внутри курса), и " +
    "только потом — про оплату. Пробного урока и демо-доступа НЕ существует (правило 16) — не предлагай. " +
    "Не навязывай, просто держи это в голове."
  );
}

/**
 * Честное социальное доказательство — сколько человек РЕАЛЬНО купили курс за
 * последнюю неделю. Число настоящее (из Purchase), не выдуманное: соврать про
 * цифру продаж — репутационный риск похуже, чем вообще её не упомянуть.
 *
 * Ноль покупок за неделю говорит против школы, а не за неё — в этом случае
 * блок просто пустой, как и остальные необязательные блоки промта.
 */
async function buildSocialProofBlock(): Promise<string> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const count = await prisma.purchase.count({ where: { createdAt: { gte: sevenDaysAgo } } });
  if (count === 0) return "";
  return (
    `\n\nФАКТ (можно упомянуть, если к месту, НЕ в каждом сообщении и НЕ как давление): на этой неделе ` +
    `курс купили ${count} человек. Упоминай только естественно — например, если человек колеблется или ` +
    `спрашивает, стоит ли пробовать. Никогда не называй другое число.`
  );
}

// handleReceiptVerdict извлечён в ai/receiptVerdict.ts для снижения сложности god-file.
// Реэкспорт здесь сохраняет совместимость с внешними импортами из "./ai.js".
import { confirmRequisitesToCustomer, handleReceiptVerdict } from "./ai/receiptVerdict.js";
export { handleReceiptVerdict };

