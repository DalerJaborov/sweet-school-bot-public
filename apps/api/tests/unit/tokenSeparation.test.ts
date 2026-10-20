import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { mockPrisma, restorePrisma } from "../helpers.js";

vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: vi.fn(async () => undefined) }));

import { issueMagicLink, verifyMagicLink } from "../../src/course/access.js";
import { courseTokenSecret } from "../../src/course/tokenSecret.js";
import { env } from "../../src/env.js";

beforeEach(() => {
  mockPrisma();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

/**
 * Разбор безопасности 03.09.2026 нашёл, что ссылка на курс работала как пароль
 * от админ-панели: подписаны одним секретом, а панель проверяла ТОЛЬКО подпись.
 * Любая покупательница за сто сомони получала базу клиенток и все ключи.
 */
describe("Токен ученицы и токен владельца — разные миры", () => {
  it("ГЛАВНОЕ: ссылка на курс не подписана админским секретом", () => {
    const { token } = issueMagicLink("contact-1");

    // Ровно то, что делала панель до починки. Теперь не проходит вовсе.
    expect(() => jwt.verify(token, env.jwtSecret)).toThrow();
  });

  it("ссылка — короткий код, а не токен вовсе: подписи в нём нет, роли тоже", () => {
    const { token } = issueMagicLink("contact-1");
    expect(token.split(".")).toHaveLength(1);
    expect(() => jwt.verify(token, courseTokenSecret())).toThrow();
  });

  it("админский токен не открывает уроки: чужой секрет и не тот вид", () => {
    const adminToken = jwt.sign({ role: "admin" }, env.jwtSecret, { expiresIn: "30d" });
    expect(verifyMagicLink(adminToken)).toBeNull();
  });

  it("свои ссылки по-прежнему работают", () => {
    const { token, jti } = issueMagicLink("contact-1");
    expect(verifyMagicLink(token)).toMatchObject({ kind: "course-link", jti });
  });

  it("ПЕРЕХОД: ссылки, выданные до починки, не умирают посреди урока", () => {
    // В день выкладки у учениц на руках живые ссылки, подписанные прежним
    // общим секретом. Выкинуть их значит выгнать всех разом.
    const old = jwt.sign({ kind: "course-link", purchaseId: "purchase-1", jti: "старый" }, env.jwtSecret, {
      expiresIn: "7d",
    });
    expect(verifyMagicLink(old)).toMatchObject({ purchaseId: "purchase-1", jti: "старый" });
  });

  it("мусор и подделка отвергаются", () => {
    expect(verifyMagicLink("не-токен")).toBeNull();
    expect(verifyMagicLink(jwt.sign({ kind: "course-link", purchaseId: "x", jti: "y" }, "чужой-секрет"))).toBeNull();
  });
});
