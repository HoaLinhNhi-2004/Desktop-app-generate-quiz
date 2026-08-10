import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { AlertTriangle, GripVertical } from "lucide-react";

import type { QuestionType } from "@/features/quizz";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * Props are deliberately all primitives: the questions array is rebuilt on every
 * keystroke, so passing the QuizQuestion object through would defeat the memo
 * and re-render all ~200 rows per character typed.
 */
type QuestionNavRowProps = {
  id: string;
  index: number;
  excerpt: string;
  type: QuestionType;
  isActive: boolean;
  hasIssue: boolean;
  isSelected: boolean;
  selectMode: boolean;
  draggable: boolean;
  onSelect: (id: string) => void;
  onToggleChecked: (id: string) => void;
};

function QuestionNavRowImpl({
  id,
  index,
  excerpt,
  type,
  isActive,
  hasIssue,
  isSelected,
  selectMode,
  draggable,
  onSelect,
  onToggleChecked,
}: QuestionNavRowProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !draggable });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group flex min-w-0 items-center gap-1.5 rounded-md pr-1 transition-colors",
        isActive
          ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
          : "hover:bg-muted",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      {draggable ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={t("editQuiz.dragHandle", { n: index + 1 })}
          className={cn(
            "shrink-0 cursor-grab touch-none p-1 opacity-40 transition-opacity group-hover:opacity-100",
            isActive && "opacity-70",
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : (
        <span className="w-[22px] shrink-0" />
      )}

      {selectMode && (
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleChecked(id)}
          aria-label={t("editQuiz.selectQuestion", { n: index + 1 })}
          className="shrink-0"
        />
      )}

      <button
        type="button"
        onClick={() => onSelect(id)}
        aria-current={isActive ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
      >
        <span
          className={cn(
            "w-7 shrink-0 text-right text-xs font-semibold tabular-nums",
            isActive ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          {index + 1}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            !excerpt && "italic opacity-60",
          )}
        >
          {excerpt || t("editQuiz.emptyQuestionPreview")}
        </span>
        {hasIssue && (
          <AlertTriangle
            className={cn(
              "size-3.5 shrink-0",
              isActive ? "text-primary-foreground" : "text-destructive",
            )}
            aria-label={t("editQuiz.hasIssues")}
          />
        )}
        <span
          className={cn(
            "shrink-0 text-[10px] font-medium uppercase tracking-wide",
            isActive ? "text-primary-foreground" : "text-muted-foreground",
          )}
        >
          {t(`editQuiz.typeAbbr.${type}`)}
        </span>
      </button>
    </div>
  );
}

export const QuestionNavRow = memo(QuestionNavRowImpl);
