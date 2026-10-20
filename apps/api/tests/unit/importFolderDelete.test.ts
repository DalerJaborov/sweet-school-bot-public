import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => null),
  presignGet: vi.fn(),
  putObject: vi.fn(),
  putObjectStream: vi.fn(),
  deleteObject: vi.fn(),
  checkStorageReachable: vi.fn(),
  listBuckets: vi.fn(),
}));

import { removeImportFolder } from "../../src/course/importRoutes.js";

/**
 * УДАЛЕНИЕ ИСХОДНИКОВ ПОСЛЕ ИМПОРТА («Утро Ширин» §14): кнопка в мастере
 * удаляет папку экспорта — и только её. Имя с «..» или слэшем, папка вне
 * корня импорта и идущий импорт — отказ без единого обращения к диску.
 */
describe("removeImportFolder", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ssb-imports-"));
    await fs.promises.mkdir(path.join(root, "export1", "video_files"), { recursive: true });
    await fs.promises.writeFile(path.join(root, "export1", "result.json"), "{}");
    await fs.promises.writeFile(path.join(root, "export1", "video_files", "a.mp4"), Buffer.alloc(1024));
    await fs.promises.writeFile(path.join(root, "outside.txt"), "не трогать");
  });
  afterEach(() => fs.promises.rm(root, { recursive: true, force: true }));

  it("удаляет папку целиком и говорит, сколько освободилось", async () => {
    const r = await removeImportFolder("export1", { root, running: false });
    expect(r).toEqual({ ok: true, freedGb: 0 });
    expect(fs.existsSync(path.join(root, "export1"))).toBe(false);
    expect(fs.existsSync(path.join(root, "outside.txt"))).toBe(true);
  });

  it.each(["..", "../export1", "export1/..", "export1/../outside.txt", "/etc", "", "a b"])("имя «%s» — 400, диск не тронут", async (name) => {
    const r = await removeImportFolder(name, { root, running: false });
    expect(r).toEqual({ ok: false, status: 400, error: "Странное имя папки" });
    expect(fs.existsSync(path.join(root, "export1", "result.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "outside.txt"))).toBe(true);
  });

  it("идёт импорт — 409, папка на месте", async () => {
    const r = await removeImportFolder("export1", { root, running: true });
    expect(r).toEqual({ ok: false, status: 409, error: expect.stringMatching(/Импорт ещё идёт/) });
    expect(fs.existsSync(path.join(root, "export1", "result.json"))).toBe(true);
  });

  it("папки уже нет — 404", async () => {
    expect(await removeImportFolder("nope", { root, running: false })).toEqual({ ok: false, status: 404, error: "Папки уже нет" });
  });
});
