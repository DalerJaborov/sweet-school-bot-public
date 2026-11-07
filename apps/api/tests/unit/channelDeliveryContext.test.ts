import { describe, expect, it } from "vitest";
import { webChannelBlock } from "../../src/ai.js";
describe("delivery context matches the actual channel delivery", () => {
  it("WhatsApp describes website lessons delivered back into WhatsApp", () => {
    const text = webChannelBlock({ channel: "WHATSAPP" });
    expect(text).toContain("пишет в WhatsApp");
    expect(text).toContain("ПРЯМО НА САЙТЕ");
    expect(text).toContain("ссылка на уроки придёт сюда же");
    expect(text).not.toContain("пишет в чат на нашем сайте");
  });
  it("website retains its context and Meta keeps its configured delivery mode", () => {
    expect(webChannelBlock({ channel: "WEB" })).toContain("пишет в чат на нашем сайте");
    expect(webChannelBlock({ channel: "INSTAGRAM" })).toBe("");
    expect(webChannelBlock({ channel: "MESSENGER" })).toBe("");
  });
});
