import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({ getSetting: vi.fn(async () => null), logError: vi.fn() }));

import { getSetting } from "../../src/db.js";
import { presignGet, publicUrl, storageConfig, type StorageConfig } from "../../src/storage/s3.js";

const cfg: StorageConfig = {
  endpoint: "https://acc123.r2.cloudflarestorage.com",
  bucket: "sweet-school",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example-key",
  region: "auto",
  publicBase: "https://cdn.example.com",
};

const FIXED = new Date("2026-09-03T10:00:00Z");

describe("presignGet", () => {
  it("собирает все обязательные параметры SigV4", () => {
    const url = new URL(presignGet(cfg, "courses/m1/l1/seg_000.ts", 300, FIXED));

    expect(url.origin).toBe(cfg.endpoint);
    expect(url.pathname).toBe("/sweet-school/courses/m1/l1/seg_000.ts");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAEXAMPLE/20260903/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260903T100000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("подпись воспроизводима для одних и тех же входных данных", () => {
    const a = presignGet(cfg, "a/b.ts", 300, FIXED);
    const b = presignGet(cfg, "a/b.ts", 300, FIXED);
    expect(a).toBe(b);
  });

  it("любое изменение входа меняет подпись", () => {
    const base = presignGet(cfg, "a/b.ts", 300, FIXED);
    const otherKey = presignGet(cfg, "a/c.ts", 300, FIXED);
    const otherTtl = presignGet(cfg, "a/b.ts", 600, FIXED);
    const otherTime = presignGet(cfg, "a/b.ts", 300, new Date("2026-09-03T10:00:01Z"));
    const otherSecret = presignGet({ ...cfg, secretAccessKey: "another" }, "a/b.ts", 300, FIXED);

    const sig = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");
    expect(new Set([sig(base), sig(otherKey), sig(otherTtl), sig(otherTime), sig(otherSecret)]).size).toBe(5);
  });

  it("экранирует спецсимволы в имени объекта, но не слеши", () => {
    const url = presignGet(cfg, "courses/раз два/seg (1).ts", 300, FIXED);
    expect(url).toContain("/sweet-school/courses/");
    expect(url).toContain("%20");
    expect(url).toContain("%28"); // открывающая скобка
    expect(url).not.toContain(" ");
  });
});

describe("publicUrl", () => {
  it("собирает адрес раздачи, когда он задан", () => {
    expect(publicUrl(cfg, "photos/a.jpg")).toBe("https://cdn.example.com/photos/a.jpg");
  });
  it("без адреса раздачи возвращает null — вызывающий обязан подписать ссылку", () => {
    expect(publicUrl({ ...cfg, publicBase: "" }, "photos/a.jpg")).toBeNull();
  });
});

describe("storageConfig", () => {
  beforeEach(() => vi.mocked(getSetting).mockReset());

  it("не настроено — null, без падений", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    expect(await storageConfig()).toBeNull();
  });

  it("неполный набор ключей — тоже null: половина настроек хуже, чем ничего", async () => {
    vi.mocked(getSetting).mockImplementation(async (k: string) =>
      k === "r2Endpoint" ? "https://x.r2.cloudflarestorage.com" : null
    );
    expect(await storageConfig()).toBeNull();
  });

  it("полный набор — конфиг с обрезанными хвостовыми слешами и регионом по умолчанию", async () => {
    const values: Record<string, string> = {
      r2Endpoint: "https://acc.r2.cloudflarestorage.com/",
      r2Bucket: "bucket",
      r2AccessKeyId: "key",
      r2SecretKey: "secret",
      r2PublicBase: "https://cdn.example.com//",
    };
    vi.mocked(getSetting).mockImplementation(async (k: string) => values[k] ?? null);

    const out = await storageConfig();

    expect(out).toMatchObject({
      endpoint: "https://acc.r2.cloudflarestorage.com",
      publicBase: "https://cdn.example.com",
      region: "auto",
    });
  });
});
