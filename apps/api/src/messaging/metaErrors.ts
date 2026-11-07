export type MetaFailureKind = "TOKEN" | "WINDOW" | "RATE" | "TRANSIENT" | "PERMANENT" | "AMBIGUOUS";

export class MetaDeliveryError extends Error {
  constructor(public readonly kind: MetaFailureKind, public readonly status: number, public readonly code?: number, public readonly subcode?: number) {
    super(`Meta delivery ${kind} (HTTP ${status}, code ${code ?? "unknown"}, subcode ${subcode ?? "unknown"})`);
    this.name = "MetaDeliveryError";
  }
}

/** Keep response bodies (which may contain tokens or personal data) out of logs. */
export function metaResponseError(status: number, body: string): MetaDeliveryError {
  let error: { code?: number; error_subcode?: number; is_transient?: boolean; message?: string } = {};
  try { error = JSON.parse(body).error ?? {}; } catch { /* Unstructured provider response. */ }
  const kind: MetaFailureKind = error.code === 190 || status === 401 ? "TOKEN"
    : error.error_subcode === 2018278 || error.error_subcode === 2018001 || /outside.*(?:window|24)|24.hour.*window/i.test(error.message ?? "") ? "WINDOW"
    : status === 429 || [4, 17, 32, 613, 80004].includes(error.code ?? -1) ? "RATE"
    : status >= 500 || error.is_transient ? "TRANSIENT" : "PERMANENT";
  return new MetaDeliveryError(kind, status, error.code, error.error_subcode);
}

export function metaFailureKind(error: unknown): MetaFailureKind | null {
  return error instanceof MetaDeliveryError ? error.kind : null;
}

export function canRetryMetaFailure(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error && error.retryable === false) return false;
  const kind = metaFailureKind(error);
  return kind === null || kind === "RATE" || kind === "TRANSIENT";
}
