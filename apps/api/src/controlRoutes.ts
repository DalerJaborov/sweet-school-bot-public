import { Router } from "express";
import { z } from "zod";
import { autoCatch } from "./asyncRoute.js";
import {
  describeBotState,
  getBotState,
  pauseFunnels,
  resumeFunnels,
  setAiReplies,
  setCommentReplies,
  setFrozen,
  startEverything,
  stopEverything,
} from "./botControl.js";
import { NOTIFY_INFO, MUTABLE_KINDS, isNotifyKind } from "./notifyKinds.js";
import { mutedKinds, setKindEnabled, setShirinEnabled, shirinEnabled } from "./telegram.js";
import { resetTodayCache } from "./today.js";

/**
 * УПРАВЛЕНИЕ БОТОМ И УВЕДОМЛЕНИЯМИ ДЛЯ ПАНЕЛИ (11.11.2026) — те же действия, что
 * кнопки в Telegram (telegramControl.ts), через тот же модуль botControl.ts.
 * Вход — общий админский (adminRouter), отдельного доступа не заводим.
 */
export const controlRouter = autoCatch(Router());

const ACTIONS = [
  "ai_on",
  "ai_off",
  "freeze_on",
  "freeze_off",
  "funnels_pause",
  "funnels_resume",
  "comments_on",
  "comments_off",
  "stop_all",
  "start_all",
] as const;

async function stateResponse() {
  const state = await getBotState();
  return { state, lines: describeBotState(state) };
}

controlRouter.get("/admin/v1/bot-control", async (_req, res) => {
  res.json(await stateResponse());
});

controlRouter.post("/admin/v1/bot-control", async (req, res) => {
  const parsed = z.object({ action: z.enum(ACTIONS) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неизвестное действие" });
    return;
  }
  switch (parsed.data.action) {
    case "ai_on":
      await setAiReplies(true);
      break;
    case "ai_off":
      await setAiReplies(false);
      break;
    case "freeze_on":
      await setFrozen(true);
      break;
    case "freeze_off":
      await setFrozen(false);
      break;
    case "funnels_pause":
      await pauseFunnels();
      break;
    case "funnels_resume":
      await resumeFunnels();
      break;
    case "comments_on":
      await setCommentReplies(true);
      break;
    case "comments_off":
      await setCommentReplies(false);
      break;
    case "stop_all":
      await stopEverything();
      break;
    case "start_all":
      await startEverything();
      break;
  }
  resetTodayCache();
  res.json(await stateResponse());
});

async function notificationsResponse() {
  const [owner, shirin, shirinOn] = await Promise.all([mutedKinds("owner"), mutedKinds("shirin"), shirinEnabled()]);
  return {
    shirinEnabled: shirinOn,
    kinds: MUTABLE_KINDS.map((id) => ({
      id,
      label: NOTIFY_INFO[id].label,
      hint: NOTIFY_INFO[id].hint,
      audience: NOTIFY_INFO[id].audience,
      owner: !owner.has(id),
      // Ширин получает только «главное»; служебное — null (нет такого переключателя).
      shirin: NOTIFY_INFO[id].audience === "main" ? !shirin.has(id) : null,
    })),
  };
}

controlRouter.get("/admin/v1/notifications", async (_req, res) => {
  res.json(await notificationsResponse());
});

controlRouter.put("/admin/v1/notifications", async (req, res) => {
  const parsed = z
    .union([
      z.object({ role: z.enum(["owner", "shirin"]), kind: z.string(), enabled: z.boolean() }),
      z.object({ shirinEnabled: z.boolean() }),
    ])
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Не понял, что менять" });
    return;
  }
  if ("shirinEnabled" in parsed.data) {
    await setShirinEnabled(parsed.data.shirinEnabled);
  } else {
    const { role, kind, enabled } = parsed.data;
    if (!isNotifyKind(kind)) {
      res.status(400).json({ error: "Неизвестный вид уведомления" });
      return;
    }
    if (NOTIFY_INFO[kind].locked) {
      res.status(400).json({ error: "Это выключить нельзя: без вашей кнопки дело встанет" });
      return;
    }
    if (role === "shirin" && NOTIFY_INFO[kind].audience !== "main") {
      res.status(400).json({ error: "Служебное Ширин не приходит" });
      return;
    }
    await setKindEnabled(role, kind, enabled);
  }
  res.json(await notificationsResponse());
});
