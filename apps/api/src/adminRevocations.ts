import { prisma } from "./db.js";
import type { Revocations } from "./adminAccess.js";

export const adminRevocations: Revocations = {
  async has(hash) {
    return Boolean(await prisma.adminSessionRevocation.findUnique({ where: { hash } }));
  },
  async add(hash, expiresAt) {
    await prisma.adminSessionRevocation.upsert({ where: { hash }, create: { hash, expiresAt }, update: { expiresAt } });
    await prisma.adminSessionRevocation.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60_000) } } });
  },
};
