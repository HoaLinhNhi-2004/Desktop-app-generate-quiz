/**
 * TextSourceViewer — Read-only viewer for text-sourced quizzes.
 *
 * Layout: Dialog (90vw × 88vh)
 *   Left  38%: scrollable question list
 *   Right 62%: paginated text sections styled like a document reader
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, FileText, ChevronRight, Loader2 } from "lucide-react";
import type { QuizQuestion, SourceTextPage } from "@/features/quizz";
import { getQuizSetSourceTextApi } from "@/features/quizz";

// ─── Question row ─────────────────────────────────────────────────────────────

function QuestionRow({
  question,
  index,
  active,
  onClick,
}: {
  question: QuizQuestion;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const pages = question.sourcePages ?? [];
  const [isExpanded, setIsExpanded] = useState(false);

  const handleClick = () => {
    setIsExpanded((prev) => !prev);
    if (!active) {
      onClick();
    }
  };

  return (
    <div
      className={cn(
        "w-full rounded-lg transition-all text-left",
        active ? "bg-primary/12 ring-2 ring-primary/40" : "hover:bg-muted/60",
      )}
    >
      <button
        onClick={handleClick}
        className="w-full p-3 flex items-start gap-2 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0",
            active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {index + 1}
        </span>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <p
            className={cn(
              "text-xs leading-snug",
              active ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {isExpanded
              ? question.questionText
              : question.questionText.length > 120
                ? question.questionText.slice(0, 120) + "…"
                : question.questionText}
          </p>
          {pages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">
                {t("pdfViewer.sectionLabel")}
              </span>
              {pages.map((p) => (
                <Badge
                  key={p}
                  variant={active ? "default" : "outline"}
                  className="h-4 px-1 text-[10px]"
                >
                  {p}
                </Badge>
              ))}
            </div>
          )}
          {question.sourceKeyword && question.sourceKeyword.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {question.sourceKeyword.map((kw, i) => (
                <span
                  key={i}
                  className="text-[10px] italic text-amber-600 dark:text-amber-400"
                >
                  &ldquo;{kw}&rdquo;
                </span>
              ))}
            </div>
          )}
        </div>
        <ChevronRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 transition-transform",
            isExpanded ? "rotate-90 text-primary" : "text-muted-foreground/50",
          )}
        />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 pt-0 text-sm animate-in slide-in-from-top-2 fade-in duration-200">
          <div className="space-y-1.5 mt-1 border-t pt-2 border-primary/10">
            {question.options?.map((opt) => {
              const isCorrect =
                opt.id === question.correctAnswerId ||
                question.correctAnswerIds?.includes(opt.id);
              return (
                <div
                  key={opt.id}
                  className={cn(
                    "px-2 py-1.5 rounded text-xs flex gap-2",
                    isCorrect
                      ? "bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 font-medium"
                      : "text-muted-foreground bg-background/50",
                  )}
                >
                  <span className="font-semibold shrink-0 uppercase">
                    {opt.id}.
                  </span>
                  <span>{opt.text}</span>
                </div>
              );
            })}
            {question.explanation && (
              <div className="mt-3 text-xs text-muted-foreground bg-muted p-2 rounded-md">
                <span className="font-semibold text-foreground">
                  {t("quizQuestion.explanationLabel")}
                </span>{" "}
                {question.explanation}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Keyword highlighting ───────────────────────────────────────────────────

function highlightKeywords(text: string, keywords: string[]): React.ReactNode {
  if (!keywords.length) return text;

  // Escape regex special chars
  const escaped = keywords
    .filter((k) => k.length >= 2)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return text;

  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, i) =>
    pattern.test(part) ? (
      <mark
        key={i}
        className="bg-amber-200/60 dark:bg-amber-700/40 rounded-sm px-0.5"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface TextSourceViewerProps {
  open: boolean;
  onClose: () => void;
  questions: QuizQuestion[];
  quizTitle: string;
  quizSetId: string;
}

export function TextSourceViewer({
  open,
  onClose,
  questions,
  quizTitle,
  quizSetId,
}: TextSourceViewerProps) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<SourceTextPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [activeQIdx, setActiveQIdx] = useState<number | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !quizSetId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setLoadError(false);
    getQuizSetSourceTextApi(quizSetId)
      .then((res) => setPages(res.pages))
      .catch(() => {
        // Without this the user cannot tell a failed fetch from an empty doc.
        setPages([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [open, quizSetId]);

  // Active question's keywords and source pages
  const activeQ = activeQIdx !== null ? questions[activeQIdx] : null;
  const activeKeywords = useMemo(
    () => (activeQ?.sourceKeyword ?? []).filter(Boolean),
    [activeQ],
  );
  const activePages = useMemo(
    () => new Set(activeQ?.sourcePages ?? []),
    [activeQ],
  );

  const handleQuestionClick = (idx: number) => {
    if (activeQIdx === idx) {
      setActiveQIdx(null);
      return;
    }
    setActiveQIdx(idx);
    const targetPages = questions[idx].sourcePages ?? [];
    if (targetPages.length > 0) {
      const el = pageRefs.current.get(targetPages[0]);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="flex flex-col gap-0 p-0 overflow-hidden"
        style={{
          width: "96vw",
          maxWidth: "96vw",
          height: "96vh",
          maxHeight: "96vh",
        }}
        showCloseButton={false}
      >
        {/* Header */}
        <DialogHeader className="shrink-0 flex flex-row items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="size-4 shrink-0 text-primary" />
            <DialogTitle className="truncate text-sm font-semibold">
              {quizTitle || t("textViewer.title")}
            </DialogTitle>
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {t("textViewer.sourceText")}
            </Badge>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("a11y.labels.closeViewer")}
          >
            <X className="size-4" />
          </Button>
        </DialogHeader>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Question list */}
          <div className="w-[38%] border-r flex flex-col min-h-0">
            <div className="shrink-0 px-4 py-2 border-b">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t("pdfViewer.questionCount", { count: questions.length })}
              </h3>
            </div>
            <ScrollArea className="flex-1 h-0">
              <div className="p-2 space-y-1">
                {questions.map((q, i) => (
                  <QuestionRow
                    key={q.id}
                    question={q}
                    index={i}
                    active={activeQIdx === i}
                    onClick={() => handleQuestionClick(i)}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right: Text content */}
          <div className="flex-1 min-h-0 flex flex-col">
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
              </div>
            ) : loadError ? (
              <div className="flex-1 flex items-center justify-center text-sm text-destructive">
                {t("textViewer.loadFailed")}
              </div>
            ) : pages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                {t("textViewer.noContent")}
              </div>
            ) : (
              <ScrollArea className="flex-1 h-0" ref={contentRef}>
                <div className="p-6 space-y-6 max-w-3xl mx-auto">
                  {pages.map((page) => {
                    const isHighlighted = activePages.has(page.page);
                    return (
                      <div
                        key={page.page}
                        ref={(el) => {
                          if (el) pageRefs.current.set(page.page, el);
                        }}
                        className={cn(
                          "rounded-lg border bg-card p-6 shadow-sm transition-all",
                          isHighlighted &&
                            "ring-2 ring-primary/40 border-primary/30 bg-primary/5",
                        )}
                      >
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                          <Badge
                            variant={isHighlighted ? "default" : "secondary"}
                            className="text-[10px]"
                          >
                            {t("textViewer.section")} {page.page}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {page.charCount.toLocaleString()}{" "}
                            {t("textViewer.chars")}
                          </span>
                        </div>
                        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                          {isHighlighted
                            ? highlightKeywords(page.text, activeKeywords)
                            : page.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t px-5 py-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {pages.length} {t("textViewer.sections")} · {questions.length}{" "}
            {t("common.questions")}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
