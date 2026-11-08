import crypto from "node:crypto";
import { Router } from "express";
import { getSetting, logError } from "./db.js";
import { createFailureGate, limiterKey, signAdminToken } from "./adminLogin.js";

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

/** Считаем только неудачи (20 с адреса за 15 минут): верная подпись в лимит не упирается,
 * поток мусора не может закрыть вход владельцу. */
const gate = createFailureGate(20);
export const resetMiniAppLimits = () => gate.reset();

/** Подпись живёт недолго: даже перехваченная строка станет бесполезной. */
const MAX_AGE_SECONDS = 3600;

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
  if (process.env.SCHOOL_ACCESS_REQUIRED === "1") {
    res.status(403).json({ error: "Вход через Telegram отключён. Откройте панель в браузере." });
    return;
  }
  const key = limiterKey(req);
  if (gate.blocked(key)) {
    res.status(429).json({ error: "Слишком много попыток. Подождите немного." });
    return;
  }
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
    gate.fail(key);
    logError("miniApp", new Error("неверная подпись initData"));
    res.status(403).json({ error: "Подпись Telegram не сошлась" });
    return;
  }

  const authDate = Number(data.auth_date ?? 0);
  if (
    !Number.isFinite(authDate) ||
    authDate > Date.now() / 1000 + 30 ||
    Date.now() / 1000 - authDate > MAX_AGE_SECONDS
  ) {
    gate.fail(key);
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
    gate.fail(key);
    res.status(403).json({ error: "Этот аккаунт не имеет доступа к панели" });
    return;
  }

  // role обязателен: панель пускает только по нему (admin.ts isAdminToken).
  // Раньше здесь его не было — проверялась одна лишь подпись, и тем же
  // секретом подписывались ссылки учениц. Ширин заходит именно этим путём,
  // так что без role она осталась бы снаружи собственной панели.
  const token = signAdminToken({ sub: "admin", via: "telegram", tgId: userId });
  res.json({ token });
});
