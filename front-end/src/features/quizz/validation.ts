import type { QuestionIssue, QuizQuestion } from "./types";

/**
 * Compare two free-text answers the way a human would: case, accents-as-typed,
 * stray spacing and a trailing full stop should never decide a grade.
 */
export function normalizeAnswerText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "");
}

/**
 * Grade one answer. `raw` is what the answer map holds: an option id, a
 * comma-separated sorted id list for multiple-answer, or free text for
 * short-answer.
 *
 * A short-answer whose source document never printed a model answer can only be
 * graded wrong or skipped — never right. Callers count it as skipped so it does
 * not inflate `wrongAnswers`.
 */
export function isAnswerCorrect(q: QuizQuestion, raw: string | null): boolean {
  if (q.type === "multiple-answer") {
    const selected = (raw || "").split(",").filter(Boolean).sort();
    return selected.join(",") === (q.correctAnswerIds ?? []).slice().sort().join(",");
  }
  if (q.type === "short-answer") {
    const model = q.options[0]?.text ?? "";
    return !!model && !!raw && normalizeAnswerText(raw) === normalizeAnswerText(model);
  }
  return raw === q.correctAnswerId;
}

/**
 * Issues that make a question unusable in a quiz run. Surfaced as a badge in the
 * editor's navigator; deliberately non-blocking for save, because AI-generated
 * quizzes routinely land incomplete and the user needs to save partial fixes.
 */
export function getQuestionIssues(q: QuizQuestion): QuestionIssue[] {
  const issues: QuestionIssue[] = [];

  if (!q.questionText.trim()) issues.push("empty-text");

  if (q.type === "true-false" && q.options.length !== 2) {
    issues.push("true-false-option-count");
  }

  if (q.options.some((opt) => !opt.text.trim())) issues.push("empty-option");

  // A short-answer carries its model answer as its single option, so "no options
  // at all" is the same defect as "no correct answer" — an imported essay question
  // whose source document never printed the answer.
  if (q.type === "short-answer") {
    if (!q.options[0]?.text.trim()) issues.push("no-correct-answer");
    return issues;
  }

  const hasCorrect =
    q.type === "multiple-answer"
      ? (q.correctAnswerIds ?? []).some((id) =>
          q.options.some((opt) => opt.id === id),
        )
      : q.options.some((opt) => opt.id === q.correctAnswerId);
  if (!hasCorrect) issues.push("no-correct-answer");

  return issues;
}
