import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ГОЛОСОВЫЕ ОТВЕТЫ ВЫКЛЮЧЕНЫ — ГОЛОСА НЕТ НИ ОТКУДА (владелец, 10.11.2026).
 *
 * Дыра, которую закрывает этот файл: путь «повторное использование архива»
 * (ai/mediaReuse.ts) отправлял клиенту одобренное живое аудио Ширин, НЕ
 * проверяя рубильник `voiceReplyEnabled`. Панель обещала «бот не отвечает
 * голосом», а голос всё равно уходил. Теперь при выключенном голосе
 * аудио-примеры в поиск не попадают, а отправка аудио — не проходит.
 */
const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  examples: [] as {
    id: string;
    ownerText: string;
    mediaUrl: string | null;
    mediaType: string | null;
    approvedForReuse: boolean;
    enabled: boolean;
    clientText: string;
    createdAt: Date;
  }[],
  sent: [] as { kind: string; url: string; text: string | null }[],
  findManyArgs: [] as Record<string, unknown>[],
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    styleExample: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        state.findManyArgs.push(args);
        const where = (args.where ?? {}) as {
          approvedForReuse?: boolean;
          enabled?: boolean;
          OR?: ({ mediaType: null } | { mediaType: { not: string } })[];
        };
        return state.examples.filter((e) => {
          if (where.approvedForReuse !== undefined && e.approvedForReuse !== where.approvedForReuse) return false;
          if (where.enabled !== undefined && e.enabled !== where.enabled) return false;
          // SQL-семантика: `<> 'audio'` не пропускает NULL, поэтому NULL — отдельной веткой OR.
          if (where.OR) {
            const ok = where.OR.some((c) =>
              c.mediaType === null ? e.mediaType === null : e.mediaType !== null && e.mediaType !== c.mediaType.not,
            );
            if (!ok) return false;
          }
          return true;
        });
      }),
    },
  },
  getSetting: vi.fn(async (key: string) => state.settings[key] ?? null),
  recordOutgoingMessage: vi.fn(async () => undefined),
}));

vi.mock("../../src/messaging/send.js", () => ({
  sendToContact: vi.fn(async (_contact: unknown, text: string) => {
    state.sent.push({ kind: "text", url: "", text });
    return "mid-text";
  }),
  sendAttachmentToContact: vi.fn(async (_contact: unknown, url: string, kind: string) => {
    state.sent.push({ kind, url, text: null });
    return "mid-file";
  }),
}));

import { findReusableMedia, sendReusedMedia } from "../../src/ai/mediaReuse.js";

const contact = { id: "c1", igUserId: "ig1", channel: "WHATSAPP" } as never;

const audioExample = {
  id: "e-audio",
  ownerText: "Вот моё голосовое",
  mediaUrl: "https://x/voice.ogg",
  mediaType: "audio",
  approvedForReuse: true,
  enabled: true,
  clientText: "сколько стоит курс",
  createdAt: new Date(2026, 10, 8),
};

const photoExample = {
  id: "e-photo",
  ownerText: "Вот наш торт",
  mediaUrl: "https://x/cake.jpg",
  mediaType: "image",
  approvedForReuse: true,
  enabled: true,
  clientText: "сколько стоит курс",
  createdAt: new Date(2026, 10, 8),
};

describe("Голосовые ответы выключены — голоса нет ниоткуда", () => {
  beforeEach(() => {
    state.settings = {};
    state.examples = [];
    state.sent = [];
    state.findManyArgs = [];
  });

  it("голос выключен: аудио-пример в поиск не попадает, пример не найден", async () => {
    state.settings.voiceReplyEnabled = "false";
    state.examples = [audioExample];

    const found = await findReusableMedia("сколько стоит курс");

    expect(found).toBeNull();
    // Запрос к базе обязан исключать audio — иначе пример всплывёт позже.
    expect(state.findManyArgs[0].where).toMatchObject({ OR: [{ mediaType: null }, { mediaType: { not: "audio" } }] });
  });

  it("голос выключен: фотография в библиотеке по-прежнему уходит (это не голос)", async () => {
    state.settings.voiceReplyEnabled = "false";
    state.examples = [photoExample];

    const found = await findReusableMedia("сколько стоит курс");

    expect(found?.id).toBe("e-photo");
  });

  it("голос включён: живое аудио из библиотеки уходит как раньше", async () => {
    state.settings.voiceReplyEnabled = "true";
    state.examples = [audioExample];

    const found = await findReusableMedia("сколько стоит курс");

    expect(found?.id).toBe("e-audio");
    const sent = await sendReusedMedia(contact, found!);
    expect(sent).toBe(true);
    expect(state.sent.some((s) => s.kind === "audio")).toBe(true);
  });

  it("голос выключен: аудио с подписью не уходит, подпись отдельно тоже — отвечает модель", async () => {
    state.settings.voiceReplyEnabled = "false";

    const sent = await sendReusedMedia(contact, audioExample as never);

    // Подпись аудио-записи — часто сырая расшифровка чужого голосового, без
    // самого голоса она бессмысленна. false -> ai.ts отдаёт вопрос модели.
    expect(sent).toBe(false);
    expect(state.sent.length).toBe(0);
  });

  it("строки настройки нет вовсе: голос считается выключенным", async () => {
    state.examples = [audioExample];

    expect(await findReusableMedia("сколько стоит курс")).toBeNull();
    expect(await sendReusedMedia(contact, audioExample as never)).toBe(false);
  });

  it("голос выключен: пример без mediaType (NULL) не теряется — уходит как картинка", async () => {
    state.settings.voiceReplyEnabled = "false";
    state.examples = [{ ...photoExample, id: "e-null", mediaType: null }];

    const found = await findReusableMedia("сколько стоит курс");

    expect(found?.id).toBe("e-null");
  });

  it("голос выключен: аудио без подписи — отправлять нечего, модель ответит текстом", async () => {
    state.settings.voiceReplyEnabled = "false";

    const sent = await sendReusedMedia(contact, { ...audioExample, ownerText: "" } as never);

    expect(sent).toBe(false);
    expect(state.sent.length).toBe(0);
  });
});

describe("Сторож: любой автоответ с аудио спрашивает ai/voiceSwitch.ts", () => {
  it("файлы, которые шлют вложения/голос и упоминают audio, импортируют voiceSwitch", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(__dirname, "../../src");
    // Сами двери отправки (транспорт) — не автоответы, им проверка не нужна.
    const transport = new Set(["messaging/send.ts", "telegram.ts"]);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const offenders = files.filter((f) => {
      const rel = relative(root, f).split("\\").join("/");
      if (transport.has(rel)) return false;
      const src = readFileSync(f, "utf8");
      const sends = /sendTelegramVoice\(|sendAttachmentToContact\(/.test(src);
      return sends && src.includes('"audio"') && !src.includes("voiceSwitch.js");
    });
    expect(offenders).toEqual([]);
  });
});
