import { deliveryModeFor } from "../course/delivery.js";

type DeliveryContact = { channel: string; courseDeliveryChoice?: string | null };

export async function replyDeliveryMode(contact: DeliveryContact): Promise<"web" | "telegram" | "both"> {
  return deliveryModeFor(contact);
}

/**
 * Где человек будет смотреть уроки — одна строка для модели.
 *
 * С 11.11.2026 (владелец): уроки есть и в Telegram-группе, и на нашем сайте.
 * До оплаты бот говорит «в Telegram-группе или на нашем сайте, после оплаты
 * откроем, как вам удобно»; нет Telegram — «не беда, на нашем сайте, тоже
 * навсегда». Фраза «без Telegram нельзя» запрещена (и фильтром в replyPolicy).
 */
export async function deliveryPrompt(contact: DeliveryContact): Promise<string> {
  const mode = await replyDeliveryMode(contact);
  const chosenWeb = contact.courseDeliveryChoice === "web" && !["WEB", "MANUAL"].includes(contact.channel);
  if (chosenWeb) {
    return (
      "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: у этого человека нет Telegram (или ему так удобнее) — уроки откроем на нашем сайте, " +
      "по личной ссылке, она придёт сюда после оплаты; уроки остаются навсегда. Если он только что сказал, что Telegram нет, " +
      "коротко успокой: «Не беда, на нашем сайте смотрите, тоже навсегда» (по-таджикски: «Парво надорад, дар сайти мо мебинен, " +
      "вай хам хамеша мемонад»). Не отправляй его в Telegram-группу."
    );
  }
  return mode === "web"
    ? "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: личная ссылка на кабинет сайта. Вопросы по уроку — кнопка вопроса под уроком. Не отправляйте ученицу в Telegram-группу. Оплата должна быть подтверждена; не обещайте автоматическую выдачу по фотографии чека."
    : mode === "both"
      ? "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: личный кабинет сайта и закрытая Telegram-группа после подтверждения оплаты. Вопрос можно задать под уроком в кабинете."
      : "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: уроки в закрытой Telegram-группе или на нашем сайте — после оплаты откроем, как человеку удобно. " +
        "Нет Telegram — не беда: уроки на нашем сайте, тоже навсегда, ссылка придёт сюда после оплаты. Никогда не говори, что без Telegram нельзя " +
        "или что уроки только в Telegram. Не приглашай в группу неоплативших.";
}
