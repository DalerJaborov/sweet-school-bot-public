/**
 * Чаты WhatsApp, где помощник не смог ответить и нужен человек
 * (WhatsAppInbox.status = "attention"). Причина хранится кодом, а хозяйке
 * показывается простыми словами — техника и тексты ошибок наружу не выходят.
 */
export type AttentionReason =
  | "media_unavailable" | "attachment" | "empty" | "too_big" | "save_failed"
  | "contact_check" | "other_account" | "restarted" | "generation" | "unclear_message" | "voice_unreadable";

export const ATTENTION_TEXT: Record<AttentionReason, string> = {
  media_unavailable: "Клиент прислал файл, который не удалось открыть",
  attachment: "Клиент прислал вложение, которое помощник не умеет читать",
  empty: "В сообщении нет текста, отвечать было нечего",
  too_big: "Файл слишком большой, помощник не смог его принять",
  save_failed: "Не получилось сохранить фото или голосовое клиента",
  contact_check: "Не удалось проверить, кто пишет, поэтому помощник не ответил",
  other_account: "К помощнику подключён другой номер WhatsApp",
  restarted: "Во время ответа сервис перезапускался — неизвестно, успел ли помощник ответить. Загляните в чат",
  generation: "Помощник не смог придумать ответ",
  unclear_message: "Непонятно, о чём пишет человек: помощник один раз уточнил и ясного ответа не получил",
  voice_unreadable: "Голосовое не удалось расшифровать, помощник не стал гадать",
};

export function attentionError(reason: AttentionReason, message: string): Error {
  return Object.assign(new Error(message), { attentionReason: reason });
}

export function classifyAttention(error: unknown): AttentionReason {
  const code = (error as { attentionReason?: string })?.attentionReason;
  return code && code in ATTENTION_TEXT ? code as AttentionReason : "generation";
}

export function attentionText(code: string | null | undefined): string {
  return ATTENTION_TEXT[(code ?? "generation") as AttentionReason] ?? ATTENTION_TEXT.generation;
}

export type AttentionKind = "text" | "photo" | "voice" | "file";

/** Что прислал клиент — из сохранённого события моста; вложение само наружу не отдаём. */
export function describeIncoming(payload: string): { text: string; kind: AttentionKind } {
  try {
    const e = JSON.parse(payload) as { text?: unknown; media?: { mimeType?: string }; mediaUnavailable?: string };
    const text = typeof e.text === "string" ? e.text.trim().slice(0, 500) : "";
    const mime = e.media?.mimeType ?? "";
    const kind: AttentionKind = mime.startsWith("image/") ? "photo" : mime.startsWith("audio/") ? "voice"
      : e.media || e.mediaUnavailable ? "file" : "text";
    return { text, kind };
  } catch { return { text: "", kind: "text" }; }
}

export function chatTitle(name: string | null | undefined, chatId: string): string {
  if (name?.trim()) return name.trim();
  const phone = /^(\d{7,15})@c\.us$/.exec(chatId)?.[1];
  return phone ? `+${phone}` : "Клиент WhatsApp";
}
