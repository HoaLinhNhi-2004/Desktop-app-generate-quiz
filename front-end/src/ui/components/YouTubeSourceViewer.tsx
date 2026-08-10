/**
 * YouTubeSourceViewer — Timeline heatmap viewer for YouTube-sourced quizzes.
 *
 * Shows which parts of the video generated the most quiz questions,
 * displayed as a horizontal bar chart grouped by minute.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { X, Loader2, Youtube, Flame, ChevronRight } from "lucide-react";
import type { QuizQuestion, YouTubeTimelineSegment } from "@/features/quizz";
import { getYouTubeTimelineApi } from "@/features/quizz";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function thermalColor(intensity: number): string {
  if (intensity <= 0) return "hsl(var(--muted))";
  const t = Math.max(0, Math.min(1, intensity));
  // Blue → Cyan → Yellow → Orange → Red
  const stops: [number, number, number, number][] = [
    [0.0, 220, 80, 55],
    [0.25, 185, 85, 45],
    [0.5, 60, 100, 50],
    [0.75, 30, 100, 50],
    [1.0, 0, 90, 50],
  ];
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
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

function extractVideoId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/,
  );
  return m ? m[1] : null;
}

// ─── Question row (compact) ─────────────────────────────────────────────────

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

// ─── Timeline Bar ───────────────────────────────────────────────────────────

function TimelineBar({
  segment,
  maxCount,
  onSeek,
}: {
  segment: YouTubeTimelineSegment;
  maxCount: number;
  onSeek: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const intensity = maxCount > 0 ? segment.questionCount / maxCount : 0;
  const barWidth =
    maxCount > 0 ? Math.max(4, (segment.questionCount / maxCount) * 100) : 0;

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            onClick={() =>
              segment.questionCount > 0 && onSeek(segment.minute * 60)
            }
            className={cn(
              "flex items-center gap-3 py-1 px-3 rounded-md transition-colors group",
              segment.questionCount > 0
                ? "hover:bg-muted/60 cursor-pointer"
                : "opacity-50",
            )}
          >
            {/* Time label */}
            <span className="w-12 text-xs font-mono text-muted-foreground shrink-0 text-right">
              {segment.label}
            </span>

            {/* Bar */}
            <div className="flex-1 h-5 flex items-center">
              {segment.questionCount > 0 ? (
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${barWidth}%`,
                    minWidth: "8px",
                    backgroundColor: thermalColor(intensity),
                  }}
                />
              ) : (
                <div className="h-1 w-full rounded-full bg-muted" />
              )}
            </div>

            {/* Count */}
            <span
              className={cn(
                "w-6 text-right text-xs font-medium shrink-0",
                segment.questionCount > 0
                  ? "text-foreground"
                  : "text-muted-foreground/40",
              )}
            >
              {segment.questionCount > 0 ? segment.questionCount : ""}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          <div className="space-y-1">
            <p className="font-medium text-xs">
              {segment.label} –{" "}
              {t("youtubeViewer.conceptsFound", {
                count: segment.questionCount,
              })}
            </p>
            {segment.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {segment.keywords.slice(0, 5).map((kw, i) => (
                  <Badge key={i} variant="secondary" className="text-[10px]">
                    {kw}
                  </Badge>
                ))}
                {segment.keywords.length > 5 && (
                  <span className="text-[10px] text-muted-foreground">
                    +{segment.keywords.length - 5}
                  </span>
                )}
              </div>
            )}
            {segment.questionCount > 0 && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Youtube className="size-3" />
                {t("youtubeViewer.clickToWatch")}
              </p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface YouTubeSourceViewerProps {
  open: boolean;
  onClose: () => void;
  questions: QuizQuestion[];
  quizTitle: string;
  quizSetId: string;
}

export function YouTubeSourceViewer({
  open,
  onClose,
  questions,
  quizTitle,
  quizSetId,
}: YouTubeSourceViewerProps) {
  const { t } = useTranslation();
  const [segments, setSegments] = useState<YouTubeTimelineSegment[]>([]);
  const [totalDuration, setTotalDuration] = useState(0);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !quizSetId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    getYouTubeTimelineApi(quizSetId)
      .then((res) => {
        setSegments(res.segments);
        setTotalDuration(res.totalDuration);
        setYoutubeUrl(res.youtubeUrl);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, quizSetId]);

  const maxCount = useMemo(
    () => Math.max(...segments.map((s) => s.questionCount), 1),
    [segments],
  );

  // Top hotspots
  const hotspots = useMemo(
    () =>
      segments
        .filter((s) => s.questionCount > 0)
        .sort((a, b) => b.questionCount - a.questionCount)
        .slice(0, 5),
    [segments],
  );

  const totalQFromTimeline = useMemo(
    () => segments.reduce((a, s) => a + s.questionCount, 0),
    [segments],
  );

  const videoId = useMemo(
    () => (youtubeUrl ? extractVideoId(youtubeUrl) : null),
    [youtubeUrl],
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const seekTo = useCallback((seconds: number) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      JSON.stringify({
        event: "command",
        func: "seekTo",
        args: [seconds, true],
      }),
      "*",
    );
    iframe.contentWindow.postMessage(
      JSON.stringify({ event: "command", func: "playVideo", args: [] }),
      "*",
    );
  }, []);

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
            <Youtube className="size-4 shrink-0 text-red-500" />
            <DialogTitle className="truncate text-sm font-semibold">
              {quizTitle || t("youtubeViewer.title")}
            </DialogTitle>
            <Badge variant="secondary" className="text-[10px] shrink-0">
              YouTube
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
                    active={false}
                    onClick={() => {}}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right: Timeline heatmap */}
          <div className="flex-1 min-h-0 flex flex-col">
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                {error}
              </div>
            ) : segments.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                {t("youtubeViewer.noTimeline")}
              </div>
            ) : (
              <>
                {/* Video player */}
                {videoId && (
                  <div
                    className="shrink-0 border-b bg-black"
                    style={{ height: "40%" }}
                  >
                    <iframe
                      ref={iframeRef}
                      src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${window.location.origin}`}
                      className="w-full h-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      title={quizTitle}
                    />
                  </div>
                )}

                {/* Summary bar */}
                <div className="shrink-0 border-b px-6 py-3 space-y-2">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>
                      <Flame className="size-3 inline mr-1 text-orange-500" />
                      {t("youtubeViewer.timelineTitle")}
                    </span>
                    <span>
                      {t("youtubeViewer.duration")}:{" "}
                      {formatDuration(totalDuration)}
                    </span>
                    <span>
                      {totalQFromTimeline} {t("youtubeViewer.conceptMatches")}
                    </span>
                  </div>

                  {/* Hotspots */}
                  {hotspots.length > 0 && (
                    <div className="max-h-16 overflow-y-auto">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground font-medium">
                          {t("youtubeViewer.worthStudying")}:
                        </span>
                        {hotspots.map((s) => (
                          <button
                            key={s.minute}
                            onClick={() => seekTo(s.minute * 60)}
                            className="inline-flex items-center gap-1 rounded-full bg-orange-100 dark:bg-orange-900/30 px-2 py-0.5 text-orange-700 dark:text-orange-300 hover:underline cursor-pointer"
                          >
                            {s.label}
                            <span className="font-semibold">
                              ({s.questionCount})
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Legend */}
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{t("youtubeViewer.fewConcepts")}</span>
                    <div
                      className="h-1.5 w-20 rounded-sm"
                      style={{
                        background:
                          "linear-gradient(to right, hsl(220 80% 55%), hsl(185 85% 45%), hsl(60 100% 50%), hsl(30 100% 50%), hsl(0 90% 50%))",
                      }}
                    />
                    <span>{t("youtubeViewer.manyConcepts")}</span>
                    <span className="ml-2 text-muted-foreground/60">
                      {t("youtubeViewer.clickTimeToWatch")}
                    </span>
                  </div>
                </div>

                {/* Timeline bars */}
                <ScrollArea className="flex-1 h-0">
                  <div className="py-2 px-2">
                    {segments.map((seg) => (
                      <TimelineBar
                        key={seg.minute}
                        segment={seg}
                        maxCount={maxCount}
                        onSeek={seekTo}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t px-5 py-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {formatDuration(totalDuration)} · {questions.length}{" "}
            {t("common.questions")}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
