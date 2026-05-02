import type { TFunction } from "i18next";
import type { QuizQuestion } from "@/features/quizz";

export function buildQuestionSpeech(
  q: QuizQuestion,
  t: TFunction,
  showResult: boolean,
): string {
  const parts: string[] = [];
  parts.push(t("a11y.tts.questionPrefix", { n: q.questionNumber }));
  parts.push(q.questionText);

  if (q.type !== "fill-blank") {
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      parts.push(t("a11y.tts.optionLetter", { letter, text: opt.text }));
    });
  }

  if (showResult) {
    if (q.type === "multiple-answer" && q.correctAnswerIds?.length) {
      const texts = q.correctAnswerIds
        .map((id) => q.options.find((o) => o.id === id)?.text ?? "")
        .filter(Boolean)
        .join("; ");
      if (texts) parts.push(t("a11y.tts.correctIs", { text: texts }));
    } else {
      const correct = q.options.find((o) => o.id === q.correctAnswerId);
      if (correct) parts.push(t("a11y.tts.correctIs", { text: correct.text }));
    }
    if (q.explanation) {
      parts.push(t("a11y.tts.explanationLabel"));
      parts.push(q.explanation);
    }
  }

  return parts.filter(Boolean).join(". ");
}
