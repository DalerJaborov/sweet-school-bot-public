import { awaitingDeliveryChoice } from "./course/deliveryChoice.js";
import { withVerifiedReceiptDelivery } from "./messaging/automation.js";
import { prisma, logError, recordOutgoingMessage } from "./db.js";
import { type ClientLanguage } from "./ai/clientLanguage.js";
import { contactLanguage } from "./ai/contactLanguage.js";
import { sendToContact } from "./messaging/send.js";
import { markExamplesAsSuccessful } from "./ai/styleLearning.js";
import { planForAmount, ownedCourses, COURSE_50, COURSE_70, COURSE_TITLE, type Course, type Allocation } from "./courses.js";
import { closeCards } from "./receiptAlerts.js";
import { getPrices } from "./services/priceService.js";
import { grantCourses } from "./ai.js";

/** Курс, выбранный владельцем вручную — используется, когда сумма на чеке не
 *  прочиталась (см. courseChoice ниже): "BOTH" — оба курса разом. */
export type CourseChoice = Course | "BOTH";

/**
 * Решение владельца по подозрительному чеку — подтвердить или отклонить.
 * Вынесено из telegramWebhook.ts (handleDecision), чтобы тем же путём можно
 * было решать чек и из панели (см. admin.ts), не только кнопкой в Telegram:
 * владелец жаловался, что в панели «Чеки» решённые вопросы никуда не уходят —
 * там физически не было кнопки, только Telegram умел менять ownerDecision.
 */

/**
 * Отказ — на языке клиентки. Раньше текст был один, таджикский: русскоязычная
 * получала непонятное сообщение и уходила вместо того, чтобы прислать
 * нормальный чек. Рядом всё уже двуязычно (receiptVerdict.ts, offlineCourse.ts)
 * — здесь тот же приём: язык по последнему входящему.
 */
export const REJECT_TEXT: Record<ClientLanguage, string> = {
  tg:
    "Бубахшед, пардохт хозир тасдик нашуд. Боз як бор тафтиш кунен ва чеки дурустро фиристен, " +
    "аз истории банк хам мешавад. Ё занг занен: 905 355 355",
  ru:
    "Извините, оплату пока не удалось подтвердить. Проверьте ещё раз и пришлите правильный чек, " +
    "можно из истории банка. Или позвоните: 905 355 355",
  en:
    "Sorry, we couldn't confirm the payment yet. Please double-check and send the correct receipt " +
    "(you can take it from your bank history). Or call: 905 355 355",
};

/** Признаки того, что клиентку уже просили прислать чек/другой скриншот. */
const ASKED_FOR_RECEIPT =
  /Пришлите, пожалуйста, ещё один|Лутфан сурати дигар фиристед|could you send another one|оплату пока не удалось подтвердить|пардохт ҳоло тасдиқ нашуд|confirm the payment yet|Пришлите ещё один скрин|Боз як скриншот фиристен|send another screenshot|пардохт хозир тасдик нашуд/iu;

export type ReceiptDecisionResult =
  | { ok: true; status: "rejected"; message: string }
  | { ok: true; status: "approved"; message: string }
  | { ok: true; status: "approved_no_link"; message: string }
  | { ok: false; reason: "not_found" | "already_decided" | "no_access_configured" | "needs_course"; message: string };

export async function decideReceipt(
  receiptId: string,
  action: "approve" | "reject",
  courseChoice?: CourseChoice,
  opts: { reason?: string } = {}
): Promise<ReceiptDecisionResult> {
  const result = await decideReceiptInner(receiptId, action, courseChoice, opts);
  if (result.ok) {
    // Решение принято (кнопкой или из панели) - ВСЕ карточки этого чека в Telegram
    // (владельцу и сестре) теряют кнопки.
    const row = await prisma.receiptCheck.findUnique({ where: { id: receiptId }, select: { ownerAlerts: true } }).catch(() => null);
    if (row?.ownerAlerts) {
      const text = result.status === "rejected" ? "отклонено" : result.status === "approved" ? "подтверждено, ссылка отправлена" : "закрыто, ссылка не отправлялась";
      await closeCards(row, `Чек обработан: ${text}`).catch((err) => logError("receiptDecision:closeCards", err));
    }
  }
  return result;
}

