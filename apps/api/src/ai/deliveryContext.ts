import { deliveryModeFor } from "../course/delivery.js";

export async function replyDeliveryMode(contact: { channel: string }): Promise<"web" | "telegram" | "both"> {
  return deliveryModeFor(contact);
}

export async function deliveryPrompt(contact: { channel: string }): Promise<string> {
  const mode = await replyDeliveryMode(contact);
  return mode === "web"
    ? "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: личная ссылка на кабинет сайта. Вопросы по уроку — кнопка вопроса под уроком. Не отправляйте ученицу в Telegram-группу. Оплата должна быть подтверждена; не обещайте автоматическую выдачу по фотографии чека."
    : mode === "both"
      ? "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: личный кабинет сайта и закрытая Telegram-группа после подтверждения оплаты. Вопрос можно задать под уроком в кабинете."
      : "\nАКТУАЛЬНЫЙ СПОСОБ ДОСТУПА: закрытая Telegram-группа после подтверждения оплаты. Не приглашайте неоплативших и не обещайте автоматическую выдачу по фотографии чека.";
}
