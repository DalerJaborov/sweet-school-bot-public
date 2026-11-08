import { describe, it, expect } from "vitest";
import { videoLibraryProblem } from "../src/components/VideoLibrarySettings";

const ok = { id: "a", kind: "dessert", keywords: ["вупи"], url: "/video/a.mp4", caption: { ru: "Вот ролик", tg: "Ин видео" } };

describe("проверка списка роликов в панели", () => {
  it("пусто и верный список — без ошибки", () => {
    expect(videoLibraryProblem("")).toBeNull();
    expect(videoLibraryProblem(JSON.stringify([ok]))).toBeNull();
  });
  it("битый JSON, не массив, плохой адрес — понятная ошибка", () => {
    expect(videoLibraryProblem("[{")).toMatch(/не JSON/);
    expect(videoLibraryProblem("{}")).toMatch(/Список должен/);
    expect(videoLibraryProblem(JSON.stringify([{ ...ok, url: "/api/v1/x" }]))).toMatch(/№1/);
    expect(videoLibraryProblem(JSON.stringify([ok, { ...ok, keywords: [] }]))).toMatch(/№2/);
  });
});
