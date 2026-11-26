import { handleDeliveryChoiceReply, rememberDeliveryPreference } from "./course/deliveryChoice.js";
import {
  replyPolicyIssues,
  cleanAutomatedReply,
  cleanGeneratedReply,
  REPLY_POLICY_INSTRUCTION,
  ReplyPolicyError,
  CONTEXT_ONLY_AMOUNT,
  COURSE_DATE_FACT,
  isAskShirin,
} from "./ai/replyPolicy.js";
import { detectFaq, replyToInstagramFaq } from "./ai/instagramFaqReply.js";
import {
  hasDeliveredAccess,
  loadRepeatContext,
  withoutRepeats,
  mentionsPaymentPhone,
  regenerateAfterFilters,
  releaseRequisitesClaim,
} from "./ai/repeatGuard.js";
import { replyDeliveryMode, deliveryPrompt, videoHelpPrompt } from "./ai/deliveryContext.js";
import crypto from "node:crypto";
import { prisma, getSetting, logError, logInfo, logWarn, recordOutgoingMessage } from "./db.js";
import { applyRequisitesOffer } from "./ai/requisitesOffer.js";
import { sendToContact, sendPrivateReplyRecorded } from "./messaging/send.js";
import { recordNoReply, policyNoReplyReason, type NoReplyReason } from "./messaging/noReply.js";
import { humanizeForContact } from "./messaging/humanize.js";
import { withoutAddressWords, withoutStockTails } from "./ai/humanText.js";
import {
  isBotFrozen,
  assertAutomationAllowed,
  contactAutomationBlocked,
  askedHumanSilenceUntil,
} from "./messaging/automation.js";
import {
  guardOffTopic,
  guardReply,
  isGuardReply,
  isSilentKind,
  MAX_GUARD_REPLIES,
  MAX_RECIPE_REPLIES,
  ABOUT_COURSE,
  detectMenuQuestion,
} from "./ai/offTopicGuard.js";
import { sendMenuImages, maybeSendCourseMenuPhoto, sendOfflineMenuPhoto } from "./ai/menuImages.js";
import { maybeSendVideos } from "./ai/videoLibrary.js";
import { trySendVoiceReply } from "./ai/voiceReply.js";
import { freeLessonBlock } from "./ai/freeLessonHook.js";
import { findReusableMedia, sendReusedMedia } from "./ai/mediaReuse.js";
import { detectReplyLanguage, languageSignal, type ClientLanguage } from "./ai/clientLanguage.js";
import { contactLanguage } from "./ai/contactLanguage.js";
import { claimsReceiptSent, receiptNotSeenReply } from "./ai/receiptClaim.js";
import { BUDGET_FALLBACK } from "./ai/prompts.js";
import { buildSystemPrompt, getSalesTexts, getOfflineFacts } from "./services/salesTextsService.js";
import { isBudgetExceeded, recordAiCall } from "./ai/dailyBudget.js";
import { fetchAttachment, buildMediaPart, type Attachment, type MediaPart } from "./ai/media.js";
import { checkReceipt, pickReceiptVerdict, type ReceiptVerdict } from "./ai/receiptCheck.js";
import { queueUncheckedReceipt } from "./receiptRetry.js";
import { queuePendingAiReply } from "./aiReplyRetry.js";
import { logAiCall } from "./ai/aiLog.js";
import { registerOfflineSignup, extractPhone } from "./ai/offlineSignup.js";
import { maybeSendOfflineCard, offlineFactsForModel } from "./ai/offlineCourse.js";
import {
  offlineHandoffGate,
  offlineHandoffEnabled,
  asksOnlineNotOffline,
  enterOfflineHandoff,
  explicitOfflineInterest,
  replyHasOfflineFacts,
} from "./ai/offlineHandoff.js";
import { getPrices } from "./services/priceService.js";
import { courseDateLabel } from "./ai/courseDate.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { buildStyleBlock } from "./ai/styleLearning.js";
import { sendKind } from "./notify.js";
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
import { maybeWarmEmoji } from "./voice.js";
import { splitHumanLike, splitOptionsFor } from "./ai/replySplit.js";
import { passesRelevanceGate } from "./ai/relevanceGate.js";
import { reactInsteadOfReply } from "./ai/reactions.js";
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
  if (await isBotFrozen()) return [];
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
  await assertAutomationAllowed();
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

/**
 * ПРОВЕРИТЬ ЧЕК СЕЙЧАС, БЕЗ ТЕКСТОВОГО ОТВЕТА (владелец 11.11.2026, «чек при Ширин»).
 *
 * Ширин переписывается с клиентом (пауза бота), а тот прислал чек. Раньше
 * картинка только вставала в очередь, и фоновая перепроверка разбирала её через
 * 3+ минуты; Ширин за это время отправляла ссылку руками, и владельцу уходила
 * карточка «похоже, Ширин уже отправила ссылку вне системы». Теперь чек
 * разбирается сразу тем же путём, что в aiReply: настоящий чек на наш номер и
 * верную сумму — ссылка уходит сама (дверь verified_receipt_access), сомнительный
 * — карточка владельцу. Не получилось разобрать (нет ключей, сбой модели) —
 * картинка остаётся в очереди, фоновый разбор попробует снова.
 */
export async function verifyReceiptsNow(contact: Contact, images: RescuedImage[]): Promise<void> {
  if (images.length === 0 || (await isBotFrozen())) return;
  const apiKeys = await resolveGeminiKeys();
  // Нет ключей или кончился дневной бюджет — чек остаётся в очереди фонового разбора.
  if (apiKeys.length === 0 || (await isBudgetExceeded(contact.id))) return;
  const model = (await getSetting("aiModel")) || "gemini-3.6-flash";
  const parts: { image: RescuedImage; part: MediaPart }[] = [];
  for (const image of images.slice(0, MAX_RECEIPT_IMAGES)) {
    const part = await buildMediaPart(image.buffer, image.mimeType, apiKeys[0]).catch((err: unknown) => {
      logError("ai:verifyReceiptsNow:part", err);
      return null;
    });
    if (part) parts.push({ image, part });
  }
  if (parts.length === 0) return;
  const picked = pickReceiptVerdict(
    await Promise.all(
      parts.map(async ({ image, part }) => {
        const verdict = await checkReceipt(part, model, "file_data" in part ? [apiKeys[0]] : apiKeys);
        return verdict ? { verdict, image } : null;
      }),
    ),
  );
  if (!picked || (await isBotFrozen())) return;
  await recordAiCall(contact.id);
  const { verdict, image } = picked;
  const siblings = parts
    .map((p) => p.image.queuedId)
    .filter((id): id is string => Boolean(id) && id !== image.queuedId);
  if (siblings.length > 0) {
    await prisma.receiptCheck
      .deleteMany({ where: { id: { in: siblings } } })
      .catch((err) => logError("ai:verifyReceiptsNow:siblings", err));
  }
  if (verdict.kind === "not_receipt" || verdict.kind === "pre_transfer") {
    // Фото десерта или экран ДО перевода: Ширин в разговоре, ответит сама.
    if (image.queuedId) {
      await prisma.receiptCheck.delete({ where: { id: image.queuedId } }).catch((err) => {
        if ((err as { code?: string })?.code !== "P2025") logError("ai:verifyReceiptsNow:drop", err);
      });
    }
    return;
  }
  await handleReceiptVerdict(
    contact,
    {
      kind: verdict.kind,
      confidence: verdict.confidence,
      amount: verdict.amount,
      currency: verdict.currency,
      receiptAt: verdict.receiptAt,
      tamperingSuspected: verdict.tamperingSuspected,
      recipientMatches: verdict.recipientMatches,
      transactionId: verdict.transactionId,
      reason: verdict.reason,
      imageHash: image.hash,
      imageUrl: image.url,
    },
    image.queuedId ?? undefined,
  );
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
  rescuedImages: RescuedImage[] = [],
  opts: TurnOptions = {},
): Promise<void> {
  // СЛЕД КАЖДОГО МОЛЧАНИЯ (аудит 15.11.2026): ход кончился, а клиенту ничего не
  // ушло — пишем причину в журнал решений (messaging/noReply.ts). По нему аудит
  // видит «почему», а сторож unansweredWatch.ts отличает решение от потери.
  const startedAt = new Date();
  let reason: NoReplyReason | "relevance_gate" | undefined;
  try {
    reason = await answerTurn(contact, text, attachments, rescuedImages, opts);
  } catch (err) {
    // WhatsApp повторяет ход сам (whatsapp/worker.ts) — строка на каждую попытку была бы шумом.
    if (contact.channel !== "WHATSAPP") await traceIfUnanswered(contact, startedAt, text, "send_failed");
    throw err;
  }
  // Фильтр «не по делу» сам пишет своё решение (relevanceGate.ts) — второй строки не нужно.
  if (reason !== "relevance_gate") await traceIfUnanswered(contact, startedAt, text, reason ?? "unknown");
}

