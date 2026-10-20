import { describe, expect, it } from "vitest";
import { formatNumber, money, plural } from "../src/format";

describe("money / formatNumber", () => {
  it("ставит тонкий пробел между тысячами и «с.» после числа", () => {
    expect(money(1640)).toBe("1 640 с.");
    expect(money(50)).toBe("50 с.");
    expect(money(1234567)).toBe("1 234 567 с.");
  });

  it("отрицательные — с настоящим минусом, дробные — округляются", () => {
    expect(formatNumber(-1500)).toBe("−1 500");
    expect(formatNumber(999.6)).toBe("1 000");
  });

  it("plural согласует окончания", () => {
    expect(plural(1, "оплата", "оплаты", "оплат")).toBe("оплата");
    expect(plural(3, "оплата", "оплаты", "оплат")).toBe("оплаты");
    expect(plural(11, "оплата", "оплаты", "оплат")).toBe("оплат");
  });
});
