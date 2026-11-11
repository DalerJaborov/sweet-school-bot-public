import { prisma, getSetting, setSetting, logError } from "./db.js";
import { sendKind } from "./notify.js";
import { COURSE_50, COURSE_70, COURSE_TITLE } from "./courses.js";

/**
 * «ПРИШЛА ОПЛАТА» — ОДНО СООБЩЕНИЕ НА КАЖДУЮ ПОКУПКУ (11.11.2026).
 *
 * Владелец и Ширин хотят видеть главное: деньги. Раньше отдельного сообщения об
 * оплате не было вовсе — только итог дня в 23:00. Платёж попадает в базу тремя
 * путями (бот сам принял чек, владелец нажал «Подтвердить», выдали руками), и
 * ловить «момент» в каждом из них — это лезть в чужие файлы и пропускать четвёртый
 * путь. Поэтому здесь сторож по самой таблице покупок: раз в полминуты берём
 * покупки новее отметки и пишем по одной строке на человека (комплект из двух
 * курсов — одна строка, а не две).
 *
 * Первый запуск ставит отметку на «сейчас» и молчит: историю не высылаем.
 * Отметка — в базе (контейнер перезапускается при каждой выкатке); чтобы не
 * потерять покупку, записанную чуть «задним числом», окно перекрывается на две
 * минуты, а уже названные id запоминаются. Вид уведомления — «payment»: главное,
 * идёт владельцу и Ширин, выключается кнопкой под сообщением.
 */
const CURSOR_KEY = "paymentNotifyCursor";
const SEEN_KEY = "paymentNotifySeen";
const OVERLAP_MS = 2 * 60_000;
const SEEN_LIMIT = 200;

const COURSE_SHORT: Record<string, string> = {
  [COURSE_50]: COURSE_TITLE[COURSE_50],
  [COURSE_70]: COURSE_TITLE[COURSE_70],
};

function parseSeen(raw: string | null): string[] {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function runPaymentNotifications(now = new Date()): Promise<number> {
  const rawCursor = (await getSetting(CURSOR_KEY))?.trim();
  const cursor = rawCursor ? new Date(rawCursor) : null;
  if (!cursor || Number.isNaN(cursor.getTime())) {
    await setSetting(CURSOR_KEY, now.toISOString());
    return 0;
  }

  const seen = new Set(parseSeen(await getSetting(SEEN_KEY)));
  const rows = (
    await prisma.purchase.findMany({
      where: { createdAt: { gt: new Date(cursor.getTime() - OVERLAP_MS) }, revokedAt: null, amount: { gt: 0 } },
      orderBy: { createdAt: "asc" },
      include: { contact: { select: { username: true, igUserId: true } } },
      take: 100,
    })
  ).filter((p) => !seen.has(p.id));
  if (rows.length === 0) return 0;

  // Отметка ДО отправки: при сбое Telegram лучше пропустить сообщение, чем
  // повторять его каждые полминуты.
  const newest = rows.reduce((t, p) => (p.createdAt > t ? p.createdAt : t), cursor);
  await setSetting(CURSOR_KEY, newest.toISOString());
  await setSetting(SEEN_KEY, JSON.stringify([...seen, ...rows.map((p) => p.id)].slice(-SEEN_LIMIT)));

  const byPerson = new Map<string, typeof rows>();
  for (const p of rows) byPerson.set(p.contactId, [...(byPerson.get(p.contactId) ?? []), p]);

  let sent = 0;
  for (const list of byPerson.values()) {
    const c = list[0].contact;
    const who = c.username ? `@${c.username}` : `ID ···${c.igUserId.slice(-6)}`;
    const courses = [...new Set(list.map((p) => COURSE_SHORT[p.course] ?? p.course))].join(" + ");
    const sum = list.reduce((t, p) => t + p.amount, 0);
    const manual = list.every((p) => p.source === "MANUAL") ? " (выдано вручную)" : "";
    const text = `💰 Оплата: ${who} — ${courses}, ${sum} сомони${manual}`;
    try {
      // Сбой отправки идёт в журнал ошибок (sendKind → logError), а не только в консоль:
      // деньги — главное, пропавшее сообщение об оплате должно быть видно в панели.
      sent += await sendKind("payment", text);
    } catch (err) {
      logError("paymentNotify", err);
    }
  }
  return sent;
}