/** Ход закончился без исходящего — записать причину. Ответ ушёл (текст, фото, ссылка) — ничего. */
async function traceIfUnanswered(
  contact: Contact,
  startedAt: Date,
  text: string,
  reason: NoReplyReason,
): Promise<void> {
  try {
    const sent = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "OUT", createdAt: { gte: startedAt } },
      select: { id: true },
    });
    if (sent) return;
  } catch (err) {
    logError("ai:traceNoReply", err);
  }
  await recordNoReply(contact, reason, text);
}

/** Ход сторожа «без ответа»: сколько клиент уже ждёт (для извинения за задержку). */
export type TurnOptions = { waitedMs?: number };

/** Ждал дольше — бот начинает с короткого извинения (ревью 15.11.2026). */
export const LATE_REPLY_AFTER_MS = 2 * 3_600_000;
export const LATE_REPLY_HINT =
  "\nКлиент ждал ответа больше двух часов. Начните ответ с одной короткой фразы-извинения за задержку " +
  "на языке клиента, строго на «вы» (по-таджикски — «шумо»), и сразу ответьте по сути.";

async function answerTurn(
  contact: Contact,
  text: string,
  attachments: Attachment[],
  rescuedImages: RescuedImage[],
  opts: TurnOptions = {},
): Promise<NoReplyReason | "relevance_gate" | undefined> {
  // ЭКСТРЕННАЯ ПАУЗА (владелец 13.09.2026): «всё, кроме воронки». Гасит и
  // выдачу ссылки на курс (maybeRestoreAccess ниже — обычно работает ДАЖЕ при
  // выключенном aiEnabled, см. её комментарий), и отзыв-скриншот, и сам ИИ-ответ
  // одним ранним выходом. Воронка (funnel.ts) вызывается из webhook.ts до
  // aiReply и этой проверки не видит вовсе — её выключить нельзя тем же флагом.
  if ((await getSetting("botFrozen")) === "true") return "frozen";
  if (contactAutomationBlocked(contact)) return policyNoReplyReason(contact);

  if (text && (await handleDeliveryChoiceReply(contact, text))) return;

  // ПАУЗА «ПО ОФЛАЙН-КУРСАМ НЕ ОТВЕЧАЕМ» (владелец 22.11.2026, временно): см. offlineRepliesPausedFor.
  if (await offlineRepliesPausedFor(contact, text)) return "offline_handoff";

  // «ОФЛАЙН: ПЕРЕДАНО ШИРИН» (владелец 08.11.2026, ai/offlineHandoff.ts): после
  // карточки офлайн-курса бот с этим человеком молчит — ни текста, ни голоса —
  // пока тот не напишет про онлайн. Воронка и запись номера на офлайн живут в
  // webhook.ts выше и сюда не доходят, их это не трогает.
  if ((await offlineHandoffGate(contact, text)) === "silent") return "offline_handoff";

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
  if (text || images.length > 0) {
    const recovery = await maybeRestoreAccess(
      contact,
      text ?? "",
      images.map((i) => i.hash),
    ).catch((err) => {
      logError("ai:recovery", err);
      return { handled: false as const };
    });
    // Разобрано — молчим: иначе поверх выданной ссылки консультант скажет своё,
    // и человек получит два разных ответа на один вопрос.
    if (recovery.handled) return;
  }

  const enabled = (await getSetting("aiEnabled")) === "true";
  if (!enabled) return "ai_off";
  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) {
    logError("ai:aiReply:noGeminiKeys", new Error("Gemini API keys not configured — AI reply skipped"));
    if (contact.channel === "WHATSAPP") throw new Error("WhatsAppGenerationRetry: no keys");
    return "no_keys";
  }
  const primaryKey = apiKeys[0];

  // Голосовое WhatsApp приходит с пустым текстом, а «Салом» пишут на любом языке:
  // язык — по единой цепочке (ai/contactLanguage.ts): сообщение → прошлые сообщения
  // клиента → язык с сайта → русский. Проверка языка ответа включается только при
  // явном сигнале в самом сообщении (ownLanguage).
  const ownLanguage = languageSignal(text ?? "");
  const language = ownLanguage ?? (await contactLanguage(contact.id));

  // Готовый вопрос Instagram или рекламы («Как долго доступен курс?» и др.): точный
  // ответ из фактов, без хода модели (ai/instagramFaq.ts, владелец 11.11.2026).
  // Первым сообщением на него отвечает воронка вместе с меню (funnel.ts); сюда он
  // доходит, когда меню уже было. Язык таджикский, пока человек сам не писал
  // по-русски (16.11.2026): вопрос нажат кнопкой, это не его слова.
  const faq = await detectFaq(text);
  if (faq && attachments.length === 0) {
    await replyToInstagramFaq(contact, faq, { withMenu: false });
    return;
  }

  // «Телеграм надорам», «ватсап мешавад?» — запомнить «уроки на сайте» до оплаты
  // (course/deliveryChoice.ts); ответ модели ниже это учтёт (deliveryPrompt).
  if (text) await rememberDeliveryPreference(contact, text).catch((err) => logError("ai:deliveryPreference", err));

  // «Не по делу — молчать»: новому собеседнику сначала проверяем, что он вообще
  // пишет про школу (ai/relevanceGate.ts). Курьеру, знакомой и магазину не отвечаем.
  if (!(await passesRelevanceGate(contact, text, attachments, images.length > 0, language))) return "relevance_gate";

  // «Спасибо» без вопроса — живой человек ставит сердечко, а не пишет ещё одно сообщение (ai/reactions.ts).
  if (attachments.length === 0 && images.length === 0 && (await reactInsteadOfReply(contact, text))) return "reaction";

  // «Я отправила чек» — а картинки в сообщении нет и в этот ход ничего не
  // спасено. Модели такое не показываем: она верит слову «чек» и отвечает
  // «принято, открываю» (живой прогон 05.09.2026). Ответ детерминированный,
  // см. ai/receiptClaim.ts.
  // Уже оплатил ЭТОТ курс — чек у него больше не просим никогда (пункт 5; по курсу, а не по человеку:
  // купивший «21 рецепт» и платящий за арт-десерты получает обычный ответ про чек).
  // Такое «я оплатила» отвечает модель с блоком «доступ уже выдан».
  const deliveredAccess = await hasDeliveredAccess(contact.id, text);
  if (
    text &&
    claimsReceiptSent(text) &&
    !deliveredAccess &&
    !attachments.some((a) => a.kind === "image") &&
    images.length === 0
  ) {
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
      if (isSilentKind(verdict.kind)) return "guard_silent";
      const isRecipe = verdict.kind === "recipe_question";
      const limit = isRecipe ? MAX_RECIPE_REPLIES : MAX_GUARD_REPLIES;
      const recent = await recentOutgoingTexts(contact.id, isRecipe ? 50 : MAX_GUARD_REPLIES);
      const said = recent.filter((t) => isGuardReply(t, isRecipe ? "recipe_question" : undefined)).length;
      if (said >= limit) return "guard_limit"; // уже сказали — дальше отвечает сама Ширин, бот молчит
      // Звать в закрытый телеграм-чат можно только тем, кто оплатил курс:
      // группа закрытая, и приглашать туда всех подряд нельзя (см. guardReply).
      const isStudent =
        isRecipe &&
        // revokedAt: доступ отозвали — человек больше не ученица, и звать её в
        // закрытый чат снова нельзя.
        (await prisma.purchase.count({ where: { contactId: contact.id, revokedAt: null } })) > 0;
      const reply = guardReply(verdict.kind, language, isStudent, await replyDeliveryMode(contact));
      // Обещали позвать Ширин — СНАЧАЛА ответ клиенту, потом тишина (см. callOwnerToChat).
      // Раньше тишина ставилась первой, и дверь отправки не пропускала само «Ширин
      // скоро ответит»: клиент, попросивший человека, не получал ничего.
      try {
        const mid = await sendToContact(contact, reply);
        await recordOutgoingMessage(contact.id, reply, mid);
      } finally {
        // Ширин зовём, даже если само «Ширин скоро ответит» не ушло (сбой Meta).
        if (verdict.kind === "wants_human") await callOwnerToChat(contact, text);
      }
      // Реалтайм-версия «где бот застрял» (см. stuckAlert.ts) — заглушка
      // офф-топика тоже полноценный ответ бота, и именно на неё чаще всего
      // натыкается человек, чей вопрос бот раз за разом не понимает.
      notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      return;
    }

    // Просят список десертов курса — код отвечает готовой картинкой-меню, а не
    // модель полотном текста (см. detectMenuQuestion). Настоящий ход модели
    // сюда не доходит вовсе — то же рассуждение, что у guardOffTopic выше.
    // Все фото уже уходили этому человеку — тогда коротко отвечает модель.
    if (detectMenuQuestion(text) && (await sendMenuImages(contact, text))) {
      notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      return;
    }

    // Библиотека видео (ai/videoLibrary.ts): ролик названного десерта, подборка или «как смотреть
    // онлайн-урок». Рубильник videoLibraryEnabled; не больше одного показа каждого вида за разговор.
    // Явная просьба показать — ролик вместо ответа модели; просто упомянули десерт — ролик вдобавок.
    if ((await maybeSendVideos(contact, text, { hasAttachments: attachments.length > 0 })) === "replace") {
      notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      return;
    }

    // Фаза 2 «максимального использования архива» — на похожий вопрос шлём её
    // реальный одобренный голос/фото/видео вместо хода модели (см. ai/mediaReuse.ts).
    // Ничего не подошло — самый частый случай, отвечает модель как обычно.
    const reusableMedia = await findReusableMedia(text);
    if (reusableMedia) {
      // false = отправлять нечего: пример голосовой, а голосовые ответы
      // выключены. Молчать нельзя — вопрос уходит модели, клиент получает текст.
      const sent = await sendReusedMedia(contact, reusableMedia);
      if (sent) {
        notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
        return;
      }
    }
  }

  if (await isBudgetExceeded(contact.id)) {
    const reply = BUDGET_FALLBACK[language];
    const mid = await sendToContact(contact, reply);
    await recordOutgoingMessage(contact.id, reply, mid);
    notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
    return;
  }

  // Интерес к ОФЛАЙН-курсу: карточка с условиями уходит одна, без хода модели,
  // и дальше разговор ведёт Ширин (ai/offlineHandoff.ts). Стоит после меню и
  // архива, чтобы «что готовим на офлайне?» по-прежнему отвечала картинка меню.
  if (text && (await sendOfflineCardAndHandOff(contact, text))) {
    notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
    return;
  }

  // Промт владельца + живые образцы его собственных ответов (самообучение —
  // см. ai/styleLearning.ts). Сам промт не переписывается никогда.
  // Промт владельца + незыблемые правила с текущими ценами/реквизитами из
  // раздела «Тексты и цены» (services/salesTextsService.ts).
  const prompt =
    (await buildSystemPrompt()) +
    (await buildStyleBlock(text, language)) +
    (await buildInsightsBlock()) +
    (await buildObjectionsBlock()) +
    (await buildSocialProofBlock()) +
    (await alreadyOwnedBlock(contact, text)) +
    (await coldLeadNudge(contact, text)) +
    (await offlineSignupBlock(contact, text)) +
    (await freeLessonBlock()) +
    webChannelBlock(contact) +
    (await deliveryPrompt(contact)) +
    (await videoHelpPrompt()) +
    ((opts.waitedMs ?? 0) >= LATE_REPLY_AFTER_MS ? LATE_REPLY_HINT : "") +
    REPLY_POLICY_INSTRUCTION;
  // gemini-2.5-flash закрыта Google (404 на каждый вызов) — та же модель, что
  // сейчас реально отвечает в основной CRM (см. GEMINI_MODEL там).
  let model = (await getSetting("aiModel")) || "gemini-3.6-flash";
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
    const downloaded = cached ? { buffer: cached.buffer, mimeType: cached.mimeType } : await fetchAttachment(att.url);
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
        }),
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
      timeout,
    ).then((r) => {
      if ("error" in r) void logAiCall({ endpoint: "ai-reply", ms: Date.now() - startedAt, ok: false });
      else
        void logAiCall({ endpoint: "ai-reply", model: r.model, usage: r.usage, ms: Date.now() - startedAt, ok: true });
      return r;
    });
  };

  let deliveryFailure: unknown = null;
  // Почему этот ход может кончиться без ответа — для журнала (aiReply выше).
  let silence: NoReplyReason | undefined;
  const result = await generate(prompt);
  if ("error" in result) {
    logError("ai:reply", result.error);
    // Ни разу не ответили — раньше здесь была тишина навсегда (см. aiReplyRetry.ts).
    // Кладём ход в очередь: фоновый тик попробует снова, пока не получится или не
    // кончатся попытки (~13 часов), и владелец узнает, только если так и не вышло.
    if (contact.channel === "WHATSAPP") throw new Error("WhatsAppGenerationRetry: generation unavailable");
    await queuePendingAiReply(contact.id, text).catch((err) => logError("aiReplyRetry:queue", err));
    silence = "ai_error";
  } else {
    await recordAiCall(contact.id);
    // Штатное молчание требует явной метки NO_REPLY. Пустой ответ провайдера
    // уже превращён в ошибку и направлен в очередь повторов.
    // Отправка обёрнута нарочно: отказ Meta (закрылось окно 24 ч, 429) не должен
    // уносить с собой разбор чека, который ждёт ниже — он дороже ответа.
    let replyText = result.text
      ? await enforceReplyLanguage(contact, ownLanguage ? text : "", language, result.text, prompt, generate)
      : null;
    // В ответе номер карты (ai/requisitesOffer.ts): одним сообщением и текстом, не голосом.
    let carriesRequisites = false;
    if (replyText?.trim() === "[NO_REPLY]") {
      logWarn("ai:explicitSilence", `${contact.id}: explicit NO_REPLY`);
      replyText = null;
      silence = "model_no_reply";
    }
    // Модель честно сказала «фактов нет» — «Ширин сама ответит» и зовём её (пункт 7).
    if (replyText && isAskShirin(replyText)) {
      if (!(await handOffUnknownToShirin(contact, text, language))) silence = "human_requested";
      replyText = null;
    }
    if (replyText) {
      const facts = await trustedSalesFacts();
      const issues = replyPolicyIssues(replyText, facts);
      if (issues.length) {
        const fixed = await generate(
          prompt +
            `
Исправьте ответ: ${issues.join(", ")}. Проверенные факты: ${facts}`,
        );
        replyText = "error" in fixed ? null : fixed.text;
        const stillIssues = replyText ? replyPolicyIssues(replyText, facts) : [];
        // Выдумка осталась и после исправления (или модель сама сказала «нет факта») —
        // не держим ответ молча, а честно: «Ширин сама ответит» и зовём её.
        if (
          !("error" in fixed) &&
          replyText &&
          (isAskShirin(replyText) || (stillIssues.length > 0 && stillIssues.every((i) => FACT_ISSUES.has(i))))
        ) {
          logWarn("ai:replyPolicy", `${contact.id}: handed to Shirin ${issues.join(",")}`);
          if (!(await handOffUnknownToShirin(contact, text, language))) silence = "human_requested";
          replyText = null;
        } else if (!replyText || stillIssues.length || replyText.trim() === "[NO_REPLY]") {
          logWarn("ai:replyPolicy", `${contact.id}: held ${issues.join(",")}`);
          silence = "policy_held";
          if ("error" in fixed) {
            if (contact.channel === "WHATSAPP")
              deliveryFailure = new Error("WhatsAppGenerationRetry: correction unavailable");
            else await queuePendingAiReply(contact.id, text);
          } else deliveryFailure = new ReplyPolicyError(issues);
          replyText = null;
        }
      }
      // Обращение «апачон» и дежурный хвост — до голоса и до текста: озвучке они
      // так же чужие. Особые буквы и тире правит уже дверь отправки (humanizeForContact):
      // голосу нужны буквы, тексту — по стилю собеседника.
      const beforeClean = replyText;
      if (replyText) replyText = withoutStockTails(withoutAddressWords(cleanGeneratedReply(replyText)));
      // Реквизиты и «пришлите чек» — не чаще раза за 15 минут; оплатившему этот курс
      // чек не просим никогда; «чек приняли» без принятого чека не говорим (ai/repeatGuard.ts).
      let emptiedBy: string[] = beforeClean && !replyText ? ["cleanup"] : [];
      const repeatCtx = replyText ? await loadRepeatContext(contact.id, text) : null;
      if (replyText && repeatCtx) {
        const repeat = withoutRepeats(replyText, repeatCtx, language);
        if (repeat.removed.length > 0) logWarn("ai:repeatGuard", `${contact.id}: removed ${repeat.removed.join(",")}`);
        if (!repeat.text) emptiedBy = repeat.removed;
        replyText = repeat.text || null;
      }
      // ПОСЛЕ ФИЛЬТРОВ ПУСТО — НЕ МОЛЧИМ (ревью 11.11.2026). Модель ответила, но всё
      // сказанное было повтором реквизитов / просьбой чека / служебной меткой:
      // клиент остался бы без ответа. Один повторный ход с прямой подсказкой, что
      // нельзя; снова пусто (или ошибка) — «сейчас уточню и напишу» и зовём человека.
      // Явное [NO_REPLY] на повторе — законное молчание.
      if (!replyText && emptiedBy.length > 0) {
        replyText = await regenerateAfterFilters(
          emptiedBy,
          async (extra) => {
            const again = await generate(prompt + extra);
            if ("error" in again || !again.text) return null;
            if (again.text.trim() === "[NO_REPLY]") return again.text;
            if (isAskShirin(again.text) || replyPolicyIssues(again.text, await trustedSalesFacts()).length > 0)
              return null;
            return withoutStockTails(withoutAddressWords(cleanGeneratedReply(again.text)));
          },
          repeatCtx ?? (await loadRepeatContext(contact.id, text)),
          language,
        );
        if (replyText === "") {
          replyText = null;
          silence = "model_no_reply";
        } else if (replyText === null) {
          logWarn("ai:emptyAfterFilters", `${contact.id}: handed to Shirin after ${emptiedBy.join(",")}`);
          if (!(await handOffUnknownToShirin(contact, text, language))) silence = "human_requested";
        }
      }
      // Пауза «по офлайну не отвечаем», страховка на выходе (владелец 24.11.2026): входной
      // фильтр не узнал офлайн («живой курс»), а модель сама выдала цену/адрес/дату офлайна.
      // Такой ответ не шлём, разговор передаём Ширин — сторож напомнит ей в Telegram.
      if (replyText && (await offlineReplyBlockedByPause(contact, replyText))) {
        logWarn("ai:offlinePause", `${contact.id}: reply with offline facts held, handed to Shirin`);
        await enterOfflineHandoff(contact.id);
        replyText = null;
        silence = "offline_handoff";
      }
      // ЦЕНА И НОМЕР КАРТЫ ОДНИМ СООБЩЕНИЕМ (16.11.2026): спросили цену, «хочу купить»
      // или выбрали курс — к ответу добавляется номер (если его не было выше и человек
      // не говорил «не надо»); вопрос «отправить реквизиты?» вырезается всегда.
      if (replyText) {
        const offer = await applyRequisitesOffer(contact.id, text, replyText, language);
        if (offer.action !== "none") logInfo("ai:requisitesOffer", `${contact.id}: ${offer.action}`);
        replyText = offer.text || replyText;
        carriesRequisites = offer.carriesRequisites;
      }
      // Редкий смайлик, как у самой Ширин (voice.ts): не чаще раза на три ответа,
      // только на коротких тёплых репликах без цифр (значит, никогда в реквизитах).
      if (
        replyText &&
        !carriesRequisites &&
        !replyText.includes("---") &&
        (await getSetting("warmEmojiEnabled")) !== "false"
      ) {
        if (!(await recentBotUsedEmoji(contact.id))) replyText = maybeWarmEmoji(replyText, WARM_EMOJI_EVERY);
      }
    }
    if (replyText) {
      try {
        // Несколько коротких сообщений вместо одного полотна — см. splitReplyParts.
        // Паузу между ними держит sendText сам (человеческий темп набора; на
        // сайте паузы нет — см. messaging/send.ts).
        const splitOpts = splitOptionsFor(contact.channel, {
          instagram: await getSetting("replySplitInstagram"),
          whatsapp: await getSetting("replySplitWhatsapp"),
          web: await getSetting("replySplitWeb"),
          maxParts: await getSetting("replySplitMaxParts"),
        });
        // Цена и номер — ОДНИМ сообщением: не режем на пузыри, иначе номер уедет от цены.
        const parts = carriesRequisites
          ? [
              replyText
                .split(/\n*---\n*/)
                .map((p) => p.trim())
                .filter(Boolean)
                .join("\n"),
            ]
          : splitHumanLike(replyText, splitOpts);
        // Короткий тёплый ответ может уйти голосом (рубильник voiceReplyEnabled, по
        // умолчанию выключен; правило и границы - ai/voiceReply.ts). Любая ошибка до отправки - текстом.
        // Голос решает по ВСЕМУ ответу, а не по одной части: короткий ответ, разбитый на несколько сообщений,
        // тоже может уйти голосом (владелец 08.11.2026: «не отправил голос»).
        const textRest = carriesRequisites
          ? null
          : await trySendVoiceReply(
              contact,
              replyText,
              attachments.some((a) => a.kind === "audio"),
              text,
            );
        const toSend = textRest === null ? parts : textRest ? splitHumanLike(textRest, splitOpts) : [];
        // Голос ушёл, а текст пуст — это ответ; ничего не ушло вовсе — «после фильтров пусто».
        silence = "filtered_empty";
        for (const part of toSend) {
          // В историю sendToContact сам пишет ровно то, что увидел клиент (после фильтра);
          // запись ниже с тем же mid ничего не меняет. Пусто после фильтра — не шлёт и не пишет.
          const mid = await sendToContact(contact, part);
          if (mid) await recordOutgoingMessage(contact.id, part, mid);
        }
        // Спросили про онлайн-курс — вдогонку фото его меню, если ещё не показывали.
        await maybeSendCourseMenuPhoto(contact, text);
        // Реалтайм-версия «где бот застрял» — см. stuckAlert.ts. Fire-and-forget,
        // как markStartedLearningIfReplied выше: сбой здесь не должен трогать
        // уже отправленный ответ.
        notifyIfStuck(contact.id).catch((err) => logError("stuckAlert:check", err));
      } catch (err) {
        logError("ai:send", err);
        // Номер не дошёл: снимаем захват, чтобы шаг воронки или повтор прислали его.
        if (carriesRequisites) releaseRequisitesClaim(contact.id);
        deliveryFailure = err;
      }
    }
  }

  const picked = await receiptPromise;
  if (await isBotFrozen()) return silence;
  const verdict = picked?.verdict ?? null;
  const firstImage = picked?.image ?? null;
  // Остальные фото сообщения (не выбранные) больше не чеки в очереди — иначе
  // фоновая перепроверка разобрала бы их отдельно и снова написала клиентке.
  const otherQueued = imageParts
    .map((ip) => ip.image.queuedId)
    .filter((id): id is string => Boolean(id) && id !== firstImage?.queuedId);
  if (picked && otherQueued.length > 0) {
    await prisma.receiptCheck
      .deleteMany({ where: { id: { in: otherQueued } } })
      .catch((err) => logError("ai:receiptVerdict:dropSiblings", err));
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
        recipientMatches: verdict.recipientMatches,
        transactionId: verdict.transactionId,
        reason: verdict.reason,
        imageHash: firstImage.hash,
        imageUrl: firstImage.url,
      },
      // Обновляем строку, которую создала страховка, а не плодим вторую.
      firstImage.queuedId ?? undefined,
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
  if (deliveryFailure) throw deliveryFailure;
  return silence;
}

