import { prisma, getSetting, setSetting } from "./db.js";
import { offsetMs, plural } from "./dailyReport.js";
import { unansweredCount } from "./course/chat.js";
import { notifyOwnerDirect } from "./systemAlerts.js";

/**
 * НАПОМИНАНИЕ ВЛАДЕЛЬЦУ: ЧЕКИ И ВОПРОСЫ, КОТОРЫЕ ЖДУТ (05.09.2026).
 *
 * Карточка чека уходит в Telegram один раз, в момент эскалации; вопрос
 * ученицы — тоже один раз. Если Ширин в этот момент за плитой, сообщение
 * уезжает вверх ленты, и следующее напоминание — одна строка в сводке 23:00.
 * Клиентка тем временем ждёт ссылку весь день.
 *
 * Здесь — повтор каждые два часа в рабочее время (09:00–22:00 по Душанбе)
 * обо всём, что висит дольше часа. Ночью молчим: будить ради чека незачем,
 * клиентке уже сказано «ночью — утром» (receiptVerdict.ts). Нечего
 * напоминать — не пишем вовсе, иначе через неделю это перестанут читать.
 *
 * Отметка последней отправки — в базе, а не в памяти: контейнер
 * перезапускается при каждом деплое, и из памяти она бы обнулялась.
 */

export const REMINDER_EVERY_MS = 2 * 3_600_000;
/** Чек/вопрос младше часа ещё не «висит» — карточка только что ушла. */
export const PENDING_AFTER_MS = 3_600_000;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 22;
const SENT_KEY = "ownerReminderSentAt";
/** Сколько ников показать в напоминании — остальное числом. */
const MAX_HANDLES = 5;

function localHour(at: Date, offset: number): number {
  return new Date(at.getTime() + offset).getUTCHours();
}

export async function runOwnerReminders(now = new Date()): Promise<void> {
  const offset = await offsetMs();
  const hour = localHour(now, offset);
  if (hour < WORK_START_HOUR || hour >= WORK_END_HOUR) return;

  const lastSent = Number((await getSetting(SENT_KEY))?.trim() ?? "");
  if (Number.isFinite(lastSent) && now.getTime() - lastSent < REMINDER_EVERY_MS) return;

  const olderThan = new Date(now.getTime() - PENDING_AFTER_MS);
  const [receipts, questions] = await Promise.all([
    prisma.receiptCheck.findMany({
      where: { ownerDecision: "PENDING", createdAt: { lte: olderThan } },
      include: { contact: { select: { username: true, igUserId: true } } },
      orderBy: { createdAt: "asc" },
    }),
    unansweredCount(olderThan),
  ]);
  if (receipts.length === 0 && questions === 0) return;

  const lines: string[] = ["⏰ Напоминание — ждут вас:"];
  if (receipts.length > 0) {
    lines.push(`💳 ${receipts.length} ${plural(receipts.length, "чек", "чека", "чеков")} без решения дольше часа:`);
    for (const r of receipts.slice(0, MAX_HANDLES)) {
      const who = r.contact.username ? `@${r.contact.username}` : r.contact.igUserId;
      const hours = Math.floor((now.getTime() - r.createdAt.getTime()) / 3_600_000);
      lines.push(`     ${who} — ${hours} ч`);
    }
    if (receipts.length > MAX_HANDLES) lines.push(`     …и ещё ${receipts.length - MAX_HANDLES}`);
    lines.push("Кнопки «Подтвердить»/«Отклонить» — в карточке чека выше или во вкладке «Чеки».");
  }
  if (questions > 0) {
    lines.push(`❓ ${questions} ${plural(questions, "вопрос", "вопроса", "вопросов")} учениц без ответа дольше часа — ответьте реплаем на сообщение с вопросом.`);
  }

  // Отметка ДО отправки: отказ Telegram не должен зациклить попытки каждый тик.
  await setSetting(SENT_KEY, String(now.getTime()));
  await notifyOwnerDirect(lines.join("\n"));
}
