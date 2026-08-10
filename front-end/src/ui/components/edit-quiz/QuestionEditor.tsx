import { useTranslation } from "react-i18next";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";

import { getQuestionIssues } from "@/features/quizz";
import type { QuestionType, QuizQuestion } from "@/features/quizz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const EDITABLE_TYPES: QuestionType[] = [
  "multiple-choice",
  "multiple-answer",
  "true-false",
  "fill-blank",
];

type QuestionEditorProps = {
  question: QuizQuestion;
  index: number;
  total: number;
  onChange: <K extends keyof QuizQuestion>(
    field: K,
    value: QuizQuestion[K],
  ) => void;
  onOptionTextChange: (optionId: string, text: string) => void;
  onAddOption: () => void;
  onRequestDeleteOption: (optionId: string) => void;
  onRequestDeleteQuestion: () => void;
};

export function QuestionEditor({
  question,
  index,
  total,
  onChange,
  onOptionTextChange,
  onAddOption,
  onRequestDeleteOption,
  onRequestDeleteQuestion,
}: QuestionEditorProps) {
  const { t } = useTranslation();
  const issues = getQuestionIssues(question);
  // The backend can hold types the editor does not offer (e.g. "mixed" from a
  // generation config); without this the trigger would render blank.
  const typeOptions = EDITABLE_TYPES.includes(question.type)
    ? EDITABLE_TYPES
    : [...EDITABLE_TYPES, question.type];

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              {index + 1}
            </span>
            <span className="text-sm text-muted-foreground">
              {t("editQuiz.questionOf", { current: index + 1, total })}
            </span>
            <Select
              value={question.type}
              onValueChange={(val) => onChange("type", val as QuestionType)}
            >
              <SelectTrigger
                className="h-8 w-[180px] text-xs"
                aria-label={t("editQuiz.questionTypePlaceholder")}
              >
                <SelectValue
                  placeholder={t("editQuiz.questionTypePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`quizConfig.types.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
            onClick={onRequestDeleteQuestion}
          >
            <Trash2 className="size-4" />
            {t("editQuiz.deleteQuestion")}
          </Button>
        </div>

        {issues.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <ul className="space-y-0.5">
              {issues.map((issue) => (
                <li key={issue}>{t(`editQuiz.issues.${issue}`)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor="question-text">
            {t("editQuiz.questionTextLabel")}
          </Label>
          <Textarea
            id="question-text"
            value={question.questionText}
            onChange={(e) => onChange("questionText", e.target.value)}
            rows={3}
            className="resize-none"
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span
              id="options-label"
              className="text-sm font-medium leading-none"
            >
              {t("editQuiz.optionsLabel")}
            </span>
            {question.type !== "true-false" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onAddOption}
              >
                <Plus className="mr-1 size-3" /> {t("editQuiz.addOption")}
              </Button>
            )}
          </div>

          <div className="space-y-2" role="group" aria-labelledby="options-label">
            {question.options.map((opt) => (
              <div key={opt.id} className="flex items-center gap-2">
                <input
                  type={question.type === "multiple-answer" ? "checkbox" : "radio"}
                  name={`correct_${question.id}`}
                  aria-label={t("editQuiz.markCorrect")}
                  checked={
                    question.type === "multiple-answer"
                      ? (question.correctAnswerIds?.includes(opt.id) ?? false)
                      : question.correctAnswerId === opt.id
                  }
                  onChange={(e) => {
                    if (question.type === "multiple-answer") {
                      const current = question.correctAnswerIds ?? [];
                      onChange(
                        "correctAnswerIds",
                        e.target.checked
                          ? [...current, opt.id]
                          : current.filter((id) => id !== opt.id),
                      );
                    } else {
                      onChange("correctAnswerId", opt.id);
                    }
                  }}
                  className="size-4 cursor-pointer"
                />
                <Input
                  value={opt.text}
                  onChange={(e) => onOptionTextChange(opt.id, e.target.value)}
                  className="h-8 flex-1"
                  placeholder={t("editQuiz.optionPlaceholder")}
                  aria-label={t("editQuiz.optionPlaceholder")}
                />
                {question.type !== "true-false" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t("editQuiz.deleteOption")}
                    onClick={() => onRequestDeleteOption(opt.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-2 border-t pt-4">
          <Label htmlFor="explanation" className="text-muted-foreground">
            {t("editQuiz.explanationLabel")}
          </Label>
          <Textarea
            id="explanation"
            value={question.explanation ?? ""}
            onChange={(e) => onChange("explanation", e.target.value)}
            rows={3}
            className="resize-none text-sm"
            placeholder={t("editQuiz.explanationPlaceholder")}
          />
        </div>
      </div>
    </ScrollArea>
  );
}
