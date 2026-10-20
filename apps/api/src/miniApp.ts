import crypto from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { env } from "./env.js";
import { getSetting, logError } from "./db.js";

/**
 * ВХОД В ПАНЕЛЬ ИЗ TELEGRAM — без пароля.
 *
 * Мини-приложение это та же самая панель, открытая внутри Telegram. Разница
 * одна: кто ты, подтверждает сам Telegram, а не форма с паролем. При открытии он
 * передаёт странице строку `initData`, подписанную ключом, который выводится из
 * токена нашего бота. Проверить подпись может только тот, у кого этот токен есть
 * — то есть мы. Подделать её со стороны нельзя.
 *
 * Пускаем не любого, кто открыл бота, а ТОЛЬКО владельца и сестру — те же
 * chat_id, которым уходят карточки чеков. Иначе панель управления школой
 * открылась бы каждому, кто нашёл бота в поиске.
 */

export const miniAppRouter = Router();

/** Подпись живёт недолго: даже перехваченная строка станет бесполезной. */
const MAX_AGE_SECONDS = 24 * 3600;

/**
 * Проверка подписи по правилам Telegram: пары «ключ=значение» сортируются,
 * склеиваются через перевод строки, и от них берётся HMAC на секрете
 * `HMAC("WebAppData", botToken)`.
 */
function checkSignature(initData: string, botToken: string): Record<string, string> | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  // Сравнение постоянного времени: обычное сравнение строк подсказывает длину
  // совпавшего префикса и позволяет подбирать подпись по одному символу.
  const a = Buffer.from(hash);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return Object.fromEntries(params.entries());
}

/** Кому вообще можно в панель: владелец и сестра. */
async function isAllowed(userId: string): Promise<boolean> {
  const allowed = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
  ].filter(Boolean);
  return allowed.includes(userId);
}

/**
 * Обменивает подпись Telegram на обычный токен панели. Дальше мини-приложение
 * работает ровно как сайт — теми же запросами, с тем же токеном.
 */
miniAppRouter.post("/admin/telegram-login", async (req, res) => {
  const initData = typeof req.body?.initData === "string" ? req.body.initData : "";
  if (!initData) {
    res.status(400).json({ error: "Нет данных Telegram" });
    return;
  }

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) {
    res.status(503).json({ error: "Не задан маркер Telegram-бота" });
    return;
  }

  const data = checkSignature(initData, botToken);
  if (!data) {
    logError("miniApp", new Error("неверная подпись initData"));
    res.status(403).json({ error: "Подпись Telegram не сошлась" });
    return;
  }

  const authDate = Number(data.auth_date ?? 0);
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    res.status(403).json({ error: "Данные Telegram устарели, откройте панель заново" });
    return;
  }

  let userId = "";
  try {
    userId = String((JSON.parse(data.user ?? "{}") as { id?: number }).id ?? "");
  } catch {
    userId = "";
  }
  if (!userId || !(await isAllowed(userId))) {
    res.status(403).json({ error: "Этот аккаунт не имеет доступа к панели" });
    return;
  }

  // role обязателен: панель пускает только по нему (admin.ts isAdminToken).
  // Раньше здесь его не было — проверялась одна лишь подпись, и тем же
  // секретом подписывались ссылки учениц. Ширин заходит именно этим путём,
  // так что без role она осталась бы снаружи собственной панели.
  const token = jwt.sign({ role: "admin", sub: "admin", via: "telegram", tgId: userId }, env.jwtSecret, {
    expiresIn: "30d",
  });
  res.json({ token });
});
