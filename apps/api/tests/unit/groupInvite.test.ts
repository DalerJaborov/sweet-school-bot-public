import { describe, it, expect, vi, afterEach } from "vitest";
import type { Purchase } from "@prisma/client";

vi.mock("../../src/courses.js", async (orig) => ({
  ...(await orig<typeof import("../../src/courses.js")>()),
  chatIdFor: vi.fn(async () => "-1001"),
}));

import { checkInviteTargets } from "../../src/course/groupInvite.js";

/**
 * «Уже в группе?» — общая дверь course/groupInvite.ts (ревью #95, п.6). Telegram
 * Bot API подменён на уровне fetch: проверяем и сам разбор ответа getChatMember.
 */
function stubMember(result: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, result }) })),
  );
}

const purchase = {
  id: "p-1",
  course: "COURSE50",
  inviteLink: null,
  joinedAt: null,
  createdAt: new Date(),
} as unknown as Purchase;
const contact = { telegramUserId: "777", joinedGroupAt: null };

afterEach(() => vi.unstubAllGlobals());

describe("checkInviteTargets: кто в группе", () => {
  it("member — уже в группе, приглашения нет", async () => {
    stubMember({ status: "member" });
    const r = await checkInviteTargets(contact, [purchase], "tok");
    expect(r).toMatchObject({ targets: [], inGroup: [purchase] });
  });

  it("restricted и is_member: true — в группе (ограничена, но внутри)", async () => {
    stubMember({ status: "restricted", is_member: true });
    const r = await checkInviteTargets(contact, [purchase], "tok");
    expect(r).toMatchObject({ targets: [], inGroup: [purchase] });
  });

  it("ревью #95: restricted и is_member: false — НЕ в группе, приглашение нужно", async () => {
    stubMember({ status: "restricted", is_member: false });
    const r = await checkInviteTargets(contact, [purchase], "tok");
    expect(r).toMatchObject({ inGroup: [], targets: [{ purchase, chatId: "-1001" }] });
  });

  it("left — можно звать; kicked — забанена, не «в группе»", async () => {
    stubMember({ status: "left" });
    expect(await checkInviteTargets(contact, [purchase], "tok")).toMatchObject({ targets: [{ purchase }] });
    stubMember({ status: "kicked" });
    expect(await checkInviteTargets(contact, [purchase], "tok")).toMatchObject({ targets: [], banned: [purchase] });
  });
});
