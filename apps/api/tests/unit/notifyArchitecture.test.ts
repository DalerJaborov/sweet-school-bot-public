import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * СТОРОЖ «ОДНА ДВЕРЬ ДЛЯ УВЕДОМЛЕНИЙ В TELEGRAM» (ревью 11.11.2026; на него
 * ссылается notify.ts).
 *
 * Всё, что бот сам пишет владельцу или Ширин, идёт через `sendKind`
 * (notify.ts): вид решает, кому уходит, а под сообщением стоит «🔕 Не присылать
 * такое». Прямой вызов низкоуровневой отправки в Telegram мимо этой двери
 * допустим только в местах из белого списка — у каждого записана причина.
 * Новое место в белый список не добавляем: берём sendKind (для карточки, где
 * нужна кнопка решения, — вид «decision», он невыключаемый).
 */
const SRC = path.resolve(__dirname, "../../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");

/** Код без комментариев: упоминания в пояснениях — не вызовы. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

const files = walk(SRC).map((f) => ({ name: rel(f), src: code(f) }));

function callers(pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.src)).map((f) => f.name).sort();
}

/** Низкоуровневые отправки в Telegram: звать напрямую можно только отсюда. */
const RAW_SENDERS = /\b(sendTelegramMessage|sendMessageWithButtons|sendWithMarkup|sendReceiptForReview|sendTelegramVoice)\(/;

const RAW_SENDER_ALLOWED: Record<string, string> = {
  "telegram.ts": "здесь эти функции определены; sendKind — их единственный «массовый» вызывающий",
  "notify.ts": "сама дверь: sendKind",
  "telegramControl.ts": "ответ человеку в ЕГО личном чате на его слова и кнопки (меню, «выключи бота»)",
  "telegramMenu.ts": "ответ человеку в ЕГО личном чате на его кнопки и команды (меню, «выдать ссылку»)",
  "course/manualLink.ts": "ответ тому, кто прислал команду «выдай ссылку» (чат уже проверен trustedChatIds)",
  "course/manualOfflineSignup.ts": "ответ тому, кто прислал команду записи на офлайн (чат уже проверен trustedChatIds)",
  "qaGroup.ts": "ответ в учебной группе, откуда пришёл вопрос (не уведомление владельцу)",
  "course/chat.ts": "вопрос ученицы с платформы — в учебную группу или Ширин, чтобы она ответила реплаем; это не «уведомление»",
  "ai/receiptVerdict.ts": "карточка чека с ФОТО и кнопками «Подтвердить/Отклонить»: получатели — summaryChatIds() = вид «decision» (невыключаемый)",
  "stuckAlert.ts": "ДОЛГ: «активный интерес без покупки» уходит напрямую в telegramReportChatId с кнопками быстрых ответов; перевести на sendKind(кнопки) отдельной задачей",
};

/** Выбор получателей уведомлений: только тут и в самой двери. */
const RECIPIENT_LOOKUPS = /\b(ownerChatIds|shirinChatIds|summaryChatIds|chatsForKind)\(/;
const RECIPIENT_LOOKUP_ALLOWED: Record<string, string> = {
  "telegram.ts": "определения и маршрутизация по ролям",
  "notify.ts": "сама дверь: sendKind",
  "ai/receiptVerdict.ts": "получатели карточки чека (вид «decision»)",
  "course/phoneChange.ts": "проверка «есть ли кому слать» перед карточкой «Разрешить перенос» (вид «decision»); отправка — через sendKind",
  "appSecretWatch.ts": "проверка «есть ли кому слать» перед тем, как считать сторож сработавшим; отправка — через sendKind",
};

/** Чат-id владельцев в настройках напрямую: только эти файлы. */
const RAW_CHAT_SETTINGS = /["'](telegramReportChatId|telegramTechChatId|telegramOwnerChatId|telegramSummaryChatIds)["']/;
const RAW_CHAT_SETTINGS_ALLOWED: Record<string, string> = {
  "telegram.ts": "маршрутизация по ролям",
  "services/settingsService.ts": "список настроек панели",
  "miniApp.ts": "кому разрешён вход в мини-приложение (не отправка)",
  "course/chat.ts": "см. выше: вопрос ученицы Ширин",
  "stuckAlert.ts": "см. выше: долг",
};

describe("КЛАСС: уведомления владельцам идут только через sendKind", () => {
  it("прямые отправки в Telegram есть только в белом списке (и каждая — с причиной)", () => {
    const found = callers(RAW_SENDERS);
    const extra = found.filter((f) => !(f in RAW_SENDER_ALLOWED));
    expect(extra, `Прямая отправка в Telegram мимо sendKind: ${extra.join(", ")}. Используйте sendKind (notify.ts).`).toEqual([]);
  });

  it("белый список не копит мёртвые записи: каждый файл в нём реально зовёт отправку", () => {
    const found = new Set(callers(RAW_SENDERS));
    const stale = Object.keys(RAW_SENDER_ALLOWED).filter((f) => !found.has(f));
    expect(stale, `Уберите из белого списка: ${stale.join(", ")}`).toEqual([]);
  });

  it("получателей уведомлений выбирают только место маршрутизации, дверь и перечисленные проверки", () => {
    const extra = callers(RECIPIENT_LOOKUPS).filter((f) => !(f in RECIPIENT_LOOKUP_ALLOWED));
    expect(extra, `Свой выбор получателей мимо sendKind: ${extra.join(", ")}`).toEqual([]);
  });

  it("чат владельца из настроек напрямую читают только перечисленные файлы", () => {
    const rawFiles = files.filter((f) => RAW_CHAT_SETTINGS.test(f.src)).map((f) => f.name);
    const extra = rawFiles.filter((f) => !(f in RAW_CHAT_SETTINGS_ALLOWED));
    expect(extra, `Чат-id владельца читается мимо telegram.ts: ${extra.join(", ")}`).toEqual([]);
  });

  it("ЛОВУШКА СТОРОЖА: он действительно видит нарушение (иначе пустой список ничего не значит)", () => {
    expect(RAW_SENDERS.test("await sendTelegramMessage(token, chatId, text)")).toBe(true);
    expect(RAW_SENDERS.test("// sendTelegramMessage(x)".replace(/\/\/.*/, ""))).toBe(false);
    expect(callers(RAW_SENDERS)).toContain("notify.ts");
  });
});
