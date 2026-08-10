import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckSquare, Plus, Search, X } from "lucide-react";

import { getQuestionIssues } from "@/features/quizz";
import type { QuestionType, QuizQuestion } from "@/features/quizz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { matchesSearch, normalizeVi, questionExcerpt } from "./helpers";
import { QuestionNavRow } from "./QuestionNavRow";

const FILTER_ALL = "all";
const FILTERABLE_TYPES: QuestionType[] = [
  "multiple-choice",
  "multiple-answer",
  "true-false",
  "fill-blank",
];

type QuestionNavigatorProps = {
  questions: QuizQuestion[];
  activeId: string | null;
  selectedIds: Set<string>;
  selectMode: boolean;
  onSelectQuestion: (id: string) => void;
  onToggleChecked: (id: string) => void;
  onSetSelection: (ids: string[]) => void;
  onToggleSelectMode: () => void;
  onAddQuestion: () => void;
  onReorder: (activeId: string, overId: string) => void;
  onRequestBulkDelete: () => void;
};

export function QuestionNavigator({
  questions,
  activeId,
  selectedIds,
  selectMode,
  onSelectQuestion,
  onToggleChecked,
  onSetSelection,
  onToggleSelectMode,
  onAddQuestion,
  onReorder,
  onRequestBulkDelete,
}: QuestionNavigatorProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(FILTER_ALL);
  const [onlyInvalid, setOnlyInvalid] = useState(false);

  const issueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const q of questions) {
      if (getQuestionIssues(q).length > 0) ids.add(q.id);
    }
    return ids;
  }, [questions]);

  const visible = useMemo(() => {
    const needle = normalizeVi(search.trim());
    return questions
      .map((q, index) => ({ q, index }))
      .filter(({ q }) => {
        if (typeFilter !== FILTER_ALL && q.type !== typeFilter) return false;
        if (onlyInvalid && !issueIds.has(q.id)) return false;
        return matchesSearch(q, needle);
      });
  }, [questions, search, typeFilter, onlyInvalid, issueIds]);

  const isFiltered =
    search.trim() !== "" || typeFilter !== FILTER_ALL || onlyInvalid;
  // Reordering a filtered subset has no well-defined target position in the full
  // list, so drag is only offered on the unfiltered view.
  const draggable = !isFiltered && !selectMode;

  const sensors = useSensors(
    // Without a distance threshold, pressing the checkbox or the row itself
    // starts a drag instead of registering the click.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => onSelectQuestion(String(event.active.id)),
    [onSelectQuestion],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onReorder(String(active.id), String(over.id));
    },
    [onReorder],
  );

  const clearFilters = () => {
    setSearch("");
    setTypeFilter(FILTER_ALL);
    setOnlyInvalid(false);
  };

  const sortableIds = useMemo(() => visible.map(({ q }) => q.id), [visible]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("editQuiz.searchPlaceholder")}
            aria-label={t("editQuiz.searchPlaceholder")}
            className="h-8 pl-8 pr-8 text-sm"
          />
          {search && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2"
              onClick={() => setSearch("")}
              aria-label={t("editQuiz.clearSearch")}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1 text-xs"
            onClick={onAddQuestion}
          >
            <Plus className="size-3.5" /> {t("editQuiz.addQuestion")}
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={selectMode ? "default" : "outline"}
                size="icon"
                className="size-7 shrink-0"
                onClick={onToggleSelectMode}
                aria-pressed={selectMode}
                aria-label={t("editQuiz.selectMode")}
              >
                <CheckSquare className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("editQuiz.selectMode")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center gap-1.5">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger
              className="h-7 flex-1 text-xs"
              aria-label={t("editQuiz.filterByType")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FILTER_ALL}>
                {t("editQuiz.filterAll")}
              </SelectItem>
              {FILTERABLE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`quizConfig.types.${type}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={onlyInvalid ? "default" : "outline"}
                size="icon"
                className="size-7 shrink-0"
                onClick={() => setOnlyInvalid((v) => !v)}
                aria-pressed={onlyInvalid}
                aria-label={t("editQuiz.onlyInvalid")}
              >
                <AlertTriangle className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("editQuiz.onlyInvalid")}</TooltipContent>
          </Tooltip>
        </div>

        {selectMode && (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/40 p-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {t("editQuiz.selectedCount", { count: selectedIds.size })}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="hover:text-foreground hover:underline"
                  onClick={() => onSetSelection(visible.map(({ q }) => q.id))}
                >
                  {t("editQuiz.selectAllFiltered")}
                </button>
                <button
                  type="button"
                  className="hover:text-foreground hover:underline"
                  onClick={() => onSetSelection([])}
                >
                  {t("editQuiz.clearSelection")}
                </button>
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 w-full text-xs"
              disabled={selectedIds.size === 0}
              onClick={onRequestBulkDelete}
            >
              {t("editQuiz.bulkDelete", { count: selectedIds.size })}
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {isFiltered
              ? t("editQuiz.matchCount", {
                  matched: visible.length,
                  total: questions.length,
                })
              : t("editQuiz.questionsHeading", { count: questions.length })}
          </span>
          {issueIds.size > 0 && !onlyInvalid && (
            <button
              type="button"
              onClick={() => setOnlyInvalid(true)}
              className="flex items-center gap-1 text-destructive hover:underline"
            >
              <AlertTriangle className="size-3" />
              {t("editQuiz.invalidCount", { count: issueIds.size })}
            </button>
          )}
        </div>

        {isFiltered && !selectMode && (
          <p className="text-[11px] text-muted-foreground">
            {t("editQuiz.dragDisabledWhileFiltered")}{" "}
            <button
              type="button"
              onClick={clearFilters}
              className="underline hover:text-foreground"
            >
              {t("editQuiz.clearFilters")}
            </button>
          </p>
        )}
      </div>

      {/* Radix gives the viewport's content wrapper `display: table`, which
          shrink-wraps to the longest question and defeats `truncate`. Forcing it
          back to `block` is what keeps rows inside the sidebar's width. */}
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
        {/* Extra bottom padding clears the app-wide floating dock pinned at
            bottom-left (Header.tsx), which would otherwise sit over the last rows. */}
        <div className="space-y-0.5 p-2 pb-16">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              {visible.map(({ q, index }) => (
                <QuestionNavRow
                  key={q.id}
                  id={q.id}
                  index={index}
                  excerpt={questionExcerpt(q)}
                  type={q.type}
                  isActive={q.id === activeId}
                  hasIssue={issueIds.has(q.id)}
                  isSelected={selectedIds.has(q.id)}
                  selectMode={selectMode}
                  draggable={draggable}
                  onSelect={onSelectQuestion}
                  onToggleChecked={onToggleChecked}
                />
              ))}
            </SortableContext>
          </DndContext>

          {visible.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              {questions.length === 0
                ? t("editQuiz.noQuestions")
                : t("editQuiz.noMatches")}
            </p>
          )}
        </div>
      </ScrollArea>

      </div>
    </TooltipProvider>
  );
}
