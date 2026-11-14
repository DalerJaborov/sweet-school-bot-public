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
 *   replySplitMaxParts — потолок частей (по умолчанию 2; на WhatsApp не больше 2).
 *
 * КАК ЧЕЛОВЕК, А НЕ КАК НОЖНИЦЫ (владелец 08.11.2026: «много текста, по кускам»).
 * Живой человек шлёт 1–2 коротких сообщения. Короткий ответ (до LONG_PART) не делим
 * никогда; длинный режем один раз, по границе предложения ближе к середине, а не
 * каждые 130 знаков посреди мысли.
 */

export interface SplitOptions {
  enabled: boolean;
  maxParts: number;
}

/** Номер оплаты, ссылка, номер карты: такие строки уходят отдельным сообщением. */
const DETAIL = /(?:\+?992[\s-]?)?905[\s-]?355[\s-]?355|https?:\/\/\S+|\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;

/** Дольше этого абзац делим на две части по предложениям; короче — не трогаем. */
const LONG_PART = 280;
/** Короче этого часть приклеиваем к соседней: «Да.» отдельным пузырём — странно. */
const TINY_PART = 24;

type Piece = { text: string; detail: boolean };

/**
 * Предложения. Режем только там, где после точки идёт заглавная буква, кавычка или цифра-начало,
 * и слово перед точкой не короткое сокращение или номер («450 с.», «г.», «ул.», «2.»):
 * иначе цена и адрес разваливаются между сообщениями.
 */
function sentences(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+\s+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph))) {
    const end = m.index + m[0].length;
    const before = paragraph.slice(start, m.index);
    const lastWord = before.split(/\s+/u).pop() ?? "";
    const next = paragraph.slice(end, end + 1);
    const abbreviation = m[0].startsWith(".") && /^[\p{L}\p{N}]{1,3}$/u.test(lastWord);
    const startsSentence = /[\p{Lu}"«(\p{N}]/u.test(next);
    if (!abbreviation && startsSentence) {
      out.push(paragraph.slice(start, m.index + m[0].trimEnd().length).trim());
      start = end;
    }
  }
  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/** Нумерованный или маркированный список режется только целиком — иначе «2.» уедет от своего пункта. */
function isList(paragraph: string): boolean {
  return (paragraph.match(/^\s*(\d+[.)]|[-•*])\s/gmu) ?? []).length >= 2;
}

/** Делит длинный абзац надвое по границе предложения, ближайшей к середине;
 *  половина всё ещё длинная — делит её так же (глубина ограничена длиной текста). */
function chunkProse(paragraph: string): string[] {
  const clean = paragraph.trim();
  if (!clean) return [];
  if (clean.length <= LONG_PART || isList(clean)) return [clean];
  const parts = sentences(clean);
  if (parts.length < 2) return [clean];
  const half = clean.length / 2;
  let best = 1;
  let bestGap = Infinity;
  let length = 0;
  for (let i = 1; i < parts.length; i++) {
    length += parts[i - 1].length + 1;
    const gap = Math.abs(length - half);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return [...chunkProse(parts.slice(0, best).join(" ")), ...chunkProse(parts.slice(best).join(" "))];
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
    if (at < 0) {
      // Остались только реквизиты и текст вперемешку: реквизит клеим к ПРЕДЫДУЩЕМУ тексту
      // (подпись «Номер для оплаты:» не отрывается от номера), а не к следующему.
      const firstDetail = out.findIndex((p, i) => p.detail && i > 0);
      at = firstDetail > 0 ? firstDetail - 1 : out.length - 2;
    }
    const both = out[at].detail && out[at + 1].detail;
    out[at] = {
      text: out[at].text + (out[at].detail || out[at + 1].detail ? "\n" : " ") + out[at + 1].text,
      detail: both,
    };
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
  settings: { instagram?: string | null; whatsapp?: string | null; web?: string | null; maxParts?: string | null },
): SplitOptions {
  const flag = channel === "WHATSAPP" ? settings.whatsapp : channel === "WEB" ? settings.web : settings.instagram;
  const configured = Number(settings.maxParts);
  // Живой человек отвечает 1–2 сообщениями (владелец 08.11.2026); больше — только настройкой.
  const defaultMax = 2;
  const maxParts = Number.isFinite(configured) && configured >= 1 ? configured : defaultMax;
  // На WhatsApp потолок моста (8 сообщений на чат за 10 минут) важнее любой настройки.
  return { enabled: flag !== "false", maxParts: channel === "WHATSAPP" ? Math.min(maxParts, 2) : maxParts };
}
