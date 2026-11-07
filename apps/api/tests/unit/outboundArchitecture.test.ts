import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve("src");
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
}
describe("outbound policy architecture", () => {
  it("keeps direct Meta transport imports confined to the shared sender and existing explicit manual panel", () => {
    const offenders: string[] = [];
    for (const file of files(root)) {
      const relative = path.relative(root, file).replaceAll("\\", "/");
      const imports = [...fs.readFileSync(file, "utf8").matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*instagram\.js["']/g)];
      if (imports.some(m => /\b(sendText|sendAttachment)\b/.test(m[1])) && !["messaging/send.ts", "admin.ts"].includes(relative)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
  it("receipt permission is entered only after automated or owner receipt decisions", () => {
    const callers = files(root).filter(file => /withVerifiedReceiptDelivery\(/.test(fs.readFileSync(file, "utf8")))
      .map(file => path.relative(root, file).replaceAll("\\", "/")).sort();
    expect(callers).toEqual(["ai/receiptVerdict.ts", "course/deliveryChoice.ts", "receiptDecision.ts"]);
  });
});
