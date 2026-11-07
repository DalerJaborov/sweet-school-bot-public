import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { autoCatch } from "./asyncRoute.js";
import { prisma } from "./db.js";
import { isReusableQaText } from "./ai/qaGroupReply.js";

/** Mount ONLY beneath authenticated /admin/v1/knowledge, after owner auth.
 * Approval applies to technical text, never to media or a public knowledge base. */
export const knowledgeReviewRouter = autoCatch(Router());
const approvalSchema = z.object({ approved: z.boolean(), courseId: z.string().trim().min(1).max(100).optional(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export function knowledgeReviewHash(row: { studentText: string; ownerText: string }): string {
  return createHash("sha256").update(JSON.stringify([row.studentText, row.ownerText])).digest("hex");
}

knowledgeReviewRouter.get("/examples", async (req, res) => {
  const parsed = z.object({ after: z.string().max(100).optional(), approved: z.enum(["true", "false"]).optional() }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Неверные параметры списка" }); return; }
  const [rows, courses] = await Promise.all([
    prisma.qaExample.findMany({
      where: {
        approvedForAnswer: parsed.data.approved === "true",
        studentText: { not: "" }, ownerText: { not: "" },
        ...(parsed.data.after ? { id: { gt: parsed.data.after } } : {}),
      },
      orderBy: { id: "asc" }, take: 21,
      select: { id: true, studentText: true, ownerText: true, courseId: true, approvedForAnswer: true },
    }),
    prisma.course.findMany({ where: { active: true }, orderBy: { order: "asc" }, select: { id: true, title: true } }),
  ]);
  const page = rows.slice(0, 20);
  res.setHeader("Cache-Control", "no-store");
  res.json({ examples: page.map((row) => ({ ...row, reviewHash: knowledgeReviewHash(row), eligible: isReusableQaText(row.studentText, row.ownerText) })), courses, nextCursor: rows.length > 20 ? page[page.length - 1].id : null });
});

knowledgeReviewRouter.post("/examples/:id", async (req, res) => {
  const parsed = approvalSchema.safeParse(req.body);
  if (!parsed.success || req.params.id.length > 100) { res.status(400).json({ error: "Нужны решение и выбранный курс" }); return; }
  const row = await prisma.qaExample.findUnique({ where: { id: req.params.id } });
  if (!row) { res.status(404).json({ error: "Ответ не найден" }); return; }
  if (parsed.data.approved) {
    if (parsed.data.reviewHash !== knowledgeReviewHash(row)) {
      res.status(409).json({ error: "Ответ изменился. Обновите список и проверьте его снова" }); return;
    }
    if (!parsed.data.courseId || !isReusableQaText(row.studentText, row.ownerText)) {
      res.status(400).json({ error: "Нужны конкретный курс, полный вопрос и самостоятельный ответ без пропущенного контекста" }); return;
    }
    const course = await prisma.course.findUnique({ where: { id: parsed.data.courseId }, select: { id: true, active: true } });
    if (!course?.active) { res.status(400).json({ error: "Выберите действующий курс" }); return; }
  }
  // Do not approve text changed after it was read for validation.
  const result = await prisma.qaExample.updateMany({
    where: { id: row.id, studentText: row.studentText, ownerText: row.ownerText },
    data: { approvedForAnswer: parsed.data.approved, courseId: parsed.data.approved ? parsed.data.courseId : null },
  });
  if (result.count !== 1) { res.status(409).json({ error: "Ответ изменился. Обновите список и проверьте его снова" }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});
