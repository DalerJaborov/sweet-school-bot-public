import { describe, it, expect } from "vitest";
import { activeCards, type Attention } from "../src/panel/useAttention";

const base: Attention = { receipts: 0, questions: 0, notOpened: 0, waiting: [], queue: [], problems: [] };

describe("«Сегодня»: подсказка «оплатили, но не открыли уроки» не показывается", () => {
  it("даже если такие ученицы есть, карточки нет", () => {
    expect(activeCards({ ...base, notOpened: 5 }, false)).not.toContain("notOpened");
    expect(activeCards({ ...base, notOpened: 5 }, true)).toEqual([]);
  });

  it("остальные карточки работают как раньше", () => {
    expect(activeCards({ ...base, receipts: 1, questions: 2 }, true)).toEqual(["receipts", "questions"]);
  });
});