/**
 * Ответ ИИ на комментарий под роликом, который НЕ входит в продающую воронку.
 * Тот же промт и та же защита, но доставка — приватным ответом на комментарий
 * (единственный способ написать первым тому, кто ещё не писал в директ), и без
 * кнопок: человек просто спросил что-то под роликом, продавать ему нечего.
 */
/**
 * Чем кончился ответ на комментарий (funnel.ts пишет это в SeenComment.outcome,
 * сторож unansweredWatch.ts напоминает владельцу о тех, что остались без ответа).
 *  ai — ответ ушёл в директ; no_reply — модель решила, что отвечать нечего;
 *  guard — шаблон защиты; silent_guard — нарочно молчим («пустите бесплатно»);
 *  остальное — без ответа НЕ по нашему решению.
 */
export type CommentReplyOutcome =
  | "ai"
  | "no_reply"
  | "guard"
  | "silent_guard"
  | "frozen"
  | "waiting_human"
  | "ai_off"
  | "no_keys"
  | "budget"
  | "ai_error";

/** Ответы ИИ под комментариями. По умолчанию ВКЛЮЧЕНЫ (владелец 09.11.2026:
 *  «никто не должен оставаться без ответа и в комментах»); "false" выключает. */
export const AI_COMMENT_REPLIES_SETTING = "aiCommentRepliesEnabled";

