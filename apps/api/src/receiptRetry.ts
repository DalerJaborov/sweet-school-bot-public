import fs from "node:fs";
import { singleFlight } from "./services/singleFlight.js";
import path from "node:path";
import { prisma, getSetting, logError } from "./db.js";
import { checkReceipt } from "./ai/receiptCheck.js";
import { buildMediaPart } from "./ai/media.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { handleReceiptVerdict } from "./ai.js";
import { confirmRequisitesToCustomer } from "./ai/receiptVerdict.js";
import { MEDIA_DIR } from "./upload.js";
import { isBotFrozen } from "./messaging/automation.js";

/**
 * Очередь недосмотренных чеков.
 *
 * ЗАЧЕМ. Разбор чека — единственное место, где отказ ИИ стоит денег: человек уже
 * заплатил, а доступ ему не открылся. Раньше при таймауте Gemini вердикт был
 * null и картинка просто забывалась (так и вышло с первой живой оплатой 21.08 —
 * ссылку хозяйке пришлось отправлять руками). Теперь картинка ложится сюда со
 * статусом "unchecked", и фоновый тик пробует ещё раз, пока не разберёт.
 *
 * ПОСЛЕ ИСЧЕРПАНИЯ ПОПЫТОК — не «отклонить», а показать человеку: может, это
 * вообще было фото торта, а может честная оплата. Решает владелец.
 */

const MAX_RETRIES = 4;
/** Пауза между попытками: сбои Gemini обычно короткие, но бюджет на день общий —
 *  долбиться каждые 10 секунд значит сжечь его на одной картинке. */
const RETRY_DELAY_MS = 3 * 60_000;

export const UNCHECKED = "unchecked";

/**
 * Кладёт картинку в очередь и возвращает id записи — по нему основной путь потом
 * ОБНОВИТ эту же строку, а не создаст вторую.
 *
 * Повторную постановку того же отпечатка не плодим: человек мог прислать чек
 * дважды, а разбирать его надо один раз. Гонку (два сообщения с одним чеком
 * почти одновременно) закрывает уникальность `imageHash` в базе — проверка
 * `findFirst` перед `create` от неё не спасает, поэтому ловим и отказ создания.
 */
export async function queueUncheckedReceipt(
  contactId: string,
  imageHash: string,
  imageUrl: string
): Promise<string | null> {
  if (await isBotFrozen()) return null;
  const already = await prisma.receiptCheck.findFirst({ where: { imageHash } });
  if (already) return already.kind === UNCHECKED ? already.id : null;
  try {
    const row = await prisma.receiptCheck.create({
      data: {
        contactId,
        kind: UNCHECKED,
        confidence: 0,
        reason: "картинка ждёт разбора",
        imageHash,
        imageUrl,
      },
    });
    return row.id;
  } catch {
    // Уникальность отпечатка — другой поток успел раньше. Это не ошибка.
    const existing = await prisma.receiptCheck.findFirst({ where: { imageHash } });
    return existing?.kind === UNCHECKED ? existing.id : null;
  }
}

