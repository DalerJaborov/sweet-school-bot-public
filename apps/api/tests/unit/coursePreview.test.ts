import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/course/i18n.js", () => ({
  translateMany: vi.fn(async (texts: string[]) => texts),
  isCourseLanguage: (v: unknown) => v === "ru" || v === "tg",
}));
vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => null),
  presignGet: vi.fn(() => "https://signed.example/x"),
  getObject: vi.fn(async () => null),
}));

import {
  coursePreviewRouter,
  issuePreviewTicket,
  previewCourseIds,
  resetPreviewTickets,
} from "../../src/course/preview.js";
import { currentAccess, verifyMagicLink } from "../../src/course/access.js";
import { courseTokenSecret } from "../../src/course/tokenSecret.js";

/**
 * «ПОСМОТРЕТЬ КАК УЧЕНИЦА» — предпросмотр владельца (course/preview.ts).
 *
 * Главное обещание: предпросмотр НИЧЕГО не пишет в боевые данные — ни
 * покупки, ни устройства, ни прогресса, ни вопроса в чат, — поэтому выручка,
 * «не открыла уроки» и прочая статистика от него не меняются.
 */

const SRC = path.resolve(__dirname, "../../src/course");
/** Любая запись через prisma: prisma.<модель>.create/update/…, сырой SQL,
 *  транзакция. crypto.createHmac(...).update() сюда не попадает. */
const WRITE_CALL =
  /prisma\s*\.\s*(\$executeRaw\w*|\$transaction|\w+\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany))\b/;

describe("сторож: предпросмотр только читает", () => {
  it.each(["preview.ts", "view.ts"])("в %s нет ни одной записи в базу", (file) => {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    expect(source).not.toMatch(WRITE_CALL);
    // И не зовёт двери, которые пишут: вход ученицы, прогресс, чат.
    expect(source).not.toMatch(/openByLink|registerDevice|currentAccess|receiveQuestion|swapOldestDevice/);
  });
});

const course = {
  id: "course-1",
  code: "COURSE70",
  title: "21 рецепт",
  description: null,
  order: 1,
  toolsData: "[]",
  modules: [
    {
      id: "m1",
      title: "Раздел 1",
      order: 1,
      lessons: [
        {
          id: "l1",
          title: "Урок 1",
          status: "READY",
          durationSec: 600,
          recipeText: "Мука 200 г",
          recipeData: null,
          recipePhotos: "[]",
          posterPath: null,
          teaserMp4Path: null,
          coverPath: null,
          storyPath: null,
        },
      ],
    },
  ],
};

let server: Server;
let base: string;
let db: PrismaMock;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(coursePreviewRouter);
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  resetPreviewTickets();
  db = mockPrisma();
  db.model("course").findMany.mockResolvedValue([course]);
  db.model("lesson").findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === "l1")
      return { id: "l1", encryptionKey: Buffer.alloc(16, 7).toString("base64"), module: { courseId: "course-1" } };
    if (where.id === "other")
      return { id: "other", encryptionKey: Buffer.alloc(16, 9).toString("base64"), module: { courseId: "course-2" } };
    return null;
  });
});
afterEach(restorePrisma);

