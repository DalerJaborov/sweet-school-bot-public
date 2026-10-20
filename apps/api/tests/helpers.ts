import { vi, type Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../src/db.js";

/**
 * Мок Prisma для юнит-тестов.
 *
 * Идея: код читает `prisma` из db.ts как живую привязку, поэтому достаточно
 * подменить экземпляр через setPrismaClient() — ни один import-site не
 * меняется. Мок — Proxy: любой `prisma.<model>.<method>` существует и по
 * умолчанию отвечает undefined, а в тесте задаётся только то, что реально
 * нужно сценарию. `$transaction(fn)` вызывает fn с этим же моком, так что
 * транзакционный код тестируется тем же способом.
 *
 * Использование:
 *   const db = mockPrisma();
 *   db.model("funnel").findMany.mockResolvedValue([...]);
 *   ...
 *   afterEach(restorePrisma);
 */

type MethodMock = Mock<(...args: unknown[]) => unknown>;
type ModelMock = Record<string, MethodMock>;

export type PrismaMock = {
  client: PrismaClient;
  /** Моки методов модели (создаются по требованию). */
  model(name: string): ModelMock;
  $transaction: MethodMock;
};

export function mockPrisma(): PrismaMock {
  const models = new Map<string, ModelMock>();

  function model(name: string): ModelMock {
    let m = models.get(name);
    if (!m) {
      const store: Record<string, MethodMock> = {};
      m = new Proxy(store, {
        get(target, method: string) {
          target[method] ??= vi.fn(async () => undefined);
          return target[method];
        },
      });
      models.set(name, m);
    }
    return m;
  }

  const $transaction: MethodMock = vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: unknown) => Promise<unknown>)(client);
    if (Array.isArray(arg)) return Promise.all(arg);
    return undefined;
  });

  const client = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "$transaction") return $transaction;
      if (prop === "then") return undefined; // не Promise-подобный объект
      return model(prop);
    },
  }) as unknown as PrismaClient;

  setPrismaClient(client);
  return { client, model, $transaction };
}

/** Вернуть настоящий экземпляр — вызывать в afterEach, чтобы мок одного
 *  теста не пережил его. */
export function restorePrisma(): void {
  setPrismaClient(originalPrisma);
}

/** Минимальный Contact — только то, что читает код воронок/чеков. Остальные
 *  поля модели не нужны сценарию и не должны тянуть за собой тесты при каждой
 *  миграции схемы. */
export function fakeContact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "contact-1",
    igUserId: "ig-1",
    channel: "INSTAGRAM",
    username: "client",
    tags: "[]",
    paid: false,
    paidAt: null,
    personal: false,
    ...overrides,
  };
}

export function fakeFunnel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "funnel-1",
    name: "Тест",
    enabled: true,
    trigger: "DM",
    postUrl: null,
    mediaIds: "[]",
    keywords: "[]",
    anyComment: false,
    startTag: "kurs_started",
    repeatAfterDays: 30,
    ...overrides,
  };
}

export function fakeStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "step-1",
    funnelId: "funnel-1",
    order: 1,
    delaySeconds: 0,
    text: "Привет!",
    buttons: "[]",
    mediaUrl: null,
    mediaType: null,
    stopAfter: false,
    ...overrides,
  };
}
