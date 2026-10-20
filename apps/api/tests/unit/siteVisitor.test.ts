import { describe, it, expect } from "vitest";
import { issueVisitorId, encodeVisitorCookie, decodeVisitorCookie } from "../../src/site/visitor.js";

describe("кука посетителя сайта", () => {
  it("подписанное значение расшифровывается обратно", () => {
    const id = issueVisitorId();
    expect(id).toMatch(/^[0-9a-f]{48}$/);
    expect(decodeVisitorCookie(encodeVisitorCookie(id))).toBe(id);
  });

  it("подделка — чужой id с чужой подписью, порча подписи, мусор — не проходит", () => {
    const a = issueVisitorId();
    const b = issueVisitorId();
    const sigOfA = encodeVisitorCookie(a).split(".")[1];
    expect(decodeVisitorCookie(`${b}.${sigOfA}`)).toBeNull();
    const cookie = encodeVisitorCookie(a);
    const flipped = cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0");
    expect(decodeVisitorCookie(flipped)).toBeNull();
    expect(decodeVisitorCookie(a)).toBeNull(); // без подписи
    expect(decodeVisitorCookie("")).toBeNull();
    expect(decodeVisitorCookie(undefined)).toBeNull();
    expect(decodeVisitorCookie("x.y")).toBeNull();
  });
});
