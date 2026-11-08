/**
 * ОТВЕТ ТЕКСТОМ — КАК У ЖИВОГО ЧЕЛОВЕКА (решение владельца 08.11.2026):
 * не одно длинное полотно, а несколько коротких сообщений подряд.
 *
 * Модель сама ставит разделитель «---» (правило 5 в prompts.ts), но слушается его не
 * всегда. Этот модуль страхует кодом: режет длинный абзац по границам предложений
 * (слово посередине не режется), а ссылки и реквизиты оплаты выносит отдельным
 * сообщением — так их удобно копировать одним касанием.
 *
 * Пауза между частями и «печатает…» — не здесь: их держат sendText (Instagram) и мост
 * WhatsApp (антибан-темп). Здесь только ПОТОЛОК числа частей: на WhatsApp у моста лимит
 * сообщений на чат, и лишние части съедают его, поэтому там не больше двух частей.
 *
 * Рубильники (настройки без пересборки, по умолчанию включено):
 *   replySplitInstagram, replySplitWhatsapp, replySplitWeb = "false" — ответ одним куском;
 *   replySplitMaxParts — потолок частей (по умолчанию 4; на WhatsApp не больше 2).
 */

export interface SplitOptions {
  enabled: boolean;
  maxParts: number;
}

/** Номер оплаты, ссылка, номер карты: такие строки уходят отдельным сообщением. */
const DETAIL = /(?:\+?992[\s-]?)?905[\s-]?355[\s-]?355|https?:\/\/\S+|\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;

/** Дольше этого абзац режем по предложениям. */
const LONG_PART = 170;
/** Целевая длина одной части при нарезке. */
const TARGET_PART = 130;
/** Короче этого часть приклеиваем к соседней: «Да.» отдельным пузырём — странно. */
const TINY_PART = 24;

type Piece = { text: string; detail: boolean };

function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function chunkProse(paragraph: string): string[] {
  const clean = paragraph.trim();
  if (!clean) return [];
  if (clean.length <= LONG_PART) return [clean];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences(clean)) {
    if (current && (current + " " + sentence).length > TARGET_PART) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? current + " " + sentence : sentence;
    }
  }
  if (current) out.push(current);
  return out;
}

function mergeTiny(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev && !prev.detail && !piece.detail && (piece.text.length < TINY_PART || prev.text.length < TINY_PART)) {
      prev.text = prev.text + " " + piece.text;
    } else {
      out.push({ ...piece });
    }
  }
  return out;
}

function capParts(pieces: Piece[], maxParts: number): Piece[] {
  const out = pieces.map((p) => ({ ...p }));
  while (out.length > maxParts) {
    // Сначала склеиваем соседние «обычные» куски; реквизиты остаются отдельными.
    let at = -1;
    for (let i = out.length - 2; i >= 0; i--) {
      if (!out[i].detail && !out[i + 1].detail) {
        at = i;
        break;
      }
    }
    if (at < 0) at = out.length - 2;
    const both = out[at].detail && out[at + 1].detail;
    out[at] = { text: out[at].text + (out[at].detail || out[at + 1].detail ? "\n" : " ") + out[at + 1].text, detail: both };
    out.splice(at + 1, 1);
  }
  return out;
}

export function splitHumanLike(text: string, options: SplitOptions): string[] {
  const explicit = text
    .split(/^\s*-{3,}\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
  const maxParts = Math.max(1, Math.min(6, Math.floor(options.maxParts) || 1));
  if (explicit.length === 0) return [];

  if (!options.enabled) {
    // Старое поведение: только то, что модель сама разделила «---», с потолком.
    if (explicit.length <= maxParts) return explicit;
    return [...explicit.slice(0, maxParts - 1), explicit.slice(maxParts - 1).join(" ")];
  }

  const pieces: Piece[] = [];
  for (const part of explicit) {
    // Реквизиты и ссылки — строкой в отдельное сообщение; остальные строки — текст.
    let prose: string[] = [];
    const flush = () => {
      if (prose.length) {
        for (const chunk of chunkProse(prose.join("\n"))) pieces.push({ text: chunk, detail: false });
        prose = [];
      }
    };
    for (const line of part.split(/\n+/)) {
      if (DETAIL.test(line) && line.trim().length <= 160) {
        flush();
        pieces.push({ text: line.trim(), detail: true });
      } else {
        prose.push(line.trim());
      }
    }
    flush();
  }
  return capParts(mergeTiny(pieces), maxParts).map((p) => p.text);
}

/** Настройки канала: рубильник и потолок частей. */
export function splitOptionsFor(
  channel: string,
  settings: { instagram?: string | null; whatsapp?: string | null; web?: string | null; maxParts?: string | null }
): SplitOptions {
  const flag = channel === "WHATSAPP" ? settings.whatsapp : channel === "WEB" ? settings.web : settings.instagram;
  const configured = Number(settings.maxParts);
  const defaultMax = channel === "WHATSAPP" ? 2 : 4;
  const maxParts = Number.isFinite(configured) && configured >= 1 ? configured : defaultMax;
  // На WhatsApp потолок моста (8 сообщений на чат за 10 минут) важнее любой настройки.
  return { enabled: flag !== "false", maxParts: channel === "WHATSAPP" ? Math.min(maxParts, 2) : maxParts };
}
