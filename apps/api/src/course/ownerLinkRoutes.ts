import { Router } from "express";
import { z } from "zod";
import { autoCatch } from "../asyncRoute.js";
import { logError } from "../db.js";
import { findPeople, issueOwnerLink, REASON_TEXT } from "./ownerLink.js";

/**
 * «ВЫДАТЬ ССЫЛКУ» ДЛЯ ЭКРАНА «СЕГОДНЯ» (08.11.2026).
 *
 * Подключается внутри adminRouter — под общим входом для всех /admin/*
 * (вошедший владелец или сестра). Отдельной двери здесь нет и быть не должно.
 * Ссылка наружу уходит только в ответ на явное нажатие: поиск ничего не выдаёт.
 */
export const ownerLinkRouter = autoCatch(Router());

ownerLinkRouter.get("/admin/access-link/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json({ people: await findPeople(q) });
});

const IssueBody = z.object({ contactId: z.string().min(1).max(64), kind: z.enum(["web", "telegram"]) });

ownerLinkRouter.post("/admin/access-link/issue", async (req, res) => {
  const body = IssueBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Выберите человека и способ" });
    return;
  }
  try {
    const result = await issueOwnerLink(body.data.contactId, body.data.kind);
    if (!result.ok) {
      res.status(409).json({ error: REASON_TEXT[result.reason], reason: result.reason });
      return;
    }
    res.json(result);
  } catch (err) {
    logError("admin:accessLink", err);
    res.status(500).json({ error: "Не получилось выдать ссылку. Попробуйте ещё раз." });
  }
});
