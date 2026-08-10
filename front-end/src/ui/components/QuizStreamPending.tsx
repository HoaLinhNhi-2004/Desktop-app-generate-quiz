import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Loader2,
  Save,
  ScanText,
  Sparkles,
  Timer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { parseQuizError } from "@/lib/quiz-error";
import type { QuizSource, QuizStreamStage } from "@/features/quizz";

/**
 * The order the backend walks through. `ocr` only appears once the backend
 * actually reports it (a scanned PDF), so a text-layer document never shows a
 * step it will not run.
 */
const STAGE_ORDER: QuizStreamStage[] = [
  "extracting",
  "ocr",
  "analyzing",
  "generating",
  "saving",
];

const STAGE_ICONS: Record<QuizStreamStage, typeof Brain> = {
  queued: Timer,
  extracting: ScanText,
  ocr: ScanText,
  analyzing: Brain,
  generating: Sparkles,
  saving: Save,
};

interface QuizStreamPendingProps {
  source: QuizSource;
  onBackToFolder?: () => void;
  onCancel?: () => void;
}

/**
 * What the user sees before question 1 exists. Rendered inside the question
 * card, so the page chrome, timer and navigator stay visible — the user is
 * already in the quiz rather than blocked behind a modal.
 */
export function QuizStreamPending({
  source,
  onBackToFolder,
  onCancel,
}: QuizStreamPendingProps) {
  const { t } = useTranslation();

  if (source.error) {
    const parsed = parseQuizError(source.error);
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-3 py-12 text-center"
      >
        <AlertCircle className="size-10 text-destructive" />
        <p className="text-base font-semibold text-foreground">
          {t("quiz.stream.failedEmpty")}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {parsed.description}
        </p>
        {onBackToFolder && (
          <Button variant="outline" size="sm" onClick={onBackToFolder}>
            {t("quiz.stream.backToFolder")}
          </Button>
        )}
      </div>
    );
  }

  const visibleStages = STAGE_ORDER.filter(
    (stage) => stage !== "ocr" || source.stage === "ocr",
  );
  const activeIndex = visibleStages.indexOf(source.stage ?? "extracting");

  return (
    <div className="flex flex-col items-center gap-6 py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-base font-semibold text-foreground">
          {t("quiz.stream.preparing")}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("quiz.stream.preparingHint")}
        </p>
      </div>

      <ol className="w-full max-w-sm space-y-3">
        {visibleStages.map((stage, index) => {
          const Icon = STAGE_ICONS[stage];
          const isDone = activeIndex > index;
          const isActive = activeIndex === index;
          return (
            <li
              key={stage}
              className={cn(
                "flex items-start gap-3 transition-opacity",
                !isDone && !isActive && "opacity-40",
              )}
            >
              {isDone ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              ) : isActive ? (
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
              ) : (
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t(`quiz.stream.stages.${stage}`)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {isActive && stage === "ocr" && source.stageTotal
                    ? t("quiz.stream.ocrPage", {
                        current: source.stageCurrent ?? 0,
                        total: source.stageTotal,
                      })
                    : t(`quiz.stream.stages.${stage}Desc`)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {source.notice?.code === "rpmWait" && (
        <p className="text-xs text-amber-500">
          {t("quiz.stream.rateLimitWait", {
            seconds: source.notice.retryInSeconds ?? 65,
          })}
        </p>
      )}

      <div className="w-full max-w-sm space-y-2" aria-hidden="true">
        <div className="h-3 w-full animate-pulse rounded-md bg-muted" />
        <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted" />
      </div>

      {onCancel && (
        <ConfirmDialog
          destructive
          title={t("confirm.cancelGeneration.title")}
          description={t("confirm.cancelGeneration.desc")}
          confirmLabel={t("confirm.cancelGeneration.action")}
          onConfirm={onCancel}
        >
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            {t("common.cancel")}
          </Button>
        </ConfirmDialog>
      )}
    </div>
  );
}
