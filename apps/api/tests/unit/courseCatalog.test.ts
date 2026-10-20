import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { backfillCourses, SEED_COURSES } from "../../src/services/courseCatalog.js";

// db.js НЕ мокаем: backfillCourses ходит только в prisma, а он подменён через
// setPrismaClient. Мок модуля целиком сломал бы живую привязку `prisma` —
// spread в vi.mock копирует значение на момент загрузки, и подмена клиента
// в такой копии уже не видна.

function course(code: string, id: string) {
  return { id, code, title: code, price: 50, order: 1 };
}

describe("backfillCourses", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("пустая база: создаёт оба курса из констант и связывает покупки", async () => {
    db.model("course").findUnique.mockResolvedValue(null);
    db.model("course").findMany.mockResolvedValue([
      course("COURSE50", "c50"),
      course("COURSE70", "c70"),
    ]);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", course: "COURSE50" },
      { id: "p2", course: "COURSE70" },
    ]);

    const result = await backfillCourses();

    expect(result.coursesCreated).toBe(SEED_COURSES.length);
    expect(result.coursesExisting).toBe(0);
    expect(result.purchasesLinked).toBe(2);
    expect(result.unknownCourses).toEqual([]);
    expect(db.model("purchase").update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { courseId: "c50" } });
    expect(db.model("purchase").update).toHaveBeenCalledWith({ where: { id: "p2" }, data: { courseId: "c70" } });
  });

  it("повторный запуск: курсы не дублируются, связанные покупки не трогаются", async () => {
    db.model("course").findUnique.mockImplementation(async ({ where }: { where: { code: string } }) =>
      course(where.code, `id-${where.code}`)
    );
    db.model("course").findMany.mockResolvedValue([course("COURSE50", "c50"), course("COURSE70", "c70")]);
    // Непривязанных покупок больше нет — все обработаны в прошлый раз.
    db.model("purchase").findMany.mockResolvedValue([]);

    const result = await backfillCourses();

    expect(result.coursesCreated).toBe(0);
    expect(result.coursesExisting).toBe(SEED_COURSES.length);
    expect(result.purchasesLinked).toBe(0);
    expect(db.model("course").create).not.toHaveBeenCalled();
    expect(db.model("purchase").update).not.toHaveBeenCalled();
  });

  it("берёт ТОЛЬКО покупки без courseId — уже связанные не перезаписывает", async () => {
    db.model("course").findUnique.mockResolvedValue(null);
    db.model("course").findMany.mockResolvedValue([course("COURSE50", "c50")]);
    db.model("purchase").findMany.mockResolvedValue([]);

    await backfillCourses();

    expect(db.model("purchase").findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { courseId: null } })
    );
  });

  it("неизвестный код курса: покупка НЕ связывается, код возвращается наверх", async () => {
    db.model("course").findUnique.mockResolvedValue(null);
    db.model("course").findMany.mockResolvedValue([course("COURSE50", "c50")]);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", course: "COURSE50" },
      { id: "p2", course: "COURSE_MASTERCLASS" },
      { id: "p3", course: "COURSE_MASTERCLASS" },
    ]);

    const result = await backfillCourses();

    expect(result.purchasesLinked).toBe(1);
    // Дубли кодов схлопываются: владельцу нужен список проблем, а не список строк.
    expect(result.unknownCourses).toEqual(["COURSE_MASTERCLASS"]);
    expect(db.model("purchase").update).toHaveBeenCalledTimes(1);
  });

  it("каталог заполняется ровно теми ценами и названиями, что в courses.ts", async () => {
    db.model("course").findUnique.mockResolvedValue(null);
    db.model("course").findMany.mockResolvedValue([]);
    db.model("purchase").findMany.mockResolvedValue([]);

    await backfillCourses();

    for (const seed of SEED_COURSES) {
      expect(db.model("course").create).toHaveBeenCalledWith({
        data: { code: seed.code, title: seed.title, price: seed.price, order: seed.order },
      });
    }
    expect(SEED_COURSES.map((s) => s.price)).toEqual([50, 70]);
  });
});
