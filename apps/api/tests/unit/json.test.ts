import { describe, it, expect } from "vitest";
import {
  parseJsonArray,
  parseStringArray,
  parseStepButtonsJson,
  isStepButton,
  parseCourseTools,
  isCourseTool,
} from "../../src/json.js";

describe("json.ts — безопасный разбор JSON-колонок", () => {
  it("null/undefined/пустая строка → []", () => {
    expect(parseStringArray(null)).toEqual([]);
    expect(parseStringArray(undefined)).toEqual([]);
    expect(parseStringArray("")).toEqual([]);
  });

  it("битая строка → [] без исключения", () => {
    expect(parseStringArray("{oops")).toEqual([]);
    expect(parseStringArray("[1, 2,")).toEqual([]);
    expect(parseStepButtonsJson("not json")).toEqual([]);
  });

  it("валидный JSON, но не массив → []", () => {
    expect(parseStringArray('{"a":1}')).toEqual([]);
    expect(parseStringArray("42")).toEqual([]);
    expect(parseStringArray("null")).toEqual([]);
  });

  it("валидный массив: элементы фильтруются по guard", () => {
    expect(parseStringArray(JSON.stringify(["a", "", "  ", 1, null, "b"]))).toEqual(["a", "b"]);
    expect(parseJsonArray("[1, \"x\", 2]", (i): i is number => typeof i === "number")).toEqual([1, 2]);
  });

  it("кнопки шага: нужны непустой title и целый targetOrder", () => {
    expect(isStepButton({ title: "Да", targetOrder: 2 })).toBe(true);
    expect(isStepButton({ title: "", targetOrder: 2 })).toBe(false);
    expect(isStepButton({ title: "Да", targetOrder: 1.5 })).toBe(false);
    expect(isStepButton(null)).toBe(false);
    expect(parseStepButtonsJson(JSON.stringify([{ title: "Да", targetOrder: 2 }, "мусор", { title: "Нет" }]))).toEqual([
      { title: "Да", targetOrder: 2 },
    ]);
  });

  it("инструменты курса: нужно непустое name, остальные поля — строка или null", () => {
    const tool = { name: "Насадка", photoUrl: "https://x/y.jpg", toolNumber: "847", buyLink: null };
    expect(isCourseTool(tool)).toBe(true);
    expect(isCourseTool({ ...tool, name: "" })).toBe(false);
    expect(isCourseTool({ ...tool, photoUrl: 5 })).toBe(false);
    expect(isCourseTool(null)).toBe(false);
    expect(parseCourseTools(JSON.stringify([tool, "мусор", { name: "" }]))).toEqual([tool]);
    expect(parseCourseTools(null)).toEqual([]);
  });
});
