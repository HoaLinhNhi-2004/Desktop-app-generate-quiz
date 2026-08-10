/**
 * PdfQuizViewer — Interactive PDF viewer with quiz source highlighting.
 *
 * Layout: Dialog (90vw × 88vh)
 *   Left  40%: scrollable question list, each item shows sourcePages badges
 *   Right 60%: PDF rendered page-by-page with colored overlays on highlighted pages
 *
 * Interaction:
 *   • Click a question → PDF scrolls to the first source page + highlights all source pages
 *   • Clicking the active question again dismisses the highlight
 */

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  X,
  FileText,
  BookOpen,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Layers,
  Flame,
} from "lucide-react";
import type { QuizQuestion, HeatmapBlock } from "@/features/quizz";
import { getHeatmapBlocksApi } from "@/features/quizz";

// Configure pdfjs worker using local bundled file (avoids CDN fetch errors)
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdfQuizViewerProps {
  open: boolean;
  onClose: () => void;
  pdfUrl: string;
  pdfName: string;
  questions: QuizQuestion[];
  quizTitle: string;
  quizSetId?: string;
}

// ─── Single question row ──────────────────────────────────────────────────────

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
                {t("pdfViewer.pageLabel")}
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
          {pages.length === 0 && (
            <span className="text-[10px] text-muted-foreground/50">
              {t("pdfViewer.noPageInfo")}
            </span>
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

// ─── Page heatmap helpers ───────────────────────────────────────────────────

function buildPageDistribution(questions: QuizQuestion[]): Map<number, number> {
  const map = new Map<number, number>();
  questions.forEach((q) => {
    (q.sourcePages ?? []).forEach((p) => {
      map.set(p, (map.get(p) ?? 0) + 1);
    });
  });
  return map;
}

// ─── Thermal palette (mirrors PageHeatmap) ──────────────────────────────────

const HEAT_STOPS_PDF: [number, number, number, number][] = [
  [0.0, 220, 80, 55],
  [0.25, 185, 85, 45],
  [0.5, 60, 100, 50],
  [0.75, 30, 100, 50],
  [1.0, 0, 90, 50],
];

function thermalColorPdf(intensity: number): string {
  if (intensity <= 0) return "hsl(var(--muted))";
  const t = Math.max(0, Math.min(1, intensity));
  let lo = HEAT_STOPS_PDF[0];
  let hi = HEAT_STOPS_PDF[HEAT_STOPS_PDF.length - 1];
  for (let i = 0; i < HEAT_STOPS_PDF.length - 1; i++) {
    if (t >= HEAT_STOPS_PDF[i][0] && t <= HEAT_STOPS_PDF[i + 1][0]) {
      lo = HEAT_STOPS_PDF[i];
      hi = HEAT_STOPS_PDF[i + 1];
      break;
    }
  }
  const range = hi[0] - lo[0];
  const f = range === 0 ? 0 : (t - lo[0]) / range;
  const h = Math.round(lo[1] + f * (hi[1] - lo[1]));
  const s = Math.round(lo[2] + f * (hi[2] - lo[2]));
  const l = Math.round(lo[3] + f * (hi[3] - lo[3]));
  return `hsl(${h} ${s}% ${l}%)`;
}

/** Same as thermalColorPdf but with alpha channel for overlay blending. */
function thermalColorPdfAlpha(intensity: number, alpha: number): string {
  if (intensity <= 0) return "transparent";
  const t = Math.max(0, Math.min(1, intensity));
  let lo = HEAT_STOPS_PDF[0];
  let hi = HEAT_STOPS_PDF[HEAT_STOPS_PDF.length - 1];
  for (let i = 0; i < HEAT_STOPS_PDF.length - 1; i++) {
    if (t >= HEAT_STOPS_PDF[i][0] && t <= HEAT_STOPS_PDF[i + 1][0]) {
      lo = HEAT_STOPS_PDF[i];
      hi = HEAT_STOPS_PDF[i + 1];
      break;
    }
  }
  const range = hi[0] - lo[0];
  const f = range === 0 ? 0 : (t - lo[0]) / range;
  const h = Math.round(lo[1] + f * (hi[1] - lo[1]));
  const s = Math.round(lo[2] + f * (hi[2] - lo[2]));
  const l = Math.round(lo[3] + f * (hi[3] - lo[3]));
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

const HEAT_LEGEND_PDF =
  "linear-gradient(to right, " +
  HEAT_STOPS_PDF.map(([, h, s, l]) => `hsl(${h} ${s}% ${l}%)`).join(", ") +
  ")";

// ─── Main viewer ─────────────────────────────────────────────────────────────

// Palette of overlay colors (cycled per question)
const HIGHLIGHT_COLORS = [
  "hsla(220 90% 56% / 0.18)", // blue
  "hsla(142 71% 45% / 0.18)", // green
  "hsla(38 92% 60% / 0.18)", // amber
  "hsla(280 70% 60% / 0.18)", // purple
  "hsla(0 72% 51% / 0.18)", // red
];

// Colors for keyword <mark> highlights in the PDF text layer
const KEYWORD_COLORS = [
  { bg: "rgba(59,130,246,0.5)", border: "#3b82f6" }, // blue
  { bg: "rgba(34,197,94,0.5)", border: "#22c55e" }, // green
  { bg: "rgba(245,158,11,0.5)", border: "#f59e0b" }, // amber
  { bg: "rgba(168,85,247,0.5)", border: "#a855f7" }, // purple
  { bg: "rgba(239,68,68,0.5)", border: "#ef4444" }, // red
];

type KwColor = { bg: string; border: string };

/** Builds a react-pdf customTextRenderer that highlights all keyword phrases in <mark> HTML. */
function makeKeywordRenderer(keywords: string[], color: KwColor) {
  const kws = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  if (!kws.length) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markStyle = `background:${color.bg};outline:1.5px solid ${color.border};border-radius:3px;padding:0 2px;font-weight:700;color:inherit;`;
  const regex = new RegExp(`(${kws.map(esc).join("|")})`, "gi");

  return function ({ str }: { str: string; itemIndex: number }): string {
    if (!kws.some((kw) => str.toLowerCase().includes(kw))) return str;
    return str.replace(regex, (m) => `<mark style="${markStyle}">${m}</mark>`);
  };
}

export function PdfQuizViewer({
  open,
  onClose,
  pdfUrl,
  pdfName,
  questions,
  quizTitle,
  quizSetId,
}: PdfQuizViewerProps) {
  const { t } = useTranslation();
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState(1.0);
  const [activeQuestionIdx, setActiveQuestionIdx] = useState<number | null>(
    null,
  );
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [showAllKeywords, setShowAllKeywords] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapBlocks, setHeatmapBlocks] = useState<HeatmapBlock[]>([]);
  const [heatmapMaxCount, setHeatmapMaxCount] = useState(0);
  const [heatmapLoading, setHeatmapLoading] = useState(false);

  // One ref per PDF page for scrolling
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Page distribution heatmap data
  const pageDistribution = useMemo(
    () => buildPageDistribution(questions),
    [questions],
  );
  const maxPageCount = useMemo(
    () => Math.max(...Array.from(pageDistribution.values()), 1),
    [pageDistribution],
  );

  const scrollToPage = (page: number) => {
    if (page >= 1 && page <= numPages) {
      const el = pageRefs.current[page - 1];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveQuestionIdx(null);
      setNumPages(0);
      setPdfError(null);
      setScale(1.0);
      setShowAllKeywords(false);
      setShowHeatmap(false);
      setHeatmapBlocks([]);
      setHeatmapMaxCount(0);
    }
  }, [open]);

  // Fetch heatmap block data when heatmap mode is toggled on
  useEffect(() => {
    if (!showHeatmap || !quizSetId || heatmapBlocks.length > 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeatmapLoading(true);
    getHeatmapBlocksApi(quizSetId)
      .then((data) => {
        setHeatmapBlocks(data.blocks);
        setHeatmapMaxCount(data.maxCount);
      })
      .catch(() => {
        setHeatmapBlocks([]);
        setHeatmapMaxCount(0);
      })
      .finally(() => setHeatmapLoading(false));
  }, [showHeatmap, quizSetId, heatmapBlocks.length]);

  // Group heatmap blocks by page for efficient lookup
  const heatBlocksByPage = useMemo(() => {
    const map = new Map<number, HeatmapBlock[]>();
    for (const b of heatmapBlocks) {
      const arr = map.get(b.page) ?? [];
      arr.push(b);
      map.set(b.page, arr);
    }
    return map;
  }, [heatmapBlocks]);

  // Compute which pages are currently highlighted (and which color)
  const highlightMap = useCallback((): Map<number, string> => {
    const map = new Map<number, string>();
    if (activeQuestionIdx === null) return map;
    const q = questions[activeQuestionIdx];
    if (!q) return map;
    const color = HIGHLIGHT_COLORS[activeQuestionIdx % HIGHLIGHT_COLORS.length];
    (q.sourcePages ?? []).forEach((p) => map.set(p, color));
    return map;
  }, [activeQuestionIdx, questions]);

  const handleQuestionClick = (idx: number) => {
    if (activeQuestionIdx === idx) {
      setActiveQuestionIdx(null);
      return;
    }
    setActiveQuestionIdx(idx);
    const q = questions[idx];
    const firstPage = (q.sourcePages ?? [])[0];
    if (firstPage) {
      scrollToPage(firstPage);
    }
  };

  const highlights = highlightMap();

  // Build keyword renderer for the active question
  const activeKeywords = useMemo(
    () =>
      activeQuestionIdx !== null
        ? (questions[activeQuestionIdx]?.sourceKeyword ?? [])
        : [],
    [activeQuestionIdx, questions],
  );
  const keywordRenderer = useMemo(() => {
    if (!activeKeywords.length || activeQuestionIdx === null) return undefined;
    const color = KEYWORD_COLORS[activeQuestionIdx % KEYWORD_COLORS.length];
    return makeKeywordRenderer(activeKeywords, color) ?? undefined;
  }, [activeKeywords, activeQuestionIdx]);

  // Build "show all" renderer — highlights every question's keywords with per-question colors
  const allKeywordsRenderer = useMemo(() => {
    type PEntry = { kw: string; markStyle: string };
    const entries: PEntry[] = [];
    questions.forEach((q, idx) => {
      const color = KEYWORD_COLORS[idx % KEYWORD_COLORS.length];
      const ms = `background:${color.bg};outline:1.5px solid ${color.border};border-radius:3px;padding:0 2px;font-weight:700;color:inherit;`;
      (q.sourceKeyword ?? []).forEach((kw) => {
        const k = kw.toLowerCase().trim();
        if (k) entries.push({ kw: k, markStyle: ms });
      });
    });
    if (!entries.length) return undefined;
    entries.sort((a, b) => b.kw.length - a.kw.length);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(${entries.map((e) => esc(e.kw)).join("|")})`,
      "gi",
    );
    return function ({ str }: { str: string; itemIndex: number }): string {
      const lower = str.toLowerCase();
      if (!entries.some((e) => lower.includes(e.kw))) return str;
      return str.replace(regex, (m) => {
        const entry =
          entries.find((e) => m.toLowerCase() === e.kw) ?? entries[0];
        return `<mark style="${entry.markStyle}">${m}</mark>`;
      });
    };
  }, [questions]);

  // Build heatmap text renderer — highlights keywords with thermal heat colors
  const heatmapRenderer = useMemo(() => {
    const kwFreq = new Map<string, number>();
    questions.forEach((q) => {
      (q.sourceKeyword ?? []).forEach((kw) => {
        const k = kw.toLowerCase().trim();
        if (k) kwFreq.set(k, (kwFreq.get(k) ?? 0) + 1);
      });
    });
    if (kwFreq.size === 0) return undefined;
    const maxFreq = Math.max(...kwFreq.values());
    const entries = Array.from(kwFreq.entries())
      .sort((a, b) => b[0].length - a[0].length)
      .map(([kw, count]) => ({
        kw,
        intensity: count / maxFreq,
      }));
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(${entries.map((e) => esc(e.kw)).join("|")})`,
      "gi",
    );
    return function ({ str }: { str: string; itemIndex: number }): string {
      const lower = str.toLowerCase();
      if (!entries.some((e) => lower.includes(e.kw))) return str;
      return str.replace(regex, (m) => {
        const entry =
          entries.find((e) => m.toLowerCase() === e.kw) ?? entries[0];
        const bg = thermalColorPdfAlpha(
          entry.intensity,
          0.4 + entry.intensity * 0.3,
        );
        const border = thermalColorPdf(entry.intensity);
        return `<mark style="background:${bg};outline:2px solid ${border};border-radius:3px;padding:1px 3px;font-weight:700;color:inherit;">${m}</mark>`;
      });
    };
  }, [questions]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
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
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-semibold leading-tight">
                {quizTitle}
              </DialogTitle>
              <p className="truncate text-xs text-muted-foreground">
                {pdfName}
              </p>
            </div>
          </div>

          {/* PDF controls */}
          <div className="flex shrink-0 items-center gap-1 ml-4">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setScale((s) => Math.max(0.5, s - 0.15))}
              title={t("pdfViewer.zoomOut")}
            >
              <ZoomOut className="size-3.5" />
            </Button>
            <span className="min-w-12 text-center text-xs text-muted-foreground">
              {Math.round(scale * 100)}%
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}
              title={t("pdfViewer.zoomIn")}
            >
              <ZoomIn className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setScale(1.0)}
              title={t("pdfViewer.resetZoom")}
            >
              <RotateCcw className="size-3.5" />
            </Button>
            <div className="mx-1 h-5 w-px bg-border" />
            <Button
              size="icon"
              variant={showHeatmap ? "default" : "ghost"}
              className="h-7 w-7"
              onClick={() => setShowHeatmap((v) => !v)}
              title={
                showHeatmap
                  ? t("pdfViewer.heatmapOff")
                  : t("pdfViewer.heatmapOn")
              }
            >
              <Flame className="size-3.5" />
            </Button>
            <div className="mx-1 h-5 w-px bg-border" />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onClose}
              title={t("common.close")}
              aria-label={t("a11y.labels.closeViewer")}
            >
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* ── Left: Question list ─────────────────────────────── */}
          <div className="flex w-[38%] shrink-0 flex-col border-r min-h-0 overflow-hidden">
            <div className="border-b px-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("pdfViewer.questionCount", { count: questions.length })}
                </p>
                <button
                  onClick={() => setShowAllKeywords((v) => !v)}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                    showAllKeywords
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                  )}
                  title={
                    showAllKeywords
                      ? t("pdfViewer.highlightAllOff")
                      : t("pdfViewer.highlightAllOn")
                  }
                >
                  <Layers className="size-3" />
                  {t("pdfViewer.all")}
                </button>
              </div>
              {showAllKeywords ? (
                <p className="mt-0.5 text-[10px] text-primary/80">
                  {t("pdfViewer.highlightingAll")} •{" "}
                  <button
                    className="underline hover:text-foreground"
                    onClick={() => setShowAllKeywords(false)}
                  >
                    {t("pdfViewer.turnOff")}
                  </button>
                </p>
              ) : activeQuestionIdx !== null ? (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t("pdfViewer.viewingSource", { n: activeQuestionIdx + 1 })} •{" "}
                  <button
                    className="underline hover:text-foreground"
                    onClick={() => setActiveQuestionIdx(null)}
                  >
                    {t("pdfViewer.deselect")}
                  </button>
                </p>
              ) : (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t("pdfViewer.clickToView")}
                </p>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="space-y-0.5 p-2">
                {questions.map((q, i) => (
                  <QuestionRow
                    key={q.id}
                    question={q}
                    index={i}
                    active={activeQuestionIdx === i}
                    onClick={() => handleQuestionClick(i)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ── Right: PDF viewer ───────────────────────────────── */}
          <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden bg-muted/30">
            {pdfError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                <BookOpen className="size-12 opacity-30" />
                <p className="text-sm font-medium">
                  {t("pdfViewer.pdfLoadError")}
                </p>
                <p className="text-xs">{pdfError}</p>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="flex flex-col items-center gap-4 py-4 px-2">
                  <Document
                    file={pdfUrl}
                    onLoadSuccess={({ numPages: n }) => {
                      setNumPages(n);
                      pageRefs.current = new Array(n).fill(null);
                    }}
                    onLoadError={(err) =>
                      setPdfError(err.message || t("pdfViewer.unknownError"))
                    }
                    loading={
                      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                        <Loader2 className="size-8 animate-spin" />
                        <p className="text-sm">{t("pdfViewer.loadingPdf")}</p>
                      </div>
                    }
                  >
                    {Array.from({ length: numPages }, (_, i) => {
                      const pageNum = i + 1;
                      const highlightColor = highlights.get(pageNum);
                      const isHighlighted = !!highlightColor;
                      const heatCount = pageDistribution.get(pageNum) ?? 0;
                      const heatIntensity = heatCount / maxPageCount;
                      return (
                        <div
                          key={pageNum}
                          ref={(el) => {
                            pageRefs.current[i] = el;
                          }}
                          className="relative mb-1 shadow-sm"
                        >
                          {/* Page number label */}
                          <div className="absolute -top-5 left-0 z-20 text-[10px] text-muted-foreground select-none">
                            {t("pdfViewer.page")} {pageNum}
                          </div>

                          <Page
                            pageNumber={pageNum}
                            scale={scale}
                            renderTextLayer
                            renderAnnotationLayer={false}
                            customTextRenderer={
                              showHeatmap
                                ? heatmapRenderer
                                : showAllKeywords
                                  ? allKeywordsRenderer
                                  : isHighlighted
                                    ? keywordRenderer
                                    : undefined
                            }
                          />

                          {/* Heatmap overlay — block-level bounding boxes */}
                          {showHeatmap &&
                            (() => {
                              const pageBlocks =
                                heatBlocksByPage.get(pageNum) ?? [];
                              const hasBlocks = pageBlocks.length > 0;
                              return (
                                <div className="absolute inset-0 z-10 pointer-events-none">
                                  {/* Loading indicator */}
                                  {heatmapLoading && (
                                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground shadow">
                                      <Loader2 className="size-3 animate-spin" />
                                      Loading heatmap...
                                    </div>
                                  )}
                                  {/* Block-level bbox overlays */}
                                  {hasBlocks &&
                                    pageBlocks.map((block, bIdx) => {
                                      const [x0, y0, x1, y1] = block.bbox;
                                      const { pageWidth, pageHeight } = block;
                                      const intensity =
                                        heatmapMaxCount > 0
                                          ? block.count / heatmapMaxCount
                                          : 0;
                                      // Convert PDF coordinates to percentages
                                      const left = (x0 / pageWidth) * 100;
                                      const top = (y0 / pageHeight) * 100;
                                      const width =
                                        ((x1 - x0) / pageWidth) * 100;
                                      const height =
                                        ((y1 - y0) / pageHeight) * 100;
                                      return (
                                        <div
                                          key={bIdx}
                                          className="absolute rounded-sm transition-opacity duration-300 pointer-events-auto"
                                          title={`${block.count} keyword${block.count > 1 ? "s" : ""}: ${block.keywords.slice(0, 3).join(", ")}`}
                                          style={{
                                            left: `${left}%`,
                                            top: `${top}%`,
                                            width: `${width}%`,
                                            height: `${height}%`,
                                            background: thermalColorPdfAlpha(
                                              intensity,
                                              0.15 + intensity * 0.25,
                                            ),
                                            borderLeft: `3px solid ${thermalColorPdf(intensity)}`,
                                            boxShadow:
                                              intensity > 0.5
                                                ? `0 0 8px ${thermalColorPdfAlpha(intensity, 0.3)}`
                                                : "none",
                                          }}
                                        />
                                      );
                                    })}
                                  {/* Fallback: page-level radial gradient if no blocks loaded yet */}
                                  {!hasBlocks && heatCount > 0 && (
                                    <div
                                      className="absolute inset-0"
                                      style={{
                                        background: `radial-gradient(ellipse 130% 110% at 50% 45%, ${thermalColorPdfAlpha(heatIntensity, 0.18 + heatIntensity * 0.18)} 0%, ${thermalColorPdfAlpha(heatIntensity, 0.06 + heatIntensity * 0.08)} 60%, transparent 92%)`,
                                      }}
                                    />
                                  )}
                                  {/* Heat badge on page */}
                                  {heatCount > 0 && (
                                    <div
                                      className="absolute top-2 right-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold text-white shadow-md pointer-events-auto z-20"
                                      style={{
                                        background:
                                          thermalColorPdf(heatIntensity),
                                      }}
                                    >
                                      <Flame className="size-3" />
                                      {heatCount} {t("pdfViewer.questions")}
                                      {hasBlocks && (
                                        <span className="text-[9px] opacity-80 ml-0.5">
                                          · {pageBlocks.length}{" "}
                                          {t("pdfViewer.zones")}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {/* Side heat bar */}
                                  {heatCount > 0 && (
                                    <div
                                      className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l"
                                      style={{
                                        background:
                                          thermalColorPdf(heatIntensity),
                                      }}
                                    />
                                  )}
                                </div>
                              );
                            })()}
                        </div>
                      );
                    })}
                  </Document>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Heatmap legend bar (below PDF, above footer) */}
        {showHeatmap && numPages > 0 && (
          <div className="shrink-0 flex items-center gap-3 border-t bg-muted/40 px-4 py-1.5">
            <Flame className="size-3.5 text-orange-500" />
            <span className="text-[11px] font-medium text-muted-foreground">
              Heatmap
            </span>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>{t("pdfViewer.low")}</span>
              <div
                className="h-2.5 w-24 rounded-sm"
                style={{ background: HEAT_LEGEND_PDF }}
              />
              <span>{t("pdfViewer.high")}</span>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {
                Array.from(pageDistribution.values()).filter((c) => c > 0)
                  .length
              }
              /{numPages} {t("pdfViewer.pagesWithQuestions")}
            </span>
            {heatmapBlocks.length > 0 && (
              <span className="text-[10px] text-orange-500/80">
                · {heatmapBlocks.length} {t("pdfViewer.heatZones")}
              </span>
            )}
          </div>
        )}

        {/* Footer status */}
        {numPages > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              {numPages} {t("pdfViewer.page")}
            </span>
            {showHeatmap ? (
              <span className="text-orange-500">
                <Flame className="inline size-3 mr-0.5" />
                Heatmap —{" "}
                {
                  Array.from(pageDistribution.values()).filter((c) => c > 0)
                    .length
                }{" "}
                {t("pdfViewer.pagesLabel")}
                {" · "}
                {Array.from(pageDistribution.values()).reduce(
                  (a, b) => a + b,
                  0,
                )}{" "}
                {t("pdfViewer.questions")}
                {heatmapBlocks.length > 0 && (
                  <>
                    {" · "}
                    {heatmapBlocks.length} {t("pdfViewer.heatZones")}
                  </>
                )}
              </span>
            ) : showAllKeywords ? (
              <span className="text-primary">
                {
                  Array.from(pageDistribution.values()).filter((c) => c > 0)
                    .length
                }
                /{numPages} {t("pdfViewer.pagesLabel")}
                {" \u00b7 "}
                {
                  questions.filter((q) => (q.sourceKeyword ?? []).length > 0)
                    .length
                }
                /{questions.length} {t("pdfViewer.questionsWithKeywords")}
              </span>
            ) : activeQuestionIdx !== null ? (
              <span className="text-primary">
                {t("pdfViewer.questionN", { n: activeQuestionIdx + 1 })} \u2192{" "}
                {(questions[activeQuestionIdx]?.sourcePages ?? []).length > 0
                  ? `${t("pdfViewer.page")} ${(questions[activeQuestionIdx]?.sourcePages ?? []).join(", ")}`
                  : t("pdfViewer.noSourcePage")}
              </span>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