export async function aiReplyToComment(
  contact: Contact,
  commentId: string,
  text: string,
): Promise<CommentReplyOutcome> {
  if (await isBotFrozen()) return "frozen";
  if (contactAutomationBlocked(contact)) return "waiting_human";
  // Свой флаг, не aiEnabled — владелец 13.09.2026 попросил заглушить обычный
  // ИИ-ответ в директе, но оставить живыми ответы под комментариями; общий
  // флаг гасил бы оба сразу. Раньше по умолчанию был ВЫКЛЮЧЕН («true» только
  // явно), а в панели его не было вовсе — комментарий не к рекламному ролику
  // молча оставался без ответа. Теперь включён, пока не выставлен "false".
  const enabled = (await getSetting(AI_COMMENT_REPLIES_SETTING)) !== "false";
  if (!enabled) return "ai_off";
  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) {
    logError("ai:aiReplyToComment:noGeminiKeys", new Error("Gemini API keys not configured — comment reply skipped"));
    return "no_keys";
  }

  const language = await contactLanguage(contact.id, text);
  const verdict = guardOffTopic(text);
  if (verdict) {
    // «Пустите бесплатно» и назойливое дёрганье под роликом — молчим совсем.
    if (isSilentKind(verdict.kind)) return "silent_guard";
    // Под роликом отвечаем шаблоном ровно один раз и не спорим дальше: в
    // комментариях нет «разговора», в который бот мог бы встрять повторно.
    const guardedText = await humanizeForContact(contact.id, guardReply(verdict.kind, language), [text]);
    try {
      await sendPrivateReplyRecorded(contact, commentId, guardedText);
    } catch (err) {
      logError("ai:commentGuard:sendPrivateReply", err);
      return "ai_error";
    }
    return "guard";
  }
  // Бюджет кончился — раньше тишина. Теперь честное «напишите чуть позже» в
  // директ (тот же текст, что в переписке), а сторож напомнит владельцу.
  if (await isBudgetExceeded(contact.id)) {
    const fallback = BUDGET_FALLBACK[language];
    try {
      await sendPrivateReplyRecorded(contact, commentId, fallback);
    } catch (err) {
      logError("ai:commentBudget:sendPrivateReply", err);
    }
    return "budget";
  }

  // Комментарий — это всегда текст, голосовых под роликами не бывает: модель
  // обычная, время обычное.
  const prompt = (await buildSystemPrompt()) + (await deliveryPrompt(contact)) + REPLY_POLICY_INSTRUCTION;
  const model = (await getSetting("aiModel")) || "gemini-3.6-flash";

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
    TIMEOUT_MS,
  );
  if ("error" in result) {
    logError("ai:commentReply", result.error);
    void logAiCall({ endpoint: "comment-reply", ms: Date.now() - startedAt, ok: false });
    return "ai_error";
  }
  void logAiCall({
    endpoint: "comment-reply",
    model: result.model,
    usage: result.usage,
    ms: Date.now() - startedAt,
    ok: true,
  });
  await recordAiCall(contact.id);
  if (!result.text) return "ai_error";

  if (result.text.trim() === "[NO_REPLY]") return "no_reply";
  // Нет факта — как в директе (ревью 11.11.2026): раньше «[ASK_SHIRIN]» уходил
  // человеку под комментарием буквально. Теперь «сейчас уточню и напишу вам»
  // приватным ответом, пауза и вопрос в списке ждущих, Далеру — уведомление.
  if (isAskShirin(result.text)) {
    await handOffUnknownToShirin(contact, text, language, async (reply) => {
      const shown = await humanizeForContact(contact.id, cleanAutomatedReply(reply), [text]);
      return sendPrivateReplyRecorded(contact, commentId, shown);
    });
    return "waiting_human";
  }
  const issues = replyPolicyIssues(result.text, await trustedSalesFacts());
  if (issues.length) {
    logWarn("ai:commentReplyPolicy", `${contact.id}: held ${issues.join(",")}`);
    throw new ReplyPolicyError(issues);
  }
  const clean = await humanizeForContact(contact.id, cleanGeneratedReply(result.text), [text]);
  if (!clean) return "no_reply";
  await sendPrivateReplyRecorded(contact, commentId, clean);
  return "ai";
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
      // Instagram/Messenger — до ответа Ширин (решение владельца 15.11.2026), остальное — час.
      data: { humanSilencedUntil: askedHumanSilenceUntil(contact.channel), humanRequestedAt: new Date() },
    })
    .catch((err) => {
      logError("ai:callOwnerToChat:silence", err);
    });
  // След просьбы: по нему сторож не вернёт бота к этому человеку сам, а напомнит Ширин.
  await recordNoReply(contact, "asked_human", lastText);

  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  // Кнопки быстрых ответов под уведомлением — чтобы не набирать с телефона,
  // достаточно нажать (см. quickReplies.ts, telegramWebhook.ts ветка `qr:`).
  // callback_data короткий (индекс, не текст) — лимит Telegram 64 байта.
  const quickReplies = await getQuickReplies();
  const buttons = quickReplies.map((qr, i) => [{ text: qr.label, callback_data: `qr:${contact.id}:${i}` }]);
  await sendKind(
    "human",
    `🙋 ${who} просит поговорить с вами лично.

Последнее сообщение: «${lastText.slice(0, 200)}»

Бот молчит, пока вы не ответите. Можно ответить одной из кнопок ниже — уйдёт клиенту сразу:`,
    { buttons },
  ).catch((err) => logError("ai:callOwnerToChat:notify", err));
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
  generate: (systemPrompt: string) => Promise<{ text: string | null } | { error: string }>,
): Promise<string> {
  const wrong = OPPOSITE[language];
  if (!wrong || !incoming.trim()) return reply;
  if (detectReplyLanguage(reply) !== wrong) return reply;

  const retry = await generate(prompt + LANGUAGE_FIX[language as "ru" | "tg"]);
  if ("error" in retry || !retry.text) {
    logWarn(
      "ai:languageMismatch",
      `${contact.id}: ответ не на языке клиента (${language}), повтор не удался — отдаю как есть`,
    );
    return reply;
  }
  await recordAiCall(contact.id);
  if (detectReplyLanguage(retry.text) === wrong) {
    logWarn(
      "ai:languageMismatch",
      `${contact.id}: ответ снова не на языке клиента (${language}) после повтора — отдаю повторный`,
    );
  }
  return retry.text;
}