/** Локальный файл нашей копии по публичной ссылке /media/<имя>. */
function localFile(imageUrl: string): string | null {
  const name = path.basename(new URL(imageUrl, "http://local").pathname);
  if (!name || name.includes("..")) return null;
  const file = path.join(MEDIA_DIR, name);
  return fs.existsSync(file) ? file : null;
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

/** Занятость прохода. Тик приходит раз в 10 секунд, а один разбор чека может
 *  занять до 75 секунд — без этого флага на одну и ту же строку набегали
 *  десятки параллельных проходов: сожжённый дневной бюджет ключа и лишние
 *  карточки владельцу на уже выданный доступ. */

/** Один проход очереди. Дёргается тем же тиком, что и разносчик воронок. */
export async function retryUncheckedReceipts(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  // Потолок 30 мин — заведомо больше суммарного бюджета Gemini на проход:
  // «зависший» прогон, сброшенный раньше, чем он реально умер, обработал бы
  // тот же чек второй раз параллельно с новым (ревью 03.09.2026).
  await singleFlight("receiptRetry", runQueue, 30 * 60_000);
}

async function runQueue(): Promise<void> {
  if (await isBotFrozen()) return;
  const pending = await prisma.receiptCheck.findMany({
    where: { kind: UNCHECKED, createdAt: { lt: new Date(Date.now() - RETRY_DELAY_MS) } },
    include: { contact: true },
    orderBy: { createdAt: "asc" },
    take: 3,
  });
  if (pending.length === 0) return;

  const apiKeys = await resolveGeminiKeys();
  // НАСТРОЙКА ЗДЕСЬ ТА ЖЕ, ЧТО У ВСЕГО БОТА (22.08.2026). Раньше строка читала
  // `geminiModel` — ключ, которого нет ни в админке, ни где-либо ещё в коде: задать
  // его было нельзя, и перепроверка чеков молча всегда работала на зашитом дефолте.
  // Владелец мог сменить модель на экране, а этот путь остался бы на старой — то
  // есть на закрытой, когда Google её однажды выключит.
  const model = (await getSetting("aiModel"))?.trim() || "gemini-3.7-flash";

  for (const row of pending) {
    if (await isBotFrozen()) return;
    // confidence переиспользован как счётчик попыток: пока чек не разобран, своего
    // смысла у него нет, а лишняя колонка в схеме ради счётчика — перебор.
    const attempt = row.confidence + 1;
    const file = row.imageUrl ? localFile(row.imageUrl) : null;

    // Ключей нет прямо сейчас (настройка пуста, сбой чтения) — это НЕ повод
    // сдаваться: попытка не потрачена, вернёмся на следующем проходе. Раньше
    // такой сбой разом объявлял все чеки в очереди неразобранными.
    if (apiKeys.length === 0) continue;
    if (!file || attempt > MAX_RETRIES) {
      await giveUp(row.id, row.contactId, file ? "ИИ так и не смог разобрать чек" : "картинка не сохранилась");
      continue;
    }

    const part = await buildMediaPart(fs.readFileSync(file), mimeOf(file), apiKeys[0]).catch((err) => {
      logError("receiptRetry:buildMediaPart", err);
      return null;
    });
    const verdict = part ? await checkReceipt(part, model, apiKeys) : null;
    // A freeze may be enabled while Gemini is working. Leave the original
    // unchecked row and its retry budget untouched for the owner's review.
    if (await isBotFrozen()) return;

    if (!verdict) {
      // Попытка не удалась — двигаем createdAt, иначе следующий тик возьмёт эту же
      // запись через 10 секунд и съест дневной бюджет на одной картинке.
      await prisma.receiptCheck.update({
        where: { id: row.id },
        data: { confidence: attempt, createdAt: new Date() },
      });
      continue;
    }

    if (verdict.kind === "pre_transfer") {
      // Экран до перевода — отвечаем «реквизиты верные» и убираем из очереди.
      await confirmRequisitesToCustomer(row.contact, null).catch((err) => logError("receiptRetry:preTransfer", err));
      await prisma.receiptCheck.delete({ where: { id: row.id } }).catch((err) => {
        if ((err as { code?: string })?.code !== "P2025") logError("receiptRetry:preTransfer:delete", err);
      });
      continue;
    }

    if (verdict.kind === "not_receipt") {
      // Это было не чеком (фото десерта, мем) — запись убираем, чтобы вкладка
      // «Чеки» не зарастала шумом.
      await prisma.receiptCheck.delete({ where: { id: row.id } }).catch((err) => {
        // P2025 = запись уже удалена (race) — это нормально.
        if ((err as { code?: string })?.code !== "P2025") {
          logError("receiptRetry:notReceipt:delete", err);
        }
      });
      continue;
    }

    await handleReceiptVerdict(
      row.contact,
      {
        kind: verdict.kind,
        confidence: verdict.confidence,
        amount: verdict.amount,
        receiptAt: verdict.receiptAt,
        tamperingSuspected: verdict.tamperingSuspected,
        reason: verdict.reason,
        imageHash: row.imageHash,
        imageUrl: row.imageUrl,
      },
      row.id
    ).catch((err) => logError("receiptRetry:apply", err));
  }
}

/** Попытки кончились — отдаём человеку, а не выбрасываем. */
async function giveUp(id: string, contactId: string, why: string): Promise<void> {
  await prisma.receiptCheck.update({
    where: { id },
    data: { kind: "suspicious", reason: `${why} — посмотрите сами`, ownerDecision: "PENDING" },
  });
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  // Та же пара получателей, что и у обычной карточки сомнительного чека
  // (ai.ts::askOwner) — сестра могла пропустить сообщение, владелец теперь
  // видит его тоже.
  const recipients = [
    ...new Set(
      [
        (await getSetting("telegramOwnerChatId"))?.trim(),
        (await getSetting("telegramReportChatId"))?.trim(),
      ].filter((id): id is string => Boolean(id))
    ),
  ];
  if (recipients.length === 0) return;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  const { sendTelegramMessage } = await import("./telegram.js");
  const text = `⚠️ Чек не удалось проверить (${why}).\nЧеловек: ${contact?.username ? "@" + contact.username : contact?.igUserId}\nПосмотрите во вкладке «Чеки».`;
  for (const chatId of recipients) {
    await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("receiptRetry:notify", err));
  }
  // Это тоже эскалация к владельцу — клиентка должна знать, что чек не
  // потерян, а ждёт Ширин (см. receiptVerdict.ts::notifyCustomerReceiptForwarded).
  if (contact) {
    const { notifyCustomerReceiptForwarded } = await import("./ai/receiptVerdict.js");
    await notifyCustomerReceiptForwarded(contact, { id }).catch((err) => logError("receiptRetry:notifyCustomer", err));
  }
}
