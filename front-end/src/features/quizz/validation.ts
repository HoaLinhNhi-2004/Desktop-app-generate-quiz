import type { QuestionIssue, QuizQuestion } from "./types";

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

  const hasCorrect =
    q.type === "multiple-answer"
      ? (q.correctAnswerIds ?? []).some((id) =>
          q.options.some((opt) => opt.id === id),
        )
      : q.options.some((opt) => opt.id === q.correctAnswerId);
  if (!hasCorrect) issues.push("no-correct-answer");

  return issues;
}
