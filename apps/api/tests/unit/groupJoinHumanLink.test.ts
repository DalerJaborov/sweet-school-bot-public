import { describe, it, expect } from "vitest";
import { isHumanCreatedLink } from "../../src/groupAccess.js";

/**
 * Ширин выдаёт ссылки в группы сама (клиенткам из WhatsApp, куда у бота нет
 * доступа). Telegram присылает в chat_member автора ссылки — если это не бот,
 * вход не «слитая ссылка», и тревога владельцу не нужна (05.09.2026).
 */
const TOKEN = "123456789:AAExampleTokenValue";

describe("isHumanCreatedLink", () => {
  it("ссылка от админа-человека — не тревога", () => {
    expect(isHumanCreatedLink({ invite_link: { invite_link: "https://t.me/+abc", creator: { id: 555, is_bot: false } } }, TOKEN)).toBe(true);
  });
  it("ссылка, созданная самим ботом, — проверяем по базе как раньше", () => {
    expect(isHumanCreatedLink({ invite_link: { invite_link: "https://t.me/+abc", creator: { id: 123456789, is_bot: true } } }, TOKEN)).toBe(false);
  });
  it("нет данных об авторе — считаем ботовой (старое поведение)", () => {
    expect(isHumanCreatedLink({ invite_link: { invite_link: "https://t.me/+abc" } }, TOKEN)).toBe(false);
    expect(isHumanCreatedLink({ invite_link: { invite_link: "x", creator: { id: 5 } } }, "garbage")).toBe(false);
  });
});
