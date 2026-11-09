import { z } from "zod";

export const bridgeEventSchema = z.object({
  id: z.string().min(1).max(300), accountId: z.string().min(1).max(100),
  type: z.enum(["incoming", "human"]), chatId: z.string().min(1).max(150),
  messageId: z.string().min(1).max(300), timestamp: z.number().int().min(1e12),
  text: z.string().max(12000).default(""),
  mediaUnavailable: z.string().max(100).optional(),
  takenOver: z.boolean().optional(),
  media: z.object({ data: z.string().max(12 * 1024 * 1024), mimeType: z.string().max(100), filename: z.string().max(250).optional() }).optional(),
  // Метка рекламы «клик в WhatsApp» (contextInfo.externalAdReply / ctwaContext
  // в WhatsApp Web). Мост пока её не присылает — поле готово заранее, см. metaConversions.ts.
  ad: z.object({
    ctwaClid: z.string().max(500).optional(), sourceId: z.string().max(100).optional(),
    sourceType: z.string().max(40).optional(),
  }).optional(),
});
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export type ContactStatus = { blocked: boolean; isMyContact: boolean | null; identityResolved: boolean; takenOver: boolean; aliases?: string[] };
export function whatsappMessageId(accountId: string, messageId: string): string { return `wa:${accountId}:${messageId}`; }
export function whatsappConfigured(): boolean {
  return !!process.env.SCHOOL_WHATSAPP_URL && (process.env.SCHOOL_WHATSAPP_TOKEN?.length ?? 0) >= 32;
}
export class BridgeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function bridgeRequest<T>(path: string, body?: unknown): Promise<T> {
  if (!whatsappConfigured()) throw new BridgeError(503, "Подключение WhatsApp ещё не настроено");
  const response = await fetch(`${process.env.SCHOOL_WHATSAPP_URL!.replace(/\/$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${process.env.SCHOOL_WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === "/send" ? 60000 : 15000),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new BridgeError(response.status, data.error || "WhatsApp временно недоступен");
  return data;
}
