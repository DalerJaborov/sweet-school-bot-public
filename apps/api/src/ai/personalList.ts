import { prisma, getSetting, setSetting } from "../db.js";

/**
 * РУЧНОЙ СПИСОК «ЭТО ЛИЧНЫЙ КОНТАКТ» (владелец 08.11.2026: «добавить всех родственников
 * из Инстаграма в исключение»). Хозяйка присылает ники Instagram и номера WhatsApp
 * списком — они попадают в настройку `personalList` (по одному в строке, ники без @,
 * номера только цифрами). Контакт, который уже есть, помечается личным сразу; который
 * ещё не писал, помечается в момент, когда о нём станет известен ник (profiles.ts) или
 * номер (whatsapp/worker.ts). personal=true потом снимает только владелец.
 */

const KEY = "personalList";

/** Ник Instagram или номер: приводит к ключу сравнения либо null, если строка пустая. */
export function normalizeEntry(raw: string): string | null {
  const t = raw.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").trim();
  if (!t) return null;
  if (/^[+\d][\d\s()-]{6,}$/.test(t)) return t.replace(/\D/g, "");
  const nick = t.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(nick) ? nick : null;
}

export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\n,;]+/).map(normalizeEntry).filter((x): x is string => !!x))];
}

export async function readPersonalList(): Promise<string[]> {
  return parseList((await getSetting(KEY)) ?? "");
}

export async function isListedPersonal(nameOrNick: string | null | undefined): Promise<boolean> {
  if (!nameOrNick) return false;
  const key = normalizeEntry(nameOrNick);
  return !!key && (await readPersonalList()).includes(key);
}

/** Добавить список; уже существующие контакты помечаются сразу. Возвращает сколько записей добавлено и контактов помечено. */
export async function importPersonalList(text: string): Promise<{ added: number; marked: number; invalid: number }> {
  const parts = text.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
  const entries = parseList(text);
  const known = new Set(await readPersonalList());
  const fresh = entries.filter((e) => !known.has(e));
  await setSetting(KEY, [...known, ...fresh].join("\n"));
  let marked = 0;
  for (const e of entries) {
    const isPhone = /^\d+$/.test(e);
    const res = await prisma.contact.updateMany({
      where: isPhone
        ? { channel: "WHATSAPP", OR: [{ name: { contains: e } }, { igUserId: { contains: e } }], personal: false }
        : { username: e, personal: false },
      data: { personal: true, personalReason: "Список личных контактов (добавлен владельцем)" },
    });
    marked += res?.count ?? 0;
  }
  return { added: fresh.length, marked, invalid: Math.max(0, parts.length - entries.length) };
}