/**
 * Клиентка пишет с сайта shirinsweets.online, а не из Instagram. Промт
 * владельца писался под директ и Telegram-группы: «добавлю вас в группу»,
 * «уроки в Телеграме». На сайте это ложь — уроки открываются по ссылке на
 * самом сайте, а ссылка приходит прямо в этот чат после чека. Не трогаем
 * промт владельца, а добавляем поправку для WEB и WhatsApp, где выдаём сайт.
 */
export function webChannelBlock(contact: Pick<Contact, "channel">): string {
  if (contact.channel !== "WEB" && contact.channel !== "WHATSAPP") return "";
  return (
    (contact.channel === "WHATSAPP"
      ? "\n\nВАЖНО — КАНАЛ: клиентка пишет в WhatsApp. "
      : "\n\nВАЖНО — КАНАЛ: клиентка пишет в чат на нашем сайте shirinsweets.online. ") +
    "Онлайн-уроки открываются ПРЯМО НА САЙТЕ по личной ссылке, в телефоне, без Telegram и без групп. " +
    "Никогда не говори «в Телеграме», «добавлю в группу», «пришлю ссылку на группу». " +
    "После оплаты нужна проверка поступления денег; после подтверждения ссылка на уроки придёт сюда же. Не обещай автоматическое подтверждение по скриншоту. " +
    "Уроки можно смотреть с любого телефона, сохранять офлайн, в конце — сертификат."
  );
}

