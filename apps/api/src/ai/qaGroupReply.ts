import { prisma } from "../db.js";
import type { QaExample } from "@prisma/client";

/** Technical answers are not style examples. Three matching words do not
 * establish the same recipe, quantity or meaning. Only explicitly reviewed
 * text from the authorized course may be reused, on an exact normalized ask.
 * Unreviewed imports remain intact and fall through to course materials/human.
 */
const CANDIDATE_POOL = 2000;
const FILLER = new Set(["можно", "нужно", "как", "что", "для", "это", "апачон", "апаи", "ширин"]);

export function normalizeQaQuestion(text: string): string {
  return (text.normalize("NFKC").toLocaleLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+|[.,/%+−–°-]/gu) ?? []).join(" ").replace(/[ .]+$/, "");
}

function isReusableQuestion(question: string): boolean {
  const normalized = normalizeQaQuestion(question);
  const terms = normalized.split(" ").filter((term) => term.length >= 3 && !FILLER.has(term));
  const contextual = /(?:^| )(?:это|этот|эта|этого|тут|там|оно|его|ее|так|хамин|ҳамин|ҳамон|вай)(?: |$)/u.test(normalized);
  return terms.length >= 3 && !contextual;
}

export function isReusableQaText(question: string, answer: string): boolean {
  const response = answer.trim();
  return isReusableQuestion(question) && response.length >= 20
    && normalizeQaQuestion(response).split(" ").filter(Boolean).length >= 4
    && !/^https?:\/\/\S+$/i.test(response);
}

export function selectReviewedQaAnswer<T extends { studentText: string; ownerText: string; approvedForAnswer: boolean; courseId: string | null }>(
  question: string,
  courseId: string,
  examples: T[],
): T | null {
  const normalized = normalizeQaQuestion(question);
  const matches = examples.filter((example) => example.approvedForAnswer && example.courseId === courseId
    && normalizeQaQuestion(example.studentText) === normalized && isReusableQaText(question, example.ownerText));
  if (!matches.length) return null;
  // Do not choose the newest of contradictory reviewed historical answers.
  if (new Set(matches.map((example) => normalizeQaQuestion(example.ownerText))).size !== 1) return null;
  return matches[0];
}

export async function findQaAnswer(studentText: string, context?: { courseId: string }): Promise<QaExample | null> {
  if (!context?.courseId || !isReusableQuestion(studentText)) return null;
  const pool = await prisma.qaExample.findMany({
    where: { approvedForAnswer: true, courseId: context.courseId, ownerText: { not: "" }, studentText: { not: "" } },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_POOL,
  });
  return selectReviewedQaAnswer(studentText, context.courseId, pool);
}
