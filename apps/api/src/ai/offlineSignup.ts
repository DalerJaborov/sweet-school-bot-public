import { prisma, getSetting, logError } from "../db.js";
import { ownerAlertChatIds, sendTelegramMessage } from "../telegram.js";
import { courseDateLabel } from "./courseDate.js";

/**
 * Запись на ОФЛАЙН-курс: имя и телефон.
 *
 * Предоплаты у офлайна нет — деньги берут с первого занятия, поэтому чек тут ни
 * при чём. Нужно ровно две вещи: как зовут и куда звонить. Как только они есть,
 * уведомление СРАЗУ уходит сестре в Telegram — она обзванивает записавшихся.
 *
 * Имя и номер вытаскиваем из уже написанного человеком, а не выспрашиваем по
 * второму разу: в переписке они почти всегда уже прозвучали («Мадина, 900112233»).
 */

/**
 * Таджикский номер: 9 цифр, обычно с кодом 992 и/или плюсом, часто с пробелами и
 * дефисами внутри.
 *
 * ГРАНИЦЫ ОБЯЗАТЕЛЬНЫ. Без них любые девять цифр подряд считались телефоном, и
 * номер карты «505850101234567» превращался в «505850101» — сестре уходило
 * уведомление с мусорным номером, а исправить запись было уже нечем. Поэтому:
 * цифры не должны продолжаться ни слева, ни справа, а первая цифра обязана быть
 * началом реального мобильного кода (9, 5, 8, 7, 4 или 3).
 */
const PHONE_RE = /(?<!\d)(?:\+?992[\s-]?)?([935784][\d\s-]{7,11}\d)(?!\d)/;

export function extractPhone(text: string): string | null {
  const m = PHONE_RE.exec(text.replace(/[()]/g, ""));
  if (!m) return null;
  const digits = m[1].replace(/\D/g, "");
  return digits.length === 9 ? digits : null;
}

/**
 * Имя из сообщения. Человек пишет «Мадина 900112233» или «Ману Мадина нависед» —
 * берём слово с большой буквы, которое не является служебным.
 *
 * Не нашли — не выдумываем: в уведомлении будет ник Instagram, а имя сестра
 * спросит по телефону. Лучше честное «имя не указано», чем случайное слово.
 */
const NOT_A_NAME =
  /^(салом\p{L}*|ассалом\p{L}*|алейкум|здравствуйте|здрасте|привет|добрый|день|вечер|утро|номер\p{L}*|телефон\p{L}*|ном|нависед|нависет|напишите|запишите|запиши|записать|курс\p{L}*|офлайн|оффлайн|онлайн|мен|ман|ману|мне|меня|хочу|мехохам|мехоҳам|пожалуйста|спасибо|рахмат|раҳмат|апачон|апа|карт\p{L}*|чек\p{L}*|оплат\p{L}*|перевод|сомони|сомонӣ)$/iu;

export function extractName(text: string): string | null {
  // Флаг g обязателен: без него вырезалось только первое вхождение номера, и
  // вторая цепочка цифр могла уехать в «имя».
  const withoutPhone = text.replace(new RegExp(PHONE_RE.source, "gu"), " ");
  const words = withoutPhone.split(/[\s,.\n]+/).filter(Boolean);
  for (const w of words) {
    const clean = w.replace(/[^\p{L}\-]/gu, "");
    if (clean.length < 3 || clean.length > 20) continue;
    if (NOT_A_NAME.test(clean)) continue;
    // Имя обычно с большой буквы; если человек пишет строчными — берём первое
    // подходящее слово всё равно, но приводим к виду с большой буквы.
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return null;
}

/**
 * Сохраняет запись и СРАЗУ уведомляет сестру. Возвращает true, если запись
 * состоялась (тогда бот подтверждает человеку, что записал).
 */
export async function registerOfflineSignup(
  contact: { id: string; igUserId: string; username: string | null },
  text: string
): Promise<boolean> {
  const phone = extractPhone(text);
  if (!phone) return false; // без номера записывать некуда

  const name = extractName(text) ?? contact.username ?? "имя не указано";

  // Повторное «запишите меня» не плодит дубли и не шлёт второе уведомление.
  // Через create гонка двух сообщений подряд роняла исключение прямо в ответ ИИ
  // (человек не получал вообще ничего), поэтому — атомарный upsert.
  const existing = await prisma.offlineSignup.findUnique({ where: { contactId: contact.id } });
  if (existing) return true;

  let signup;
  try {
    signup = await prisma.offlineSignup.create({ data: { contactId: contact.id, name, phone } });
  } catch {
    return true; // успели параллельно — запись уже есть, уведомление уже ушло
  }

  await notifySister(signup.id, name, phone, contact.username);
  return true;
}

async function notifySister(signupId: string, name: string, phone: string, username: string | null): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatIds = await ownerAlertChatIds();
  if (!botToken || chatIds.length === 0) return;

  const who = username ? `@${username}` : "";
  // Дату берём из настройки, а не зашиваем в код: набор меняется каждый месяц,
  // и зашитая строка уже разъехалась с действительностью — сестре приходили
  // уведомления с датой прошлого курса.
  const date = await courseDateLabel();
  const text =
    `📝 Запись на ОФЛАЙН-курс (${date})\n\n` +
    `👤 ${name}\n` +
    `📲 ${phone}\n` +
    (who ? `📸 ${who}\n` : "") +
    `\nПросит записать. Предоплаты нет — позвонить за день до курса.`;

  try {
    for (const chatId of chatIds) await sendTelegramMessage(botToken, chatId, text);
    await prisma.offlineSignup.update({ where: { id: signupId }, data: { notified: true } });
  } catch (err) {
    logError("offlineSignup:notify", err);
  }
}
