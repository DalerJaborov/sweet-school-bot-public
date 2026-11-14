import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MENU_MEDIA } from "../../src/ai/menuImages.js";

// КЛАСС: вложения бота на чужих хранилищах (manybot S3) пропадают без
// предупреждения — бот начинает слать пустоту. Владелец 11.11.2026: всё
// перенести к нам. Сторож: в коде и в скрипте текстов только наш сайт.
const OPS = path.resolve(__dirname, "../../../../ops");

describe("картинки меню — только с нашего сервера", () => {
  it("запасной список меню в коде не ссылается на чужие хранилища", () => {
    for (const urls of Object.values(DEFAULT_MENU_MEDIA)) {
      for (const u of urls) expect(new URL(u).host).toBe("shirinsweets.online");
    }
  });

  it("скрипт текстов не создаёт настройку с чужими ссылками", () => {
    const src = fs.readFileSync(path.join(OPS, "2026-11-11-bot-texts.mjs"), "utf8");
    expect(src).not.toMatch(/amazonaws|manybot-/u);
  });

  it("новый адрес меню арт-десертов = имя, которое даст скрипт переноса", () => {
    // Формула имени — ops/2026-11-11-move-manybot-media.mjs::localNameFor.
    const old =
      "https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/fb4433534/ca/big_69c2e6c900233215cc5859be98a8dfac.png";
    const name = `mb-${createHash("sha1").update(old).digest("hex").slice(0, 16)}.png`;
    expect(DEFAULT_MENU_MEDIA.online50).toEqual([`https://shirinsweets.online/media/${name}`]);
    const mover = fs.readFileSync(path.join(OPS, "2026-11-11-move-manybot-media.mjs"), "utf8");
    expect(mover).toContain('createHash("sha1").update(url).digest("hex").slice(0, 16)');
  });
});