async function decideReceiptInner(
  receiptId: string,
  action: "approve" | "reject",
  courseChoice?: CourseChoice,
  /** Причина отказа одним словом из панели («нет суммы», «чужой чек», «повтор»)
   *  — остаётся в журнале чека рядом с вердиктом ИИ. Клиентке не уходит. */
  opts: { reason?: string } = {}
): Promise<ReceiptDecisionResult> {
  // Сумма не прочиталась — решение владельца (25.08.2026 веч.): не угадывать
  // "70 сомони по умолчанию", а спрашивать явно, какой курс открыть. Проверка
  // ДО атомарного захвата ниже — если курс ещё не выбран, ничего не трогаем
  // в БД, само решение ещё не начато.
  if (action === "approve" && !courseChoice) {
    const check = await prisma.receiptCheck.findUnique({ where: { id: receiptId } });
    if (!check) return { ok: false, reason: "not_found", message: "Чек не найден" };
    if (check.ownerDecision && check.ownerDecision !== "PENDING") {
      return { ok: false, reason: "already_decided", message: "Уже обработано" };
    }
    if (check.amount == null) {
      return { ok: false, reason: "needs_course", message: "Сумма на чеке не прочиталась — выберите курс явно" };
    }
  }

  // Атомарный "захват" решения: UPDATE с условием в WHERE, а не отдельные
  // findUnique+update — иначе двойной тап (Telegram-кнопка и панель почти
  // одновременно) проходит оба раза мимо проверки "уже решено" и дублирует
  // исходящее сообщение/повторно выдаёт доступ.
  const claim = await prisma.receiptCheck.updateMany({
    where: { id: receiptId, OR: [{ ownerDecision: null }, { ownerDecision: "PENDING" }] },
    data: { ownerDecision: action === "approve" ? "APPROVED" : "REJECTED", decidedAt: new Date() },
  });
  if (claim.count === 0) {
    const existing = await prisma.receiptCheck.findUnique({ where: { id: receiptId } });
    if (!existing) return { ok: false, reason: "not_found", message: "Чек не найден" };
    return { ok: false, reason: "already_decided", message: "Уже обработано" };
  }
  const receipt = await prisma.receiptCheck.findUnique({ where: { id: receiptId }, include: { contact: true } });
  if (!receipt) return { ok: false, reason: "not_found", message: "Чек не найден" };

  if (action === "reject") {
    const lastIn = await prisma.message.findFirst({
      where: { contactId: receipt.contactId, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    // «Пришлите чек» не чаще одного раза за разговор: если бот уже просил другой
    // чек (или ответил, что номер чужой) в последние сутки, повторять просьбу
    // шаблоном не нужно - решение владельца записываем без второго сообщения.
    // Считаем только НАШИ шаблоны "пришлите другой чек"/"отклонено", отправленные
    // после этого чека (ревью architect: слова из реквизитов "пришлите скриншот
    // чека" не в счёт, иначе отказ после оплаты не на тот номер молчал бы).
    const recentOut = await prisma.message.findMany({
      where: { contactId: receipt.contactId, direction: "OUT", text: { not: null }, createdAt: { gte: receipt.createdAt } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { text: true },
    });
    const alreadyAsked = (recentOut ?? []).some((m) => ASKED_FOR_RECEIPT.test(m.text ?? ""));
    if (alreadyAsked) {
      if (opts.reason?.trim()) {
        await prisma.receiptCheck
          .update({ where: { id: receiptId }, data: { reason: `${receipt.reason} (отклонено: ${opts.reason.trim()})` } })
          .catch((err) => logError("receiptDecision:rejectReason", err));
      }
      return { ok: true, status: "rejected", message: "Отклонено. Клиентке не писали: чек уже просили недавно" };
    }
    const rejectText = REJECT_TEXT[await contactLanguage(receipt.contactId, lastIn?.text ?? "")];
    // Запись в историю — даже если отправка не удалась (как и раньше): владелец
    // должен видеть в переписке, что отказ был. Для сайта sendToContact сам
    // кладёт строку и отдаёт mid с префиксом — recordOutgoingMessage не дублирует.
    const mid = await sendToContact(receipt.contact, rejectText, [], { byHuman: true }).catch((err) => {
      logError("receiptDecision:rejectNotify", err);
      return null;
    });
    await recordOutgoingMessage(receipt.contactId, rejectText, mid);
    if (opts.reason?.trim()) {
      await prisma.receiptCheck
        .update({ where: { id: receiptId }, data: { reason: `${receipt.reason} (отклонено: ${opts.reason.trim()})` } })
        .catch((err) => logError("receiptDecision:rejectReason", err));
    }
    return { ok: true, status: "rejected", message: "Отклонено, клиенту отправлено сообщение" };
  }

  // Подтверждение: та же раскладка курсов, что и в автоматическом пути
  // (allocate + grantCourses из ai.ts) — см. историю бага в telegramWebhook.ts:
  // упрощённая логика раньше не создавала Purchase вовсе.
  //
  // Сумма прочиталась — считаем как обычно (allocate по сумме). Не прочиталась
  // — курс уже выбран владельцем явно (courseChoice, проверка выше это
  // гарантирует), раскладываем по выбору, а "сумма" — настоящая цена
  // выбранного курса, а не угаданное число.
  let amount: number;
  let plan: Allocation;
  if (receipt.amount != null) {
    amount = receipt.amount;
    // ТОЛЬКО курсы, которые даёт сама сумма чека, и только те, которых у клиентки
    // ещё нет (ревью PR 67): allocate() ради удобства раскладки мог выдать
    // "второй курс" за повторный чек на ту же сумму - то есть бесплатно.
    const own = await planForAmount(receipt.contactId, amount);
    const grant = own.grant;
    plan = {
      grant,
      note: grant.length > 0 ? `по сумме: ${grant.map((c) => COURSE_TITLE[c]).join(", ")}` : "этот курс у клиентки уже есть - ничего не выдано",
    };
  } else {
    const owned = await ownedCourses(receipt.contactId);
    const grant: Course[] =
      courseChoice === "BOTH"
        ? ([COURSE_50, COURSE_70] as Course[]).filter((c) => !owned.includes(c))
        : courseChoice && !owned.includes(courseChoice)
          ? [courseChoice]
          : [];
    const { price } = await getPrices();
    amount = grant.reduce((sum, c) => sum + price[c], 0);
    plan = {
      grant,
      note: grant.length > 0 ? `выбрано владельцем вручную: ${grant.map((c) => COURSE_TITLE[c]).join(", ")}` : "уже куплено",
    };
  }

  // ДОСТУП ПО ЭТОМУ КУРСУ БЫЛ ОТОЗВАН РАНЕЕ. Выдача никогда не оживляет
  // отозванное (grantCourses пропускает такую покупку), и раньше нажатие
  // «Подтвердить» упиралось в "не настроена группа" и оставляло карточку с
  // живыми кнопками (08.11.2026). Закрываем чек понятным ответом: вернуть
  // доступ можно осознанно в «Клиентах».
  const revokedRows = await prisma.purchase.findMany({
    where: { contactId: receipt.contactId, course: { in: plan.grant }, revokedAt: { not: null } },
    select: { course: true, revokedAt: true },
  });
  const revokedCourses = new Set((revokedRows ?? []).filter((r) => r.revokedAt).map((r) => r.course));
  if (revokedCourses.size > 0) {
    // Из комплекта убираем только отозванный курс; оплаченный второй выдаём.
    plan = { ...plan, grant: plan.grant.filter((c) => !revokedCourses.has(c)) };
  }
  if (plan.grant.length === 0 && revokedCourses.size > 0) {
    await prisma.receiptCheck.update({
      where: { id: receiptId },
      data: { ownerDecision: "APPROVED", decidedAt: new Date(), reason: `${receipt.reason} (доступ был отозван ранее)` },
    });
    return { ok: true, status: "approved_no_link", message: "Доступ по этому курсу был отозван ранее. Вернуть его можно в «Клиентах»." };
  }

  // A previous send failure preserves the paid purchase. Retry its delivery,
  // rather than allocating another course from the same payment amount.
  const pending = await prisma.purchase.findMany({
    where: { contactId: receipt.contactId, source: "RECEIPT", revokedAt: null, inviteLink: null, deliveryAwaitingChoice: false },
  });
  if (pending.some((p) => p.accessDeliveryUncertainAt)) {
    await prisma.receiptCheck.update({ where: { id: receiptId }, data: { ownerDecision: "PENDING", decidedAt: null, linkSent: false } });
    return { ok: false, reason: "no_access_configured", message: "Неизвестно, доставлена ли прежняя ссылка. Проверьте переписку и доступ ученицы; повторная отправка автоматически заблокирована." };
  }
  if (pending.length > 0) {
    // Повтор доставки ДОБАВЛЯЕТСЯ к курсам суммы, а не подменяет их (ревью PR 67).
    const retry = pending.map((p) => p.course).filter((c): c is Course => c === COURSE_50 || c === COURSE_70);
    plan = { ...plan, grant: [...new Set([...plan.grant, ...retry])], note: "повтор доставки оплаченного доступа" };
  }
  if (plan.grant.length === 0) {
    await prisma.receiptCheck.update({
      where: { id: receiptId },
      data: { ownerDecision: "APPROVED", decidedAt: new Date(), reason: `${receipt.reason} (${plan.note})` },
    });
    return { ok: true, status: "approved_no_link", message: `Закрыто как дубль. Ссылка не отправлена: ${plan.note}` };
  }

  let granted: Course[];
  try {
    granted = await withVerifiedReceiptDelivery(receipt.contact.id, receipt.imageHash, () => grantCourses(receipt.contact, plan, amount, { amount: receipt.amount, currency: "TJS" }, { byHuman: true }));
  } catch (err) {
    await prisma.receiptCheck.update({ where: { id: receiptId }, data: { ownerDecision: "PENDING", decidedAt: null, linkSent: false } });
    throw err;
  }
  if (await awaitingDeliveryChoice(receipt.contactId)) {
    await prisma.receiptCheck.update({ where: { id: receiptId }, data: { ownerDecision: "APPROVED", awaitingDeliveryChoice: true, linkSent: false, decidedAt: new Date() } });
    return { ok: true, status: "approved_no_link", message: "Оплата сохранена. Доступ ожидает выбора Telegram или сайта." };
  }
  if (granted.length < plan.grant.length) {
    await prisma.receiptCheck.update({ where: { id: receiptId }, data: { ownerDecision: "PENDING", decidedAt: null, linkSent: false } });
    return { ok: false, reason: "no_access_configured", message: "Не настроена группа/ссылка доступа" };
  }

  await prisma.contact
    .updateMany({ where: { id: receipt.contactId, paid: false }, data: { paid: true, paidAt: new Date() } })
    .catch((err) => {
      logError("receiptDecision:approve:markPaid", err);
    });
  // Разговор кончился оплатой — учим бота ровно так же, как автоматическое подтверждение.
  await markExamplesAsSuccessful(receipt.contactId).catch((err) => {
    logError("receiptDecision:approve:markExamples", err);
  });
  await prisma.receiptCheck.update({
    where: { id: receiptId },
    data: { ownerDecision: "APPROVED", decidedAt: new Date(), linkSent: true, reason: `${receipt.reason} (${plan.note})` },
  });
  return { ok: true, status: "approved", message: `Подтверждено, ссылка отправлена (${plan.note})` };
}
