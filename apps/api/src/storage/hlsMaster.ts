import crypto from "node:crypto";

/**
 * РАЗБОР И СЛИЯНИЕ ПЛЕЙЛИСТОВ HLS — чистые функции без сети и диска.
 *
 * Нужны досозданию лёгких дорожек старым урокам (storage/lowRenditionBackfill.ts):
 * к готовому master.m3u8 дописываются строки новых дорожек, а всё, что в нём
 * уже было, остаётся байт в байт — на эти строки смотрят живые плееры и
 * телефоны с офлайн-копией.
 */

/** То же ограничение, что у выдачи манифестов (course/manifest.ts). */
export const VARIANT_NAME = /^[A-Za-z0-9_-]{1,16}$/;

export type MasterEntry = {
  /** Строка #EXT-X-STREAM-INF как есть. */
  inf: string;
  /** Путь дорожки, обычно "<имя>/index.m3u8". */
  uri: string;
  /** Имя дорожки — первый сегмент пути ("360p"). */
  name: string;
  bandwidth: number | null;
};

/** Значения атрибутов тега HLS: KEY=VALUE через запятую, VALUE в кавычках или без. */
export function parseAttributes(tagLine: string): Record<string, string> {
  const colon = tagLine.indexOf(":");
  const body = colon >= 0 ? tagLine.slice(colon + 1) : "";
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const raw = m[2];
    out[m[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

/** Дорожки мастер-плейлиста по порядку. Бросает, если это не мастер-плейлист. */
export function parseMaster(text: string): MasterEntry[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== "#EXTM3U") throw new Error("master.m3u8: нет заголовка #EXTM3U");
  const entries: MasterEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
    if (j >= lines.length) throw new Error("master.m3u8: у #EXT-X-STREAM-INF нет пути дорожки");
    const uri = lines[j];
    const name = uri.split("/")[0];
    const bw = Number.parseInt(parseAttributes(lines[i]).BANDWIDTH ?? "", 10);
    entries.push({ inf: lines[i], uri, name, bandwidth: Number.isFinite(bw) ? bw : null });
    i = j;
  }
  return entries;
}

/** Какие из нужных дорожек в мастер-плейлисте отсутствуют (порядок — как в `wanted`). */
export function missingVariants(masterText: string, wanted: readonly string[]): string[] {
  const have = new Set(parseMaster(masterText).map((e) => e.name));
  return wanted.filter((w) => !have.has(w));
}

/**
 * СЛИТЬ МАСТЕР-ПЛЕЙЛИСТЫ: к `existing` дописать дорожки из `added`, которых в
 * нём ещё нет. Старые строки не трогаются вовсе (ни порядок, ни атрибуты):
 * Safari стартует с ПЕРВОЙ дорожки списка, и она должна остаться прежней, а
 * hls.js всё равно сортирует дорожки по битрейту сам. Новые идут в конец, от
 * тяжёлой к лёгкой.
 *
 * Идемпотентно: если добавлять нечего, возвращается `existing` как есть —
 * повторный прогон не меняет файл ни на байт.
 */
export function mergeMaster(existing: string, added: string): string {
  const have = new Set(parseMaster(existing).map((e) => e.name));
  if (have.size === 0) throw new Error("master.m3u8: в существующем плейлисте нет ни одной дорожки");
  const fresh = parseMaster(added)
    // ffmpeg на Windows пишет "240p\index.m3u8"; в бакет и плеер — только "/".
    .map((e) => {
      const uri = e.uri.replace(/\\/g, "/");
      return { ...e, uri, name: uri.split("/")[0] };
    })
    .filter((e) => !have.has(e.name))
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  if (fresh.length === 0) return existing;
  for (const e of fresh) {
    if (!VARIANT_NAME.test(e.name) || e.uri !== `${e.name}/index.m3u8`) {
      throw new Error(`master.m3u8: неожиданный путь дорожки «${e.uri}»`);
    }
    if (!e.bandwidth) throw new Error(`master.m3u8: у дорожки ${e.name} нет BANDWIDTH`);
  }
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const body = existing.replace(/(\r?\n)+$/, "");
  return body + eol + fresh.map((e) => `${eol}${e.inf}${eol}${e.uri}${eol}`).join("");
}

export type KeyTag = {
  method: string;
  uri: string | null;
  /** 32 hex-знака без 0x; null — IV не указан (тогда IV = номер сегмента). */
  iv: string | null;
};

/** Все #EXT-X-KEY плейлиста дорожки. */
export function parseKeyTags(playlist: string): KeyTag[] {
  return playlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("#EXT-X-KEY"))
    .map((l) => {
      const a = parseAttributes(l);
      const iv = a.IV ? a.IV.replace(/^0x/i, "").toLowerCase() : null;
      return { method: a.METHOD ?? "", uri: a.URI ?? null, iv };
    });
}

export type VariantPlaylist = {
  mediaSequence: number;
  segments: string[];
  /** Сумма #EXTINF, секунды. */
  durationSec: number;
  ended: boolean;
};

/** Сегменты, длительность и признак конца плейлиста одной дорожки. */
export function parseVariant(playlist: string): VariantPlaylist {
  let mediaSequence = 0;
  let durationSec = 0;
  let ended = false;
  const segments: string[] = [];
  for (const raw of playlist.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSequence = Number.parseInt(l.split(":")[1], 10) || 0;
    else if (l.startsWith("#EXTINF:")) durationSec += Number.parseFloat(l.slice(8)) || 0;
    else if (l === "#EXT-X-ENDLIST") ended = true;
    else if (!l.startsWith("#")) segments.push(l);
  }
  return { mediaSequence, segments, durationSec, ended };
}

/** IV сегмента по правилам HLS: из тега, а без него — номер сегмента (128 бит, big-endian). */
export function segmentIv(tag: KeyTag, mediaSequence: number, index: number): Buffer {
  if (tag.iv) return Buffer.from(tag.iv.padStart(32, "0"), "hex");
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(mediaSequence + index), 8);
  return iv;
}

/** Расшифровать сегмент AES-128-CBC (PKCS7) — так шифрует ffmpeg с -hls_key_info_file. */
export function decryptSegment(body: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Похоже ли на MPEG-TS: байт синхронизации 0x47 каждые 188 байт. */
export function looksLikeMpegTs(buf: Buffer): boolean {
  if (buf.length < 188 || buf.length % 188 !== 0) return false;
  for (let off = 0; off < Math.min(buf.length, 188 * 8); off += 188) {
    if (buf[off] !== 0x47) return false;
  }
  return true;
}