/**
 * Детерминированная запись на офлайн-курс ДО хода модели (webhook.ts). Раньше
 * запись жила только внутри offlineSignupBlock, а до него не доходили ходы,
 * перехваченные воронкой, guard-ом, паузой хозяйки или бюджетом — в сводке
 * «записались на офлайн» стояло 0 при живых желающих (владелец 05.09.2026).
 *
 * С 11.11.2026 условие строже: номер телефона в тексте (и это не НАШ номер для
 * оплаты, который клиент переписал себе) плюс явный офлайн — в этом сообщении,
 * словом «запишите / сабт», недавним разговором про офлайн или уже ушедшей
 * карточкой. Раньше хватало «нависед» в НАШЕМ сообщении, и номер онлайн-клиента
 * мог уйти сестре как запись на офлайн.
 */
export async function registerOfflineIfAsked(contact: Contact, text: string | null): Promise<boolean> {
  if (await isBotFrozen()) return false;
  if (!text || contact.paid) return false;
  const phone = extractPhone(text);
  if (!phone) return false;
  if (mentionsPaymentPhone(phone, (await getSalesTexts()).paymentPhone)) return false;
  const context =
    explicitOfflineInterest(text) ||
    SIGNUP_RE.test(text) ||
    Boolean(contact.offlineInfoSentAt) ||
    (await recentIncomingWantsOffline(contact.id));
  if (!context || asksOnlineNotOffline(text)) return false;
  return registerOfflineSignup(contact, text);
}

