import { Router } from "express";
import { z } from "zod";
import { prisma, getSetting } from "../db.js";
import { writeSettings } from "../services/settingsService.js";
import { autoCatch } from "../asyncRoute.js";

// Mounted behind the existing admin authentication middleware.
export const freeLessonAdminRouter = autoCatch(Router());

freeLessonAdminRouter.get("/admin/free-lesson", async (_req, res) => {
  const [enabled, lessonId, lessons, leads] = await Promise.all([
    getSetting("freeLessonEnabled"),
    getSetting("freeLessonId"),
    prisma.lesson.findMany({
      where: { deletedAt: null, status: "READY", hlsPath: { not: null }, module: { course: { active: true } } },
      select: { id: true, title: true },
      orderBy: [{ module: { order: "asc" } }, { order: "asc" }],
    }),
    prisma.freeLessonLead.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  res.json({ enabled: enabled === "true", lessonId: lessonId ?? "", lessons, leads });
});
freeLessonAdminRouter.put("/admin/free-lesson", async (req, res) => {
  const parsed = z.object({ enabled: z.boolean(), lessonId: z.string() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Выберите урок" });
    return;
  }
  const { enabled, lessonId } = parsed.data;
  if (enabled) {
    const lesson = await prisma.lesson.findFirst({
      where: {
        id: lessonId,
        deletedAt: null,
        status: "READY",
        hlsPath: { not: null },
        module: { course: { active: true } },
      },
    });
    if (!lesson) {
      res.status(400).json({ error: "Выберите готовый урок активного курса" });
      return;
    }
  }
  await writeSettings({ freeLessonId: lessonId, freeLessonEnabled: String(enabled) });
  res.json({ ok: true });
});
