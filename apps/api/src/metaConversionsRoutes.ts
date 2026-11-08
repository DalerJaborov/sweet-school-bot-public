import { Router } from "express";
import { autoCatch } from "./asyncRoute.js";
import { conversionStatus, sendTestEvent } from "./metaConversions.js";

/** Панель «Покупки — в рекламу Meta». Подключается ПОСЛЕ проверки входа владельца. */
export const metaConversionsAdminRouter = autoCatch(Router());
metaConversionsAdminRouter.get("/status", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await conversionStatus());
});
metaConversionsAdminRouter.post("/test", async (_req, res) => {
  res.json(await sendTestEvent());
});
