/**
 * Клиент публичного API сайта (/api/site/*, контракт site-contract.md).
 * Ни одному маршруту не нужен токен: посетителя узнают по httpOnly-куке
 * ssb_visitor, поэтому все запросы идут с credentials: "same-origin".
 */

import type { Lang } from "./i18n";

export type SiteCourse = {
  code: string;
  title: string;
  description: string | null;
  price: number;
  currency: string;
  coverUrl: string | null;
  lessonsCount: number;
  durationMin: number;
};

export type Catalog = {
  courses: SiteCourse[];
  bundle: { price: number; fullPrice: number } | null;
  offline: {
    price: number;
    currency: string;
    nextStartDate: string | null;
    info: Record<Lang, string> | null;
  };
  contacts: {
    phone: string;
    whatsapp: string;
    telegram: string;
    instagram: string;
    tiktok: string;
  };
};

/**
 * Названия курсов в базе бота хранятся с ценой в скобках («Арт-десерты
 * (50 сомони)») — в переписке так удобнее. На сайте цена рисуется отдельно,
 * поэтому хвост «(NN …)» отрезаем, иначе она бы удвоилась.
 */
export function displayTitle(title: string): string {
  return title.replace(/\s*\(\s*\d[\d\s.,]*\s*[^)]*\)\s*$/u, "").trim() || title;
}

export type ChatMsg = {
  id: string;
  from: "client" | "bot" | "owner";
  text: string | null;
  imageUrl: string | null;
  at: string;
};

export type ChatBatch = { messages: ChatMsg[]; pending?: boolean };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "network");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; retryAfterSec?: number };
    throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.retryAfterSec);
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const api = {
  catalog: () => request<Catalog>("/api/site/courses"),

  offlineSignup: (body: { name: string; phone: string; lang: Lang }) =>
    request<{ ok: true }>("/api/site/offline-signup", json(body)),

  chatStart: (lang: Lang) => request<{ visitorId: string; messages: ChatMsg[] }>("/api/site/chat/start", json({ lang })),

  chatSend: (text: string, image?: File | null): Promise<ChatBatch> => {
    if (!image) return request<ChatBatch>("/api/site/chat/send", json({ text }));
    const fd = new FormData();
    fd.append("image", image, image.name);
    if (text) fd.append("text", text);
    return request<ChatBatch>("/api/site/chat/send", { method: "POST", body: fd });
  },

  chatPoll: (after: string | null) =>
    request<ChatBatch>(`/api/site/chat/poll${after ? `?after=${encodeURIComponent(after)}` : ""}`),
};
