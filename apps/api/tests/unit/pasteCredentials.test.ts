import { describe, it, expect } from "vitest";
import { parsePastedCredentials, missingParts, summarize } from "../../src/storage/pasteCredentials.js";

/** Выдуманные значения нужной длины — настоящих ключей в тестах не бывает. */
const ACCOUNT = "a".repeat(32);
const ACCESS = "b1c2d3e4f5061728394a5b6c7d8e9f01"; // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
const SECRET = "f".repeat(64);
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

/** Как выглядит страница Cloudflare, скопированная целиком (Ctrl+A, Ctrl+C). */
const PAGE = `R2 API Tokens
Use this token
Token value
${"9".repeat(40)}
Access Key ID
${ACCESS}
Secret Access Key
${SECRET}
Use the following endpoint for S3 clients:
${ENDPOINT}
Specify bucket(s)
Apply to specific buckets only
Jurisdiction-specific endpoints for S3 clients`;

describe("Разбор вставленной страницы Cloudflare", () => {
  it("находит адрес и оба ключа в тексте страницы целиком", () => {
    const parsed = parsePastedCredentials(PAGE);
    expect(parsed.accessKeyId).toBe(ACCESS);
    expect(parsed.secretKey).toBe(SECRET);
    expect(parsed.endpoint).toBe(ENDPOINT);
    expect(missingParts(parsed)).toEqual([]);
  });

  it("ГЛАВНОЕ: не путает ключ доступа с номером аккаунта из адреса", () => {
    // В адресе тоже ровно 32 знака. Без вычитания адреса ключом доступа стал бы
    // кусок ссылки, и хранилище молча отвечало бы «доступ запрещён».
    const parsed = parsePastedCredentials(PAGE);
    expect(parsed.accessKeyId).not.toBe(ACCOUNT);
  });

  it("ИМЯ БАКЕТА НЕ ВЫДУМЫВАЕТСЯ ИЗ ТЕКСТА — на этом обожглись живьём", () => {
    // 03.09.2026: из фразы «Specify bucket(s)» в настройку уехало слово
    // «buckets», ключи были верные, а хранилище отвечало «NoSuchBucket».
    // Теперь имя спрашивают у самого хранилища (s3.ts listBuckets), а здесь
    // его нет вовсе — угадывать нечего.
    const parsed = parsePastedCredentials(PAGE);
    expect(parsed).not.toHaveProperty("bucket");
    expect(JSON.stringify(parsed)).not.toContain("buckets");
  });

  it("секретный ключ не откусывается до 32 знаков", () => {
    // 64-значный секрет содержит внутри себя подходящие под ключ доступа
    // подстроки. Границы слова не дают взять кусок вместо целого.
    const parsed = parsePastedCredentials(PAGE);
    expect(parsed.secretKey).toHaveLength(64);
  });

  it("порядок кусков на странице не важен — Cloudflare его меняет", () => {
    const shuffled = `Secret Access Key\n${SECRET}\nEndpoint\n${ENDPOINT}\nAccess Key ID\n${ACCESS}`;
    const parsed = parsePastedCredentials(shuffled);
    expect(parsed.accessKeyId).toBe(ACCESS);
    expect(parsed.secretKey).toBe(SECRET);
    expect(parsed.endpoint).toBe(ENDPOINT);
  });

  it("скопировали не ту страницу — честно говорим, чего не хватает", () => {
    const parsed = parsePastedCredentials("Overview\nR2 Object Storage\nCreate bucket");
    expect(missingParts(parsed)).toEqual(["адрес хранилища", "ключ доступа", "секретный ключ"]);
  });

  it("наружу не уходит ни одного знака ключей", () => {
    const summary = summarize(parsePastedCredentials(PAGE));
    const asText = JSON.stringify(summary);
    expect(asText).not.toContain(SECRET);
    expect(asText).not.toContain(ACCESS);
    expect(summary).toEqual({ endpoint: true, accessKeyId: true, secretKey: true });
  });
});
