import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { acceptWebhookEvents, inboxKey, processWebhookInbox, type InboxEvent } from "../../src/webhookInbox.js";
import * as database from "../../src/db.js";

let db: PrismaMock;
const event: InboxEvent = { channel: "INSTAGRAM", selfId: "page", kind: "message", event: { sender: { id: "customer" }, message: { mid: "one", text: "hello" } } };
beforeEach(() => {
  db = mockPrisma();
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db.model("webhookInbox").updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => { restorePrisma(); vi.restoreAllMocks(); });

describe("durable Meta inbox", () => {
  it("deduplicates a mid even if envelope metadata changes; scopes channel and echo", () => {
    expect(inboxKey({ ...event, event: { ...event.event, timestamp: 55 } })).toBe(inboxKey(event));
    expect(inboxKey({ ...event, channel: "MESSENGER" })).not.toBe(inboxKey(event));
    expect(inboxKey({ ...event, event: { message: { mid: "one", is_echo: true } } })).not.toBe(inboxKey(event));
  });
  it("uses one committed transaction and propagates storage failure to HTTP boundary", async () => {
    await acceptWebhookEvents([event, event]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.model("webhookInbox").upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { eventKey: inboxKey(event) }, update: {} }));
    db.model("webhookInbox").upsert.mockRejectedValue(new Error("SQLITE_BUSY"));
    await expect(acceptWebhookEvents([event])).rejects.toThrow("SQLITE_BUSY");
  });
  it("recovers an expired processing lease after restart and waits for handler completion", async () => {
    db.model("webhookInbox").findMany.mockResolvedValue([{ id: "row", payload: JSON.stringify(event), attempts: 1 }]);
    let release!: () => void;
    const handled = new Promise<void>((resolve) => { release = resolve; });
    const worker = processWebhookInbox(() => handled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.model("webhookInbox").update).not.toHaveBeenCalled();
    release(); await worker;
    expect(db.model("webhookInbox").findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: expect.arrayContaining([expect.objectContaining({ state: "PROCESSING", leaseUntil: expect.anything() })]) } }));
    expect(db.model("webhookInbox").update).toHaveBeenCalledWith(expect.objectContaining({ data: { state: "DONE", leaseUntil: null, lastError: null } }));
  });
  it("keeps failed work for retry and refuses a row already claimed by another worker", async () => {
    db.model("webhookInbox").findMany.mockResolvedValue([{ id: "row", payload: JSON.stringify(event), attempts: 0 }]);
    await processWebhookInbox(async () => { throw new Error("provider unavailable"); });
    expect(db.model("webhookInbox").update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "PENDING", lastError: "provider unavailable" }) }));
    db.model("webhookInbox").updateMany.mockResolvedValue({ count: 0 });
    const handler = vi.fn(); await processWebhookInbox(handler);
    expect(handler).not.toHaveBeenCalled();
  });
});