async function start(ticket: string) {
  return fetch(`${base}/api/course/preview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
}

function cookieOf(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Все методы записи всех моделей — ни один не должен быть вызван. */
function writes(): number {
  let count = 0;
  for (const model of [
    "purchase",
    "device",
    "progress",
    "contact",
    "courseChatMessage",
    "certificate",
    "receiptCheck",
    "message",
  ]) {
    for (const method of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
      count += db.model(model)[method].mock.calls.length;
    }
  }
  return count;
}

describe("вход в предпросмотр", () => {
  it("билет из панели меняется на куку только своего пути, httpOnly", async () => {
    const res = await start(issuePreviewTicket(["course-1"]));
    expect(res.status).toBe(200);
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toMatch(/^ssb_preview=/);
    expect(raw).toContain("Path=/api/course/preview");
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toMatch(/Max-Age=7200/);
  });

  it("билет одноразовый: второй раз тот же адрес не открывает ничего", async () => {
    const ticket = issuePreviewTicket(["course-1"]);
    expect((await start(ticket)).status).toBe(200);
    const again = await start(ticket);
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("просроченный, поддельный и чужого вида билет не принимаются", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const old = issuePreviewTicket(["course-1"]);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await start(old)).status).toBe(401);
    vi.useRealTimers();

    // Подпись секретом учениц, а не предпросмотра — мимо.
    const forged = jwt.sign({ kind: "course-preview-start", courseIds: ["course-1"], jti: "x" }, courseTokenSecret(), {
      expiresIn: 600,
    });
    expect((await start(forged)).status).toBe(401);
    expect((await start("not-a-token-at-all-but-long-enough")).status).toBe(401);
  });

  it("без куки предпросмотра — 401, а не данные", async () => {
    const res = await fetch(`${base}/api/course/preview/me`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("preview_expired");
  });
});

describe("что видно в предпросмотре", () => {
  async function session(ids = ["course-1"]) {
    return cookieOf(await start(issuePreviewTicket(ids)));
  }

  it("экран как у новой ученицы: курс и уроки, без чьих-либо личных данных и прогресса", async () => {
    const cookie = await session();
    const res = await fetch(`${base}/api/course/preview/me?lang=ru`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      courses: { modules: { lessons: { percent: number }[] }[]; purchaseId: unknown }[];
    };
    expect(body.preview).toBe(true);
    expect(body.watermark).toBe("Предпросмотр");
    expect(body.profile).toEqual({ firstName: null, lastName: null, language: "ru" });
    expect(body.courses).toHaveLength(1);
    expect(body.courses[0].purchaseId).toBeNull();
    expect(body.courses[0].modules[0].lessons[0].percent).toBe(0);
    // Только курсы из билета.
    expect(db.model("course").findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["course-1"] } } }),
    );
    // Ни прогресса, ни сертификатов, ни контактов учениц не читаем вовсе.
    expect(db.model("progress").findMany).not.toHaveBeenCalled();
    expect(db.model("contact").findUnique).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });

  it("ключ урока — только своего курса; чужой курс — 404", async () => {
    const cookie = await session();
    const own = await fetch(`${base}/api/course/preview/lessons/l1/key`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await own.arrayBuffer())).toEqual(Buffer.alloc(16, 7));

    const foreign = await fetch(`${base}/api/course/preview/lessons/other/key`, { headers: { cookie } });
    expect(foreign.status).toBe(404);
    expect(writes()).toBe(0);
  });

  it("выход гасит куку", async () => {
    const res = await fetch(`${base}/api/course/preview/end`, { method: "POST" });
    expect(res.headers.get("set-cookie")).toMatch(/^ssb_preview=;.*Max-Age=0/);
  });
});

describe("двери не пересекаются", () => {
  it("сессия предпросмотра не годится как сессия ученицы", async () => {
    const cookie = cookieOf(await start(issuePreviewTicket(["course-1"])));
    const value = cookie.split("=").slice(1).join("=");
    // Даже если подложить её в куку ученицы — мимо (другой секрет и другой вид).
    const access = await currentAccess({
      headers: { cookie: `ssb_course=${value}` },
      header: () => undefined,
    } as never);
    expect(access.ok).toBe(false);
    expect(verifyMagicLink(value)).toBeNull();
    expect(writes()).toBe(0);
  });

  it("сессия ученицы не открывает предпросмотр", () => {
    const studentSession = jwt.sign({ kind: "course-session", contactId: "c1", deviceId: "d1" }, courseTokenSecret(), {
      expiresIn: "1d",
    });
    expect(previewCourseIds({ headers: { cookie: `ssb_preview=${studentSession}` } } as never)).toBeNull();
    expect(previewCourseIds({ headers: { cookie: `ssb_course=${studentSession}` } } as never)).toBeNull();
  });
});
