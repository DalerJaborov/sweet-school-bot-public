/**
 * ПЕРЕНОС ВЛОЖЕНИЙ С ЧУЖОГО ХРАНИЛИЩА MANYBOT НА НАШ СЕРВЕР — 11.11.2026.
 *
 * Владелец: «все возьми и видео и все вложения с менички на наш сервер перенеси».
 * Картинки и видео шагов воронки (и меню арт-десертов) лежат на S3 сервиса
 * manybot: он может их удалить в любой день, и бот начнёт слать пустоту.
 *
 * Что делает:
 *  1) находит ссылки manybot в FunnelStep.mediaUrl и в Setting menuMediaUrls;
 *  2) скачивает каждый файл в /data/uploads/mb-<sha1(ссылки)[0..16]>.<расширение>
 *     (имя выводится из старой ссылки — повторный запуск не плодит копии, а код
 *     может заранее ссылаться на новый адрес, см. ai/menuImages.ts);
 *  3) проверяет: ответ 200, тип image/* или video/*, размер > 0 и совпадает с
 *     Content-Length;
 *  4) только с APPLY=1: пишет бэкап старых ссылок в Setting
 *     manybotMediaBackup20261111@<время> и меняет ссылки одной транзакцией.
 *     Ссылка меняется, только если файл скачан и проверен.
 *
 * ПО УМОЛЧАНИЮ ТОЛЬКО ПОКАЗЫВАЕТ (и всё же скачивает файлы — это безвредно:
 * новые имена, на них ещё никто не ссылается). Секретов не печатает.
 *
 * Запуск на сервере (после выкатки кода и скрипта текстов, с «да» владельца):
 *   cd /opt/sweet-school-bot
 *   docker compose exec -T api node --input-type=module - < ops/2026-11-11-move-manybot-media.mjs
 *   docker compose exec -T -e APPLY=1 api node --input-type=module - < ops/2026-11-11-move-manybot-media.mjs
 * Откат: значения из Setting manybotMediaBackup20261111@<время> вернуть на место.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_MODULE = process.env.DB_MODULE ?? "/app/apps/api/dist/db.js";
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/data/uploads";
const APPLY = process.env.APPLY === "1";
const { prisma } = await import(DB_MODULE);

const FOREIGN = /^https:\/\/manybot-[a-z]+\.s3\.[a-z0-9-]+\.amazonaws\.com\//u;
const base = (process.env.PUBLIC_BASE_URL ?? "https://shirinsweets.online").replace(/\/+$/u, "");

export function localNameFor(url) {
  const ext = (/\.([a-z0-9]{2,5})(?:\?|$)/iu.exec(new URL(url).pathname)?.[1] ?? "bin").toLowerCase();
  return `mb-${createHash("sha1").update(url).digest("hex").slice(0, 16)}.${ext}`;
}

async function download(url) {
  const name = localNameFor(url);
  const target = path.join(UPLOAD_DIR, name);
  const newUrl = `${base}/media/${name}`;
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return { ok: true, newUrl, size: fs.statSync(target).size, cached: true };
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) return { ok: false, why: `ответ ${res.status}` };
  if (!/^(image|video)\//u.test(type)) return { ok: false, why: `тип «${type}»` };
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = Number(res.headers.get("content-length") ?? buf.length);
  if (buf.length === 0 || buf.length !== expected) return { ok: false, why: `размер ${buf.length} из ${expected}` };
  fs.writeFileSync(`${target}.part`, buf);
  fs.renameSync(`${target}.part`, target);
  return { ok: true, newUrl, size: buf.length, cached: false };
}

const steps = await prisma.funnelStep.findMany({ where: { mediaUrl: { contains: "manybot" } }, select: { id: true, mediaUrl: true } });
const menuSetting = await prisma.setting.findUnique({ where: { key: "menuMediaUrls" } });
const urls = new Set(steps.map((s) => s.mediaUrl).filter((u) => FOREIGN.test(u)));
for (const u of menuSetting?.value?.match(/https:\/\/manybot-[^"\s]+/gu) ?? []) urls.add(u);

console.log(`Найдено ссылок manybot: ${urls.size} (шагов воронки: ${steps.length}, в menuMediaUrls: ${menuSetting?.value?.includes("manybot") ? "да" : "нет"})`);
const mapped = new Map();
let failed = 0;
for (const u of urls) {
  try {
    const r = await download(u);
    if (r.ok) {
      mapped.set(u, r.newUrl);
      console.log(`  OK ${r.cached ? "(уже был)" : ""} ${Math.round(r.size / 1024)} КБ  ${u.split("/").pop()} → ${r.newUrl}`);
    } else {
      failed += 1;
      console.log(`  НЕ СКАЧАЛСЯ (${r.why}): ${u.split("/").pop()} — ссылку не трогаем`);
    }
  } catch (err) {
    failed += 1;
    console.log(`  ОШИБКА: ${u.split("/").pop()} — ${String(err).slice(0, 120)} — ссылку не трогаем`);
  }
}

const stepUpdates = steps.filter((s) => mapped.has(s.mediaUrl));
let newMenu = menuSetting?.value ?? null;
if (newMenu) for (const [from, to] of mapped) newMenu = newMenu.split(from).join(to);
const menuChanged = menuSetting && newMenu !== menuSetting.value;
console.log(`Изменится: шагов воронки ${stepUpdates.length}, menuMediaUrls ${menuChanged ? "да" : "нет"}; не скачалось: ${failed}`);

if (!APPLY) {
  console.log("СУХОЙ ПРОГОН — в базе ничего не изменено. Записать: APPLY=1.");
} else if (stepUpdates.length === 0 && !menuChanged) {
  console.log("Нечего менять.");
} else {
  const backupKey = `manybotMediaBackup20261111@${new Date().toISOString()}`;
  const backup = { steps: stepUpdates.map((s) => ({ id: s.id, mediaUrl: s.mediaUrl })), menuMediaUrls: menuChanged ? menuSetting.value : undefined };
  await prisma.$transaction([
    prisma.setting.create({ data: { key: backupKey, value: JSON.stringify(backup) } }),
    ...stepUpdates.map((s) => prisma.funnelStep.update({ where: { id: s.id }, data: { mediaUrl: mapped.get(s.mediaUrl) } })),
    ...(menuChanged ? [prisma.setting.update({ where: { key: "menuMediaUrls" }, data: { value: newMenu } })] : []),
  ]);
  console.log(`ЗАПИСАНО. Бэкап: Setting ${backupKey}`);
}
await prisma.$disconnect();