/**
 * Пауза «по офлайн-курсам не отвечаем» (владелец 22.11.2026, настройка offlineRepliesPaused).
 * true — сообщение про офлайн, разговор уже передан Ширин, карточка офлайна уходила или
 * недавно шёл разговор про офлайн: бот молчит (ни ответа, ни подтверждения записи), отвечает
 * человек. «Онлайн» без слова «офлайн» и купившие не затрагиваются. Её же использует сторож
 * (unansweredWatch.ts), чтобы напомнить Ширин в Telegram.
 */
export async function offlineRepliesPausedFor(
  contact: Pick<Contact, "id" | "paid" | "offlineHandoffAt" | "offlineInfoSentAt">,
  text: string | null | undefined,
): Promise<boolean> {
  if ((await getSetting("offlineRepliesPaused")) !== "true") return false;
  if (contact.paid || !text || asksOnlineNotOffline(text)) return false;
  return (
    explicitOfflineInterest(text) ||
    Boolean(contact.offlineHandoffAt) ||
    Boolean(contact.offlineInfoSentAt) ||
    (await recentIncomingWantsOffline(contact.id))
  );
}

/** Пауза по офлайну включена, а готовый ответ бота содержит факты офлайн-курса (ai/offlineHandoff.ts). */
export async function offlineReplyBlockedByPause(
  contact: Pick<Contact, "paid">,
  reply: string | null | undefined,
): Promise<boolean> {
  if (contact.paid || !reply || (await getSetting("offlineRepliesPaused")) !== "true") return false;
  return replyHasOfflineFacts(reply, await getOfflineFacts());
}

/**
 * Ход «карточка — и всё» (владелец 08.11.2026, сужено 11.11.2026). Карточка
 * уходит ТОЛЬКО на явный офлайн в этом сообщении (ai/offlineHandoff.ts::
 * explicitOfflineInterest): «офлайн», «очно», «дар назди ман», «адрес», «700»,
 * «прийти в Душанбе». «Курс», «кай сар мешавад», «онлаен», «арзон», «ҳарду курс»
 * — это онлайн, карточку не шлём и разговор не передаём. Карточка реально ушла —
 * отметка «передано Ширин» (дальше ведёт Ширин, владелец 11.11.2026: «даёт
 * информацию и замолкает»), модель в этот ход не зовём.
 */
async function sendOfflineCardAndHandOff(contact: Contact, text: string): Promise<boolean> {
  if (contact.paid || !(await offlineHandoffEnabled())) return false;
  if (!explicitOfflineInterest(text)) return false;
  if (!(await maybeSendOfflineCard(contact, text))) return false;
  // Следом — фото «МЕНЮ КУРСА» офлайна (владелец 11.11.2026), если ещё не уходило.
  await sendOfflineMenuPhoto(contact, text);
  await enterOfflineHandoff(contact.id);
  return true;
}

async function offlineSignupBlock(contact: Contact, text: string): Promise<string> {
  if (!text) return "";
  // «Запишите на онлайн курс» совпадает с «запиш…», но это не очный курс:
  // карточку офлайна такому человеку не шлём (см. ai/offlineHandoff.ts).
  if (asksOnlineNotOffline(text)) return "";
  const explicit = explicitOfflineInterest(text);
  // Разговор про офлайн был недавно (человек мог написать номер отдельно или
  // спросить «кай сар мешавад?» после карточки) — фактам место в промпте, но без
  // нажима «запишитесь»: вопрос может быть и про онлайн.
  const recent = !explicit && (await recentIncomingWantsOffline(contact.id));
  // Строка «Офлайн-курс: …» из «Цены и даты» стоит в промпте ВСЕГДА (ревью 11.11.2026):
  // промпт владельца называет дату набора словами («20 ноября») и говорит «если в
  // строке «Офлайн-курс: …» другая дата — верна она». Без строки сравнивать не с чем,
  // и после смены даты в панели модель называла бы старую.
  if (!explicit && !recent) {
    return `\n\nСПРАВКА ОБ ОФЛАЙН-КУРСЕ (говори о нём, только если человек сам спросил про офлайн):\n${await offlineFactsForModel()}`;
  }

  const date = await courseDateLabel();
  // Факты очного курса — из раздела «Цены и даты», та же строка, что видит
  // владелец в предпросмотре. Без неё модель на «во сколько?» после карточки
  // отвечала по памяти промта.
  const facts = await offlineFactsForModel();

  const registered = await registerOfflineIfAsked(contact, text);
  if (registered) {
    return `\n\nВАЖНО СЕЙЧАС: человека уже ЗАПИСАЛИ на офлайн-курс (${date}). Коротко подтверди это, скажи, что предоплаты не нужно и что за день до курса ему позвонят. Больше ничего не спрашивай.`;
  }
  if (!explicit) {
    return `\n\nЕСЛИ ВОПРОС ПРО ОФЛАЙН-КУРС, вот факты (если про онлайн — отвечай про онлайн, офлайн не предлагай):\n${facts}`;
  }

  // Условия набора уходят ОТДЕЛЬНЫМ сообщением и дословно так, как их написал
  // владелец (см. ai/offlineCourse.ts). Пересказывать их модели нельзя: она
  // меняет порядок, теряет адрес и сливает всё в абзац, который на телефоне
  // просто не читают.
  const cardSent = await maybeSendOfflineCard(contact, text);
  return cardSent
    ? `\n\nВАЖНО СЕЙЧАС: человеку УЖЕ отправлено отдельное сообщение со всеми условиями офлайн-курса — цена, даты, адрес. Не повторяй их. Одной короткой фразой попроси имя и номер телефона для записи.\n${facts}`
    : `\n\nВАЖНО СЕЙЧАС: человек спрашивает про ОФЛАЙН-курс (${date}). Ответь на вопрос по фактам ниже; записаться можно, оставив имя и номер. Предоплаты нет — про оплату не заговаривай.\n${facts}`;
}

/** Просьба записать — только с номером телефона это запись на офлайн (registerOfflineIfAsked). */
const SIGNUP_RE = /(запиш|записат|записыва|сабт)/iu;

