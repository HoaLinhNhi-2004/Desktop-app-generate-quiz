import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import type { QuizStreamJob } from "@/features/quizz";

interface QuizStreamWidgetProps {
  job: QuizStreamJob | null;
  /** Lift above the Smart Import widget when both occupy the corner. */
  offsetBottom?: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}

/**
 * Always-minimized pill showing a generation job that is running while the user
 * is somewhere other than the quiz page. Clicking it goes to the quiz — that is
 * where the detail lives, so unlike Smart Import there is nothing to expand.
 */
export function QuizStreamWidget({
  job,
  offsetBottom,
  onOpen,
  onDismiss,
}: QuizStreamWidgetProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  const percent = useMemo(() => {
    if (!job || job.expectedTotal <= 0) return 0;
    return Math.min(100, (job.questions.length / job.expectedTotal) * 100);
  }, [job]);

  if (!job) return null;

  const isRunning = job.status === "running";
  const label =
    job.status === "error"
      ? t("quiz.stream.failedEmpty")
      : job.status === "disconnected"
        ? t("quiz.stream.disconnected")
        : job.expectedTotal > 0
          ? `${job.questions.length}/${job.expectedTotal}`
          : `${job.questions.length}`;

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "fixed right-4 z-50",
        offsetBottom ? "bottom-20" : "bottom-4",
      )}
    >
      <div className="flex items-center gap-2.5 rounded-xl bg-card/95 backdrop-blur-xl border border-border/50 shadow-2xl px-4 py-2.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-2.5 cursor-pointer group"
        >
          <div className="relative">
            <Sparkles className="size-4 text-primary" />
            {isRunning && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-blue-400 animate-pulse" />
            )}
          </div>
          <div className="flex flex-col items-start">
            <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors">
              {label}
            </span>
            <Progress value={percent} className="w-28 h-1 mt-0.5" />
          </div>
        </button>
        {!isRunning && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("common.close")}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
