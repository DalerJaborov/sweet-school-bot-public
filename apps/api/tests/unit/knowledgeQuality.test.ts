import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { findQaAnswer, isReusableQaText, normalizeQaQuestion, selectReviewedQaAnswer } from "../../src/ai/qaGroupReply.js";
import { buildCourseKnowledge, MAX_KNOWLEDGE_CHARS, selectKnowledgeExcerpt, type KnowledgeCourse } from "../../src/course/assistant.js";

const question = "Можно заменить сливки молоком в шоколадном креме?";
const answer = "В шоколадном креме сливки молоком заменять нельзя.";
const example = { studentText: question, ownerText: answer, courseId: "course-1", approvedForAnswer: true };

describe("reviewed and course-scoped technical answers", () => {
  let db: PrismaMock;
  beforeEach(() => { db = mockPrisma(); });
  afterEach(restorePrisma);

  it("never searches raw archive without an authorized course", async () => {
    expect(await findQaAnswer(question)).toBeNull();
    expect(db.model("qaExample").findMany).not.toHaveBeenCalled();
  });
  it("requires separate text approval and course scope even after DB filtering", async () => {
    db.model("qaExample").findMany.mockResolvedValue([{ ...example, approvedForAnswer: false }, { ...example, courseId: "other" }]);
    expect(await findQaAnswer(question, { courseId: "course-1" })).toBeNull();
    expect(db.model("qaExample").findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ approvedForAnswer: true, courseId: "course-1" }) }));
  });
  it("reuses a reviewed exact question ignoring case and question marks", () => {
    expect(selectReviewedQaAnswer(question.toUpperCase().replace("?", "!!!"), "course-1", [example])).toEqual(example);
  });
  it.each([
    "Можно НЕ заменить сливки молоком в шоколадном креме?",
    "Можно заменить молоко сливками в шоколадном креме?",
    "Можно заменить сливки маслом в шоколадном креме?",
    "Можно заменить сливки молоком в ванильном креме?",
  ])("does not guess semantic equivalence: %s", (ask) => {
    expect(selectReviewedQaAnswer(ask, "course-1", [example])).toBeNull();
  });
  it("preserves quantities and numeric punctuation", () => {
    expect(normalizeQaQuestion("Добавить 1.5 грамма желатина?")).not.toBe(normalizeQaQuestion("Добавить 1-5 грамма желатина?"));
    expect(normalizeQaQuestion("Добавить 15 грамм желатина?")).not.toBe(normalizeQaQuestion("Добавить 1.5 грамм желатина?"));
    expect(normalizeQaQuestion("Сливки 33% в креме?")).not.toBe(normalizeQaQuestion("Сливки 10% в креме?"));
  });
  it.each(["", "Можно заменить?", "Хамин мумкин аст", "Как это добавить в шоколадный крем?"])("rejects empty/fragmentary/context-dependent ask: %s", (ask) => {
    expect(isReusableQaText(ask, answer)).toBe(false);
  });
  it.each(["", "Да", "Хо моненш", "https://example.com/recipe"])("rejects incomplete answer: %s", (reply) => {
    expect(isReusableQaText(question, reply)).toBe(false);
  });
  it("abstains on conflicting approved historical answers", () => {
    expect(selectReviewedQaAnswer(question, "course-1", [example, { ...example, ownerText: "В шоколадном креме сливки молоком заменять можно." }])).toBeNull();
  });
  it("can match a detailed reviewed Tajik question without translating it", () => {
    const tg = { ...example, studentText: "Барои креми шоколад сливка чанд фоиз бошад?", ownerText: "Барои креми шоколад сливкаи 33 фоиз истифода баред." };
    expect(selectReviewedQaAnswer(tg.studentText, "course-1", [tg])).toEqual(tg);
  });
});

describe("bounded course-material retrieval", () => {
  const background = "Обычное вступление о подготовке рабочего стола. ".repeat(130);
  const source = `${background}\nЖелатин растворяем при температуре 60 градусов. Не кипятим.\n${background}`;
  const course = (lessons: KnowledgeCourse["modules"][number]["lessons"]): KnowledgeCourse => ({ title: "Оплаченный курс", modules: [{ lessons }] });

  it("finds relevant material beyond the former first 2500 characters", () => {
    const excerpt = selectKnowledgeExcerpt(source, "Желатин температура 60 градусов", 2500);
    expect(excerpt).toContain("Желатин растворяем при температуре 60 градусов. Не кипятим.");
    expect(excerpt.length).toBeLessThanOrEqual(2500);
    expect(excerpt).toContain("[…]");
  });
  it("retrieves Tajik spelling variants without rewriting the source", () => {
    const tajik = `${background}Қаймоқро дар яхдон нигоҳ доред. ${background}`;
    const excerpt = selectKnowledgeExcerpt(tajik, "каймокро яхдон нигох", 2000);
    expect(excerpt).toContain("Қаймоқро дар яхдон нигоҳ доред.");
  });
  it("keeps current lesson before other ranked lessons", () => {
    const result = buildCourseKnowledge(course([
      { id: "other", title: "Желатин", transcript: source, transcriptStatus: "READY" },
      { id: "current", title: "Текущий урок", transcript: "Приготовление шоколадного крема по рецепту.", transcriptStatus: "READY" },
    ]), "Желатин", "current")!;
    expect(result.indexOf("Текущий урок")).toBeLessThan(result.indexOf("УРОК: Желатин"));
  });
  it("never uses deleted, unfinished transcripts or unreviewed OCR recipes", () => {
    expect(buildCourseKnowledge(course([
      { id: "deleted", title: "Удалено", transcript: "Нельзя показывать", deletedAt: new Date() },
      { id: "failed", title: "Ошибка", transcript: "Черновик", transcriptStatus: "FAILED" },
      { id: "ocr", title: "Не проверено", recipeText: "999 грамм", recipeSource: "card-ocr", recipeReviewedAt: null },
    ]), "грамм")).toBeNull();
  });
  it("keeps reviewed recipe text", () => {
    expect(buildCourseKnowledge(course([{ id: "ocr", title: "Крем", recipeText: "Сливки 200 грамм.", recipeSource: "card-ocr", recipeReviewedAt: new Date() }]), "сливки")).toContain("Сливки 200 грамм.");
  });
  it("bounds the complete context for many long lessons", () => {
    const result = buildCourseKnowledge(course(Array.from({ length: 80 }, (_, i) => ({ id: `${i}`, title: `Урок ${i}`, transcript: source, transcriptStatus: "READY" }))), "желатин", "79")!;
    expect(result.length).toBeLessThanOrEqual(MAX_KNOWLEDGE_CHARS);
    expect(result).toContain("СМОТРИТ СЕЙЧАС: Урок 79");
  });
  it("no content means no answer material", () => {
    expect(buildCourseKnowledge(course([{ id: "empty", title: "Только название" }]), "что делать")).toBeNull();
  });
});