/**
 * Шёл ли недавно разговор про офлайн-курс — по сообщениям В ОБЕ СТОРОНЫ
 * (владелец 06.09.2026: если офлайн упомянул бот, а человек спросил «кай
 * мешава», факты нужны в промпте). С 11.11.2026 признак — тот же явный
 * explicitOfflineInterest, а не «нависед/запишите»: наше же «Саволатонро
 * нависед» больше не превращает онлайн-разговор в офлайн. Нажатие кнопки
 * «ДАР НАЗДИ МАН» — явный офлайн. Это только для фактов и записи, карточку
 * по истории не шлём.
 */
export async function recentIncomingWantsOffline(contactId: string): Promise<boolean> {
  const recent = await prisma.message.findMany({
    where: { contactId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { text: true },
  });
  return (recent ?? []).some((m) => m.text && explicitOfflineInterest(m.text));
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
  if (!text || (!ABOUT_COURSE.test(text) && !claimsReceiptSent(text))) return "";
  const owned = await ownedCourses(contact.id);
  if (owned.length === 0) return "";

  if (owned.includes(COURSE_50) && owned.includes(COURSE_70)) {
    return (
      "\n\nВАЖНО СЕЙЧАС: человек УЖЕ купил ОБА курса (Арт-десерты и 21 рецепт) — доступ в обеих " +
      "курсах у него уже есть. НЕ отправляй реквизиты оплаты и не проси чек — скажи, что доступ " +
      "уже выдан. Если что-то не открывается, уточни ошибку; способ доступа указан в актуальном блоке."
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

/** Проблемы ответа, которые означают «нет факта»: на них честное «Ширин ответит». */
const FACT_ISSUES = new Set(["unverified_claim"]);

/** Один смайлик примерно на три ответа (владелец 11.11.2026: «иногда, а не совсем без»). */
const WARM_EMOJI_EVERY = 3;

/** В двух последних наших сообщениях уже был смайлик — сейчас без него. */
async function recentBotUsedEmoji(contactId: string): Promise<boolean> {
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { text: true },
  });
  return (rows ?? []).some((r) => /\p{Extended_Pictographic}/u.test(r.text ?? ""));
}

const ASK_SHIRIN_REPLY: Record<ClientLanguage, string> = {
  // От первого лица и без имени (ревью 11.11.2026): бот пишет от имени Ширин, и
  // «Ширин сама ответит» выдавало автомат. Таджикский — по образцу разговорника
  // (tajik-phrasebook: «тафтиш карда», «менависам»), без особых букв; носителем не вычитан.
  ru: "Сейчас уточню и напишу вам",
  tg: "Хозир аник карда ба шумо менависам",
  en: "Let me check, I'll write to you shortly",
};

/**
 * НЕТ ФАКТА — НЕ ВЫДУМЫВАЕМ (владелец 11.11.2026). Клиенту — короткое «Ширин
 * ответит», Далеру (технический чат) — что спросили; бот молчит час, чтобы
 * обещание было правдой (как при просьбе позвать человека). Сообщение владельцу
 * одно на такой случай, а не на каждое сообщение: повторный вопрос в тот же час
 * сюда не дойдёт (пауза).
 */
/**
 * Ответ на комментарий идёт приватным ответом (sendPrivateReply), а не в директ:
 * тому, кто ещё не писал, директ не дойдёт. Поэтому способ отправки — параметр.
 * humanRequestedAt (ревью 11.11.2026): без него вопрос не попадал в список
 * «ждут ответа» — обещание «напишу вам» держалось только на тревоге Далеру.
 */
async function handOffUnknownToShirin(
  contact: Contact,
  question: string,
  language: ClientLanguage,
  send: (reply: string) => Promise<string | null> = (reply) => sendToContact(contact, reply),
): Promise<boolean> {
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  const quickReplies = await getQuickReplies();
  const buttons = quickReplies.map((qr, i) => [{ text: qr.label, callback_data: `qr:${contact.id}:${i}` }]);
  // ВТОРОГО «УТОЧНЮ» НЕ БЫВАЕТ (ревью 15.11.2026). Обещание уже висит, Ширин ещё не
  // ответила — повтор клиенту звучит как автомат. Молчим и говорим Ширин ещё раз.
  if (await shirinHandoffOpen(contact.id)) {
    await sendKind(
      "human",
      `❓ ${who} снова спросил то, чего бот не знает: «${question.slice(0, 200)}»

Бот уже обещал «уточню» и второй раз не повторяет — ответьте сами или кнопкой ниже.`,
      { buttons },
    ).catch((err) => logError("ai:askShirin:notify", err));
    return false;
  }
  const reply = ASK_SHIRIN_REPLY[language];
  const mid = await send(reply);
  if (mid) await recordOutgoingMessage(contact.id, reply, mid);
  const now = Date.now();
  await prisma.contact
    .update({
      where: { id: contact.id },
      data: { humanSilencedUntil: new Date(now + HUMAN_REQUESTED_SILENCE_MS), humanRequestedAt: new Date(now) },
    })
    .catch((err) => logError("ai:askShirin:silence", err));
  await sendKind(
    "human",
    `❓ ${who} спросил то, чего бот не знает: «${question.slice(0, 200)}»

Бот ответил «сейчас уточню и напишу вам» и молчит час. Ответьте сами или кнопкой ниже.`,
    { buttons },
  ).catch((err) => logError("ai:askShirin:notify", err));
  return true;
}

/** Обещание «Ширин ответит» ещё висит: за последние сутки бот передал человеку, а живого ответа после этого не было. */
const HANDOFF_OPEN_MS = 24 * 3_600_000;
async function shirinHandoffOpen(contactId: string): Promise<boolean> {
  try {
    const fresh = await prisma.contact.findUnique({ where: { id: contactId }, select: { humanRequestedAt: true } });
    const at = fresh?.humanRequestedAt;
    if (!at || Date.now() - at.getTime() > HANDOFF_OPEN_MS) return false;
    const human = await prisma.message.findFirst({
      where: { contactId, direction: "OUT", byHuman: true, createdAt: { gte: at } },
      select: { id: true },
    });
    return !human;
  } catch (err) {
    logError("ai:askShirin:openCheck", err);
    return false;
  }
}

/** Факты, по которым replyPolicy проверяет ответ перед отправкой: суммы,
 *  телефон и дата набора. Сумма двух курсов по отдельности разрешена ТОЛЬКО
 *  рядом с «вместо»/«по отдельности» («100 вместо 120» — правда, «за оба 120»
 *  — нет, решение владельца 05.09.2026). Дата набора — та, что в «Цены и
 *  даты», или никакая: другая дата в ответе про курс задерживает его. */
export async function trustedSalesFacts(): Promise<string> {
  const [texts, offline, prices, date] = await Promise.all([
    getSalesTexts(),
    getOfflineFacts(),
    getPrices(),
    courseDateLabel("ru"),
  ]);
  return (
    `${texts.priceLineRu}. ${CONTEXT_ONLY_AMOUNT} ${prices.bundleFull} сомони. ${texts.paymentPhone}. Офлайн: ${offline.price} сомони. ` +
    `${COURSE_DATE_FACT} ${date}.`
  );
}
