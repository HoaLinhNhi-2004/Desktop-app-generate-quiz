import type { QuizQuestion } from "@/features/quizz";

/**
 * Diacritic-insensitive fold, so typing "quang hop" finds "quang hợp" — the
 * common case when hunting for one question among a couple hundred.
 */
export function normalizeVi(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d");
}

/** `needle` must already be normalized — callers normalize once per keystroke. */
export function matchesSearch(q: QuizQuestion, needle: string): boolean {
  if (!needle) return true;
  if (normalizeVi(q.questionText).includes(needle)) return true;
  return q.options.some((opt) => normalizeVi(opt.text).includes(needle));
}

/** One-line preview for a navigator row; whitespace collapsed so it never wraps. */
export function questionExcerpt(q: QuizQuestion): string {
  return q.questionText.replace(/\s+/g, " ").trim();
}
