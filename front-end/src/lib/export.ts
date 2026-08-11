import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import * as XLSX from "xlsx";
import type { QuizQuestion } from "@/features/quizz";
import i18n from "@/config/i18n";

export async function exportQuizToDocx(
  questions: QuizQuestion[],
  title = i18n.t("export.defaultTitle"),
  withAnswers = true,
) {
  const children: Paragraph[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 400 },
    }),
  ];

  questions.forEach((q, i) => {
    // Question Text
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: i18n.t("export.questionPrefix", { n: i + 1 }),
            bold: true,
          }),
          new TextRun(q.questionText),
        ],
        spacing: { before: 240, after: 120 },
      }),
    );

    // Options — a short-answer has none, so leave a ruled line to write on
    if (q.type === "short-answer") {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: i18n.t("export.shortAnswerLine") })],
          indent: { left: 720 },
          spacing: { after: 120 },
        }),
      );
      return;
    }
    q.options.forEach((opt, optIdx) => {
      const letter = String.fromCharCode(65 + optIdx); // A, B, C, D
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${letter}. ${opt.text}`,
            }),
          ],
          indent: { left: 720 }, // Indent options
          spacing: { after: 120 },
        }),
      );
    });
  });

  // Answer Key Page
  if (withAnswers) {
    children.push(
      new Paragraph({
        text: i18n.t("export.answerKey"),
        heading: HeadingLevel.HEADING_2,
        pageBreakBefore: true,
        spacing: { after: 400 },
      }),
    );

    questions.forEach((q, i) => {
      let letter: string;
      if (q.type === "short-answer") {
        letter = q.options[0]?.text || "—";
      } else if (q.type === "multiple-answer" && q.correctAnswerIds?.length) {
        letter = q.correctAnswerIds
          .map((cid) => {
            const idx = q.options.findIndex((o) => o.id === cid);
            return idx >= 0 ? String.fromCharCode(65 + idx) : cid;
          })
          .join(", ");
      } else {
        const correctOptIndex = q.options.findIndex(
          (o) => o.id === q.correctAnswerId,
        );
        letter =
          correctOptIndex >= 0
            ? String.fromCharCode(65 + correctOptIndex)
            : q.correctAnswerId;
      }

      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: i18n.t("export.questionPrefix", { n: i + 1 }),
              bold: true,
            }),
            new TextRun({ text: letter, bold: true, color: "00aa00" }),
          ],
          spacing: { after: 120 },
        }),
      );

      if (q.explanation) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: i18n.t("export.explanation"),
                italics: true,
              }),
              new TextRun(q.explanation),
            ],
            indent: { left: 720 },
            spacing: { after: 240 },
          }),
        );
      }
    });
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "quiz_export.docx";
  a.click();
  window.URL.revokeObjectURL(url);
}

/**
 * Export quiz questions to Kahoot-compatible Excel (.xlsx) format.
 *
 * Kahoot spreadsheet import columns:
 *   Question | Answer 1 | Answer 2 | Answer 3 | Answer 4 |
 *   Time limit | Correct answer(s)
 *
 * - Question max 120 chars, Answer max 75 chars
 * - Time limit: 5,10,20,30,60,90,120,240
 * - Correct answer(s): comma-separated 1-indexed (e.g. "1,3")
 *
 * Returns how many questions were dropped: the format has no free-text answer,
 * and exporting a short-answer as a one-option MCQ produces a Kahoot game where
 * the answer is the only thing on screen.
 */
export function exportQuizToKahoot(
  questions: QuizQuestion[],
  timeLimit = 30,
): { skipped: number } {
  const exportable = questions.filter((q) => q.type !== "short-answer");
  const rows = exportable.map((q) => {
    // Determine correct answer indices (1-based)
    let correctIndices: number[];
    if (q.type === "multiple-answer" && q.correctAnswerIds?.length) {
      correctIndices = q.correctAnswerIds
        .map((cid) => q.options.findIndex((o) => o.id === cid) + 1)
        .filter((i) => i > 0);
    } else {
      const idx = q.options.findIndex((o) => o.id === q.correctAnswerId);
      correctIndices = idx >= 0 ? [idx + 1] : [1];
    }

    return {
      Question: q.questionText.slice(0, 120),
      "Answer 1": q.options[0]?.text.slice(0, 75) ?? "",
      "Answer 2": q.options[1]?.text.slice(0, 75) ?? "",
      "Answer 3": q.options[2]?.text.slice(0, 75) ?? "",
      "Answer 4": q.options[3]?.text.slice(0, 75) ?? "",
      "Time limit": timeLimit,
      "Correct answer(s)": correctIndices.join(","),
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Kahoot");
  XLSX.writeFile(wb, "kahoot_quiz.xlsx");
  return { skipped: questions.length - exportable.length };
}
