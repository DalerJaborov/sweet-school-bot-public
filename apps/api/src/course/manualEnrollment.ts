import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { issueMagicLink, looksLikeShortCode, LINK_TTL_DAYS } from "./access.js";
import { getPrices } from "../services/priceService.js";

const CODES = ["COURSE50", "COURSE70"] as const;
const schema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z
    .string()
    .trim()
    .max(25)
    .transform((v) => v.replace(/[\s()-]/g, ""))
    .refine((v) => /^\+?\d{9,15}$/.test(v)),
  lang: z.enum(["ru", "tg"]),
  course: z.enum(["COURSE50", "COURSE70", "BOTH"]),
  amount: z.number().int().min(1).max(100_000),
  paymentConfirmed: z.literal(true),
});
class EnrollmentConflict extends Error {}

async function inventory(db: Prisma.TransactionClient) {
  return db.course.findMany({
    where: { code: { in: [...CODES] }, active: true },
    orderBy: { order: "asc" },
    include: {
      modules: {
        include: {
          lessons: {
            where: { deletedAt: null },
            select: { status: true, hlsPath: true, encryptionKey: true, isPreview: true },
          },
        },
      },
    },
  });
}
type InventoryCourse = Awaited<ReturnType<typeof inventory>>[number];
function ready(course: InventoryCourse): boolean {
  const lessons = course.modules.flatMap((m) => m.lessons);
  return (
    lessons.length > 0 &&
    lessons.some((l) => !l.isPreview) &&
    lessons.every(
      (l) =>
        l.status === "READY" &&
        Boolean(l.hlsPath) &&
        Boolean(l.encryptionKey) &&
        Buffer.from(l.encryptionKey!, "base64").length === 16,
    )
  );
}

/** Must be mounted AFTER the existing /admin role guard. No public route. */
export const manualEnrollmentRouter = Router();

manualEnrollmentRouter.get("/admin/manual-enrollments/catalog", async (_req, res, next) => {
  try {
    const [courses, prices] = await Promise.all([inventory(prisma), getPrices()]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      courses: courses.filter(ready).map((c) => ({ code: c.code, title: c.title, price: c.price })),
      bundlePrice: prices.bundle,
    });
  } catch (err) {
    next(err);
  }
});

manualEnrollmentRouter.post("/admin/manual-enrollments", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Укажите имя, телефон, язык, курс, сумму и подтвердите фактическую оплату." });
    return;
  }
  const input = parsed.data;
  // Local Tajik numbers and +992 numbers identify the same manual customer.
  const digits = input.phone.replace(/^\+/, "");
  const phone = `+${digits.length === 9 ? `992${digits}` : digits}`;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const selected = input.course === "BOTH" ? [...CODES] : [input.course];
      const all = await inventory(tx);
      const courses = selected.map((code) => all.find((c) => c.code === code));
      if (courses.some((c) => !c || !ready(c)))
        throw new EnrollmentConflict(
          "Выбранный курс не опубликован или видео ещё не готовы. Проверьте уроки перед продажей.",
        );
      const existing = await tx.contact.findUnique({
        where: { channel_igUserId: { channel: "MANUAL", igUserId: phone } },
      });
      if (existing?.accessRevokedAt || existing?.spamBlockedAt)
        throw new EnrollmentConflict(
          "Доступ этой ученицы отозван или заблокирован. Сначала проверьте её карточку; автоматическое восстановление запрещено.",
        );
      if (
        existing?.accessTokenId &&
        (!looksLikeShortCode(existing.accessTokenId) ||
          !existing.accessIssuedAt ||
          Date.now() - existing.accessIssuedAt.getTime() > LINK_TTL_DAYS * 86_400_000)
      ) {
        throw new EnrollmentConflict(
          "Существующая ссылка устарела. Откройте карточку ученицы и перевыдайте ссылку явно.",
        );
      }
      const purchases = existing ? await tx.purchase.findMany({ where: { contactId: existing.id } }) : [];
      if (purchases.some((p) => selected.includes(p.course as (typeof selected)[number]) && p.revokedAt))
        throw new EnrollmentConflict(
          "Покупка была отозвана. Восстановите её отдельно в карточке ученицы после проверки.",
        );
      const missing = courses.filter(
        (c): c is InventoryCourse => Boolean(c) && !purchases.some((p) => p.course === c!.code),
      );
      if (existing && missing.length === 0) {
        if (!existing.accessTokenId)
          throw new EnrollmentConflict(
            "Покупка уже существует, но ссылка не выдана. Используйте управление ссылкой в карточке ученицы.",
          );
        return {
          contactId: existing.id,
          url: `${env.publicBaseUrl}/l/${existing.accessTokenId}`,
          createdCourses: [],
          alreadyEnrolled: true,
        };
      }
      const now = new Date();
      const contact =
        existing ??
        (await tx.contact.create({
          data: { channel: "MANUAL", igUserId: phone, name: input.name, preferredLanguage: input.lang },
        }));
      const link = contact.accessTokenId ? null : issueMagicLink(contact.id);
      const totalWeight = missing.reduce((sum, c) => sum + Math.max(1, c.price), 0);
      let remaining = input.amount;
      for (let i = 0; i < missing.length; i++) {
        const c = missing[i];
        const amount =
          i === missing.length - 1 ? remaining : Math.floor((input.amount * Math.max(1, c.price)) / totalWeight);
        remaining -= amount;
        await tx.purchase.create({
          data: { contactId: contact.id, course: c.code, courseId: c.id, amount, currency: "TJS", source: "MANUAL" },
        });
      }
      await tx.contact.update({
        where: { id: contact.id },
        data: {
          paid: true,
          paidAt: contact.paidAt ?? now,
          name: input.name,
          preferredLanguage: input.lang,
          ...(link ? { accessTokenId: link.jti, accessIssuedAt: now } : {}),
        },
      });
      return {
        contactId: contact.id,
        url: link?.url ?? `${env.publicBaseUrl}/l/${contact.accessTokenId}`,
        createdCourses: missing.map((c) => c.code),
        alreadyEnrolled: false,
      };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof EnrollmentConflict) {
      res.status(409).json({ error: err.message });
      return;
    }
    if ((err as { code?: string })?.code === "P2002" || (err as { code?: string })?.code === "P2034") {
      res
        .status(409)
        .json({ error: "Запись уже меняется. Повторите запрос: действующая ссылка и покупки сохранятся." });
      return;
    }
    next(err);
  }
});
