import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Copy, Check, Volume2, VolumeX } from "lucide-react";
import { normalizeAnswerText } from "@/features/quizz";
import type { QuizQuestion as QuizQuestionType } from "@/features/quizz";

interface QuizQuestionProps {
  question: QuizQuestionType;
  selectedAnswer: string | undefined;
  onAnswerChange: (questionId: string, answerId: string) => void;
  showResult?: boolean;
  className?: string;
  onToggleRead?: (q: QuizQuestionType) => void;
  isReading?: boolean;
}

export function QuizQuestion({
  question,
  selectedAnswer,
  onAnswerChange,
  showResult = false,
  className,
  onToggleRead,
  isReading = false,
}: QuizQuestionProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // For multiple-answer: selectedAnswer is comma-separated sorted ids e.g. "a,c"
  const selectedIds = new Set(
    question.type === "multiple-answer"
      ? (selectedAnswer || "").split(",").filter(Boolean)
      : [],
  );
  const correctIds = new Set(question.correctAnswerIds ?? []);

  const handleMultiToggle = (optId: string) => {
    if (showResult) return;
    const next = new Set(selectedIds);
    if (next.has(optId)) next.delete(optId);
    else next.add(optId);
    onAnswerChange(question.id, [...next].sort().join(","));
  };

  const handleCopy = () => {
    const lines: string[] = [];

    // Question text
    lines.push(
      `${t("quizQuestion.questionN", { n: question.questionNumber })}${question.questionText}`,
    );
    lines.push("");

    // Options
    if (question.type === "short-answer") {
      lines.push(
        `${t("quizQuestion.answer")}${question.options[0]?.text ?? t("quizQuestion.noModelAnswer")}`,
      );
    } else if (question.type === "fill-blank") {
      const correctOpt = question.options.find(
        (o) => o.id === question.correctAnswerId,
      );
      lines.push(
        `${t("quizQuestion.answer")}${correctOpt?.text ?? question.correctAnswerId}`,
      );
    } else if (question.type === "multiple-answer") {
      question.options.forEach((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        const marker = correctIds.has(opt.id) ? " ✓" : "";
        lines.push(`${letter}. ${opt.text}${marker}`);
      });
      lines.push("");
      const correctLetters = question.options
        .filter((o) => correctIds.has(o.id))
        .map((o) => {
          const idx = question.options.findIndex((x) => x.id === o.id);
          return String.fromCharCode(65 + idx);
        })
        .join(", ");
      lines.push(`${t("quizQuestion.correctAnswer")}${correctLetters}`);
    } else {
      question.options.forEach((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        const marker = opt.id === question.correctAnswerId ? " ✓" : "";
        lines.push(`${letter}. ${opt.text}${marker}`);
      });
      lines.push("");
      const correctOpt = question.options.find(
        (o) => o.id === question.correctAnswerId,
      );
      const correctLetter = String.fromCharCode(
        65 +
          question.options.findIndex((o) => o.id === question.correctAnswerId),
      );
      lines.push(
        `${t("quizQuestion.correctAnswer")}${correctLetter}. ${correctOpt?.text ?? ""}`,
      );
    }

    if (question.explanation) {
      lines.push(`${t("quizQuestion.explanation")}${question.explanation}`);
    }

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const getOptionStyle = (optionId: string) => {
    if (question.type === "multiple-answer") {
      if (!showResult) {
        return selectedIds.has(optionId)
          ? "border-primary bg-primary/5"
          : "border-border hover:border-muted-foreground/50 hover:bg-muted/30";
      }
      if (correctIds.has(optionId) && selectedIds.has(optionId)) {
        return "border-green-500 bg-green-500/10";
      }
      if (correctIds.has(optionId)) {
        return "border-green-500 bg-green-500/5";
      }
      if (selectedIds.has(optionId) && !correctIds.has(optionId)) {
        return "border-red-500 bg-red-500/10";
      }
      return "border-border opacity-50";
    }
    if (!showResult) {
      return selectedAnswer === optionId
        ? "border-primary bg-primary/5"
        : "border-border hover:border-muted-foreground/50 hover:bg-muted/30";
    }

    // Show result mode
    if (optionId === question.correctAnswerId) {
      return "border-green-500 bg-green-500/10";
    }
    if (selectedAnswer === optionId && optionId !== question.correctAnswerId) {
      return "border-red-500 bg-red-500/10";
    }
    return "border-border opacity-50";
  };

  const getTypeBadge = () => {
    switch (question.type) {
      case "multiple-choice":
        return (
          <Badge variant="secondary">
            {t("quizQuestion.typeMultipleChoice")}
          </Badge>
        );
      case "multiple-answer":
        return (
          <Badge variant="secondary">
            {t("quizQuestion.typeMultipleAnswer")}
          </Badge>
        );
      case "true-false":
        return (
          <Badge variant="secondary">{t("quizQuestion.typeTrueFalse")}</Badge>
        );
      case "fill-blank":
        return (
          <Badge variant="secondary">{t("quizQuestion.typeFillBlank")}</Badge>
        );
      case "short-answer":
        return (
          <Badge variant="secondary">{t("quizQuestion.typeShortAnswer")}</Badge>
        );
    }
  };

  const modelAnswer = question.options[0]?.text ?? "";
  const shortAnswerCorrect =
    !!modelAnswer &&
    normalizeAnswerText(selectedAnswer ?? "") === normalizeAnswerText(modelAnswer);

  return (
    <div className={cn("space-y-4", className)}>
      {/* Question header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {question.questionNumber}
            </span>
            {getTypeBadge()}
            {question.origin === "extracted" && (
              <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
                {t("quizQuestion.originExtracted")}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onToggleRead && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => onToggleRead(question)}
                title={
                  isReading
                    ? t("a11y.tts.stop")
                    : t("a11y.tts.readQuestion")
                }
                aria-label={
                  isReading
                    ? t("a11y.tts.stop")
                    : t("a11y.tts.readQuestion")
                }
                aria-pressed={isReading}
              >
                {isReading ? (
                  <VolumeX
                    className="size-3.5 text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <Volume2 className="size-3.5" aria-hidden="true" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={handleCopy}
              title={t("quizQuestion.copyQuestion")}
              aria-label={t("quizQuestion.copyQuestion")}
            >
              {copied ? (
                <Check
                  className="size-3.5 text-green-500"
                  aria-hidden="true"
                />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
        <p className="text-base font-medium leading-relaxed">
          {question.questionText}
        </p>
      </div>

      {/* Options — fill-blank is generated as a/b/c/d like multiple-choice
          (see quiz_generator.py), so it is answered by picking an option, not
          by typing: grading compares option ids. */}
      {question.type === "short-answer" ? (
        <div className="space-y-2">
          <Textarea
            value={selectedAnswer ?? ""}
            onChange={(e) => onAnswerChange(question.id, e.target.value)}
            disabled={showResult}
            rows={3}
            placeholder={t("quizQuestion.shortAnswerPlaceholder")}
            aria-label={t("quizQuestion.typeShortAnswer")}
            className={cn(
              showResult &&
                modelAnswer &&
                (shortAnswerCorrect
                  ? "border-green-500 bg-green-500/10"
                  : "border-red-500 bg-red-500/10"),
            )}
          />
          {showResult &&
            (modelAnswer ? (
              <div className="rounded-lg border border-green-500 bg-green-500/10 p-3 text-sm">
                <span className="font-medium">{t("quizQuestion.modelAnswer")}</span>{" "}
                {modelAnswer}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("quizQuestion.noModelAnswer")}
              </p>
            ))}
        </div>
      ) : question.type === "multiple-answer" ? (
        <div
          className="space-y-2"
          role="group"
          aria-label={t("quizQuestion.typeMultipleAnswer")}
        >
          {showResult && (
            <p className="text-xs text-muted-foreground mb-1">
              {t("quizQuestion.selectAllCorrect")}
            </p>
          )}
          {question.options.map((option, index) => {
            const isSelected = selectedIds.has(option.id);
            const isCorrectOpt = correctIds.has(option.id);
            const letter = String.fromCharCode(65 + index);
            return (
              <button
                key={option.id}
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`${letter}: ${option.text}`}
                disabled={showResult}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition-all",
                  showResult
                    ? "cursor-default disabled:opacity-100"
                    : "cursor-pointer",
                  getOptionStyle(option.id),
                )}
                onClick={() => handleMultiToggle(option.id)}
              >
                {/* Custom checkbox indicator */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors",
                    isSelected && !showResult
                      ? "border-primary bg-primary"
                      : showResult && isCorrectOpt
                        ? "border-green-500 bg-green-500"
                        : showResult && isSelected && !isCorrectOpt
                          ? "border-red-500 bg-red-500"
                          : "border-muted-foreground",
                  )}
                >
                  {(isSelected || (showResult && isCorrectOpt)) && (
                    <Check className="size-3 text-white" />
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold"
                >
                  {letter}
                </span>
                <span className="flex-1 text-sm">{option.text}</span>
                {showResult && isCorrectOpt && (
                  <Badge
                    variant="default"
                    className="bg-green-600 text-white text-[10px]"
                  >
                    {t("quizQuestion.true")}
                  </Badge>
                )}
                {showResult && isSelected && !isCorrectOpt && (
                  <Badge variant="destructive" className="text-[10px]">
                    {t("quizQuestion.wrongLabel")}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <RadioGroup
          value={selectedAnswer ?? ""}
          onValueChange={(value) => onAnswerChange(question.id, value)}
          disabled={showResult}
          className="space-y-2"
        >
          {question.options.map((option, index) => (
            <Label
              key={option.id}
              htmlFor={`${question.id}-${option.id}`}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg border p-3.5 transition-all",
                getOptionStyle(option.id),
              )}
            >
              <RadioGroupItem
                value={option.id}
                id={`${question.id}-${option.id}`}
              />
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                {String.fromCharCode(65 + index)}
              </span>
              <span className="flex-1 text-sm">{option.text}</span>
              {showResult && option.id === question.correctAnswerId && (
                <Badge
                  variant="default"
                  className="bg-green-600 text-white text-[10px]"
                >
                  {t("quizQuestion.correctLabel")}
                </Badge>
              )}
              {showResult &&
                selectedAnswer === option.id &&
                option.id !== question.correctAnswerId && (
                  <Badge variant="destructive" className="text-[10px]">
                    {t("quizQuestion.wrongLabel")}
                  </Badge>
                )}
            </Label>
          ))}
        </RadioGroup>
      )}

      {/* Explanation */}
      {showResult && question.explanation && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
          <p className="text-xs font-medium text-blue-400 mb-1">
            {t("quizQuestion.explanationLabel")}
          </p>
          <p className="text-sm text-muted-foreground">
            {question.explanation}
          </p>
        </div>
      )}
    </div>
  );
}
