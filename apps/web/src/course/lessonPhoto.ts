import type { LessonView } from "./api";

/** Keep lesson photography separate from legacy baked-in titles and gradients. */
export function lessonPhoto(lesson: Pick<LessonView, "posterUrl" | "coverUrl" | "storyUrl">): string | null {
  return lesson.posterUrl || lesson.coverUrl || lesson.storyUrl || null;
}
