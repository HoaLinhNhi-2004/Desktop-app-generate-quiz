import { useState, useEffect, type ElementType } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import i18n from "@/config/i18n";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sparkles,
  ArrowRight,
  Loader2,
  Settings2,
  Upload,
  ArrowLeft,
  Folder,
  Play,
  Trash2,
  History,
  BookOpen,
  FileUp,
  BarChart3,
  Brain,
  CheckCircle2,
  ScanText,
  BookOpenCheck,
  Edit3,
  FileSearch,
} from "lucide-react";
import { PdfQuizViewer } from "../components/PdfQuizViewer";
import { TextSourceViewer } from "../components/TextSourceViewer";
import { YouTubeSourceViewer } from "../components/YouTubeSourceViewer";
import { SpreadsheetSourceViewer } from "../components/SpreadsheetSourceViewer";
import {
  useUploadsByQuizSet,
  useUploadsByIds,
  getUploadFileUrl,
} from "@/features/upload";
import { QuizConfigPanel } from "../components/QuizConfig";
import { MaterialsTab } from "../components/MaterialsTab";
import { MaterialSelectPanel } from "../components/MaterialSelectPanel";
import {
  useGenerateQuiz,
  useQuizSets,
  useDeleteQuizSet,
  getQuizSetApi,
} from "@/features/quizz";
import type {
  QuizConfig,
  QuizQuestion,
  InputMode,
  QuizSetSummary,
} from "@/features/quizz";
import { useFolders } from "../../features/folders";
import { useUploadRecords } from "@/features/upload";
import { FolderStatsSection } from "../components/folder-stats";
import { useFolderDetailStats } from "@/features/stats";

// ─── Error parsing ──────────────────────────────────────────────────────────

function parseQuizError(err: Error): {
  title: string;
  description: string;
  duration?: number;
} {
  const msg = err.message ?? "";

  // Quota / rate limit (HTTP 429)
  if (/429|quota exceeded|rate.?limit|free.?tier/i.test(msg)) {
    if (/all gemini models exhausted/i.test(msg)) {
      return {
        title: i18n.t("errors.allModelsExhausted.title"),
        description: i18n.t("errors.allModelsExhausted.description"),
        duration: 12000,
      };
    }
    const retryMatch =
      msg.match(/retry(?: in)? (\d+(?:\.\d+)?)\s*s/i) ??
      msg.match(/seconds: (\d+)/i);
    const retrySec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
    const retryNote = retrySec
      ? ` ${i18n.t("errors.quotaExceeded.retryIn", { seconds: retrySec })}`
      : ` ${i18n.t("errors.quotaExceeded.retryLater")}`;
    return {
      title: i18n.t("errors.quotaExceeded.title"),
      description:
        i18n.t("errors.quotaExceeded.description") +
        retryNote +
        ` ${i18n.t("errors.quotaExceeded.checkBilling")}`,
      duration: 10000,
    };
  }

  if (/api key not configured|GEMINI_API_KEY|chưa có gemini/i.test(msg)) {
    return {
      title: i18n.t("errors.noApiKey.title"),
      description: i18n.t("errors.noApiKey.description"),
      duration: 8000,
    };
  }

  if (/401|invalid.?api.?key|api_key_invalid/i.test(msg)) {
    return {
      title: i18n.t("errors.invalidApiKey.title"),
      description: i18n.t("errors.invalidApiKey.description"),
      duration: 8000,
    };
  }

  if (/could not extract any text|no text content/i.test(msg)) {
    return {
      title: i18n.t("errors.noTextExtracted.title"),
      description: i18n.t("errors.noTextExtracted.description"),
      duration: 8000,
    };
  }

  if (/no transcripts|transcripts disabled|captions disabled/i.test(msg)) {
    return {
      title: i18n.t("errors.noTranscript.title"),
      description: i18n.t("errors.noTranscript.description"),
      duration: 8000,
    };
  }

  if (/invalid youtube url/i.test(msg)) {
    return {
      title: i18n.t("errors.invalidYoutubeUrl.title"),
      description: i18n.t("errors.invalidYoutubeUrl.description"),
      duration: 6000,
    };
  }

  if (/network|fetch|ECONNREFUSED|failed to fetch/i.test(msg)) {
    return {
      title: i18n.t("errors.networkError.title"),
      description: i18n.t("errors.networkError.description"),
      duration: 8000,
    };
  }

  return {
    title: i18n.t("errors.quizFailed.title"),
    description:
      msg.length > 200
        ? msg.slice(0, 200) + "…"
        : msg || i18n.t("errors.quizFailed.unknownError"),
    duration: 8000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function getQuestionTypeLabel(key: string): string {
  const map: Record<string, string> = {
    "multiple-choice": i18n.t("folderStats.qtype.multiple-choice"),
    "true-false": i18n.t("folderStats.qtype.true-false"),
    "fill-blank": i18n.t("folderStats.qtype.fill-blank"),
    mixed: i18n.t("folderStats.qtype.mixed"),
  };
  return map[key] ?? key;
}

function getDifficultyLabel(key: string): string {
  const map: Record<string, string> = {
    easy: i18n.t("folderStats.difficulty.easy"),
    medium: i18n.t("folderStats.difficulty.medium"),
    hard: i18n.t("folderStats.difficulty.hard"),
    mixed: i18n.t("folderStats.difficulty.mixed"),
  };
  return map[key] ?? key;
}

const DIFFICULTY_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  easy: "secondary",
  medium: "default",
  hard: "destructive",
  mixed: "outline",
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Small count badge for the history tab ───────────────────────────────────

function QuizCountBadge({ folderId }: { folderId: string }) {
  const { data: quizSets } = useQuizSets(folderId);
  if (!quizSets || quizSets.length === 0) return null;
  return (
    <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
      {quizSets.length}
    </span>
  );
}

// ─── Small count badge for the uploads tab ─────────────────────────────────────

function UploadCountBadge({ folderId }: { folderId: string }) {
  const { data: records } = useUploadRecords(folderId);
  if (!records || records.length === 0) return null;
  return (
    <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
      {records.length}
    </span>
  );
}

// ─── Small count badge for the stats tab ────────────────────────────────────

function StatsCountBadge({ folderId }: { folderId: string }) {
  const { data } = useFolderDetailStats(folderId);
  if (!data || data.summary.totalAttempts === 0) return null;
  return (
    <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
      {data.summary.totalAttempts}
    </span>
  );
}

// ─── Quiz History Section ─────────────────────────────────────────────────────

interface QuizHistorySectionProps {
  folderId: string;
}

function QuizHistorySection({ folderId }: QuizHistorySectionProps) {
  const { data: quizSets, isLoading } = useQuizSets(folderId);
  const { data: folderStats } = useFolderDetailStats(folderId);
  const deleteQuizSet = useDeleteQuizSet();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [viewerQuizSetId, setViewerQuizSetId] = useState<string | null>(null);
  const navigate = useNavigate();

  // PDF viewer state — prefer sourceUploadIds (new flow), fall back to quiz_set FK (legacy)
  const viewerQuizSet = quizSets?.find((s) => s.id === viewerQuizSetId);
  const viewerSourceIds = viewerQuizSet?.sourceUploadIds;
  const { data: uploadsByIds } = useUploadsByIds(viewerSourceIds);
  const { data: uploadsByQuizSet } = useUploadsByQuizSet(
    !viewerSourceIds?.length ? (viewerQuizSetId ?? undefined) : undefined,
  );
  const viewerUploads = uploadsByIds ?? uploadsByQuizSet;
  const [_viewerQs, _setViewerQs] = useState<QuizQuestion[]>([]);
  const [viewerLoading, setViewerLoading] = useState(false);

  useEffect(() => {
    if (!viewerQuizSetId) {
      _setViewerQs([]);
      return;
    }
    setViewerLoading(true);
    getQuizSetApi(viewerQuizSetId)
      .then((d) => _setViewerQs(d.questions as QuizQuestion[]))
      .catch(() => _setViewerQs([]))
      .finally(() => setViewerLoading(false));
  }, [viewerQuizSetId]);

  const viewerPdfRecord = viewerUploads?.find(
    (r) => r.inputMode === "files" && r.fileType?.toLowerCase() === "pdf",
  );
  const viewerQuizTitle = viewerQuizSet?.title ?? "";

  // Build a lookup for quiz breakdown data
  const quizStatsMap = new Map(
    (folderStats?.quizBreakdown ?? []).map((q) => [q.quizSetId, q]),
  );

  const handleStart = async (set: QuizSetSummary) => {
    setLoadingId(set.id);
    try {
      const detail = await getQuizSetApi(set.id);
      navigate("/quiz", {
        state: {
          questions: detail.questions,
          config: detail.config,
          extractedText: "",
          filesProcessed: 0,
          folderId,
          quizSetId: set.id,
          sourceFiles: [],
        },
      });
    } catch {
      toast.error(i18n.t("errors.loadQuizFailed"), {
        description: i18n.t("errors.tryAgain"),
      });
    } finally {
      setLoadingId(null);
    }
  };

  const handleDelete = (set: QuizSetSummary) => {
    deleteQuizSet.mutate(set.id, {
      onSuccess: () =>
        toast.success(i18n.t("errors.deleted"), {
          description: `"${set.title}"`,
        }),
      onError: () =>
        toast.error(i18n.t("errors.deleteFailed"), {
          description: i18n.t("errors.tryAgain"),
        }),
    });
  };

  return (
    <>
      <Card className="flex flex-col h-full">
        <CardContent className="flex-1 min-h-0 p-0">
          <ScrollArea className="h-full">
            {isLoading ? (
              <div className="space-y-2 px-6 pb-4">
                {[1, 2, 3].map((n) => (
                  <div
                    key={n}
                    className="h-10 w-full animate-pulse rounded-md bg-muted"
                  />
                ))}
              </div>
            ) : !quizSets || quizSets.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                <BookOpen className="size-8 opacity-40" />
                <p className="text-sm">{i18n.t("quizHistory.empty")}</p>
              </div>
            ) : (
              <div className="divide-y">
                {quizSets.map((set) => {
                  const qStats = quizStatsMap.get(set.id);
                  return (
                    <div
                      key={set.id}
                      className="px-6 py-3 hover:bg-muted/40 transition-colors space-y-1.5"
                    >
                      {/* Row 1: Title + actions */}
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate text-sm font-medium min-w-0">
                          {set.title}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => setViewerQuizSetId(set.id)}
                            title={i18n.t("quizHistory.viewSource")}
                          >
                            <BookOpenCheck className="size-3.5" />
                            <span className="hidden sm:inline">
                              {i18n.t("quizHistory.viewSource")}
                            </span>
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7 gap-1 text-xs"
                            disabled={loadingId === set.id}
                            onClick={() => navigate(`/quiz/${set.id}/edit`)}
                            title="Edit"
                          >
                            <Edit3 className="size-3" />
                            <span className="hidden sm:inline">
                              Edit
                            </span>
                          </Button>
                          <Button
                            size="sm"
                            variant="default"
                            className="h-7 gap-1 text-xs"
                            disabled={loadingId === set.id}
                            onClick={() => handleStart(set)}
                          >
                            {loadingId === set.id ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Play className="size-3" />
                            )}
                            {i18n.t("quizHistory.start")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            disabled={deleteQuizSet.isPending}
                            onClick={() => handleDelete(set)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Row 2: Meta + badges + score */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          {formatDate(set.createdAt)} · {set.questionCount}{" "}
                          {i18n.t("common.questions")}
                          {qStats && qStats.attemptCount > 0 && (
                            <>
                              {" "}
                              · {qStats.attemptCount}{" "}
                              {i18n.t("common.attempts")}
                            </>
                          )}
                        </span>
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-4"
                        >
                          {getQuestionTypeLabel(set.config?.questionType)}
                        </Badge>
                        <Badge
                          variant={
                            DIFFICULTY_VARIANT[set.config?.difficulty] ??
                            "outline"
                          }
                          className="text-[10px] px-1.5 py-0 h-4"
                        >
                          {getDifficultyLabel(set.config?.difficulty)}
                        </Badge>
                        {qStats && qStats.lastScore !== null && (
                          <span
                            className="text-xs font-semibold ml-auto"
                            style={{
                              color:
                                qStats.lastScore >= 80
                                  ? "hsl(142 71% 45%)"
                                  : qStats.lastScore >= 60
                                    ? "hsl(48 96% 53%)"
                                    : qStats.lastScore >= 40
                                      ? "hsl(25 95% 53%)"
                                      : "hsl(0 72% 51%)",
                            }}
                          >
                            {qStats.lastScore}%
                            {qStats.bestScore !== null &&
                              qStats.bestScore !== qStats.lastScore && (
                                <span className="text-[10px] text-muted-foreground font-normal ml-1">
                                  (best {qStats.bestScore}%)
                                </span>
                              )}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* PDF source viewer dialog */}
      <QuizPdfViewerDialog
        quizSetId={viewerQuizSetId}
        viewerQuestions={_viewerQs}
        viewerLoading={viewerLoading}
        viewerPdfRecord={viewerPdfRecord}
        viewerUploads={viewerUploads}
        quizTitle={viewerQuizTitle}
        onClose={() => setViewerQuizSetId(null)}
      />
    </>
  );
}
function QuizPdfViewerDialog({
  quizSetId,
  viewerQuestions,
  viewerLoading,
  viewerPdfRecord,
  viewerUploads,
  quizTitle,
  onClose,
}: {
  quizSetId: string | null;
  viewerQuestions: import("@/features/quizz").QuizQuestion[];
  viewerLoading: boolean;
  viewerPdfRecord: import("@/features/upload").UploadRecord | undefined;
  viewerUploads: import("@/features/upload").UploadRecord[] | undefined;
  quizTitle: string;
  onClose: () => void;
}) {
  if (!quizSetId) return null;

  // Detect input mode from upload records
  const inputMode = viewerUploads?.[0]?.inputMode;
  const isSpreadsheet = viewerUploads?.[0]?.fileType?.toLowerCase() && ["xlsx", "xls", "csv"].includes(viewerUploads?.[0].fileType.toLowerCase());
  const viewerSpreadsheetRecord = isSpreadsheet ? viewerUploads?.[0] : undefined;

  return (
    <>
      {viewerLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <Loader2 className="size-8 animate-spin text-primary" />
        </div>
      )}
      {!viewerLoading && viewerPdfRecord && (
        <PdfQuizViewer
          open
          onClose={onClose}
          pdfUrl={getUploadFileUrl(viewerPdfRecord.id)}
          pdfName={viewerPdfRecord.originalName}
          questions={viewerQuestions}
          quizTitle={quizTitle}
          quizSetId={quizSetId ?? undefined}
        />
      )}
      {!viewerLoading && viewerSpreadsheetRecord && (
        <SpreadsheetSourceViewer
          open
          onClose={onClose}
          excelUrl={getUploadFileUrl(viewerSpreadsheetRecord.id)}
          fileName={viewerSpreadsheetRecord.originalName}
          questions={viewerQuestions}
          quizTitle={quizTitle}
        />
      )}
      {!viewerLoading && !viewerPdfRecord && !viewerSpreadsheetRecord && inputMode !== "youtube" && (
        <TextSourceViewer
          open
          onClose={onClose}
          questions={viewerQuestions}
          quizTitle={quizTitle}
          quizSetId={quizSetId}
        />
      )}
      {!viewerLoading && !viewerPdfRecord && inputMode === "youtube" && (
        <YouTubeSourceViewer
          open
          onClose={onClose}
          questions={viewerQuestions}
          quizTitle={quizTitle}
          quizSetId={quizSetId}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── Generating Progress Modal ──────────────────────────────────────────────

interface GeneratingStage {
  icon: ElementType;
  label: string;
  detail: string;
}

function getGeneratingStages(): Record<InputMode, GeneratingStage[]> {
  return {
    files: [
      {
        icon: Upload,
        label: i18n.t("folder.steps.upload"),
        detail: i18n.t("folder.steps.uploadDesc"),
      },
      {
        icon: ScanText,
        label: i18n.t("folder.steps.extract"),
        detail: i18n.t("folder.steps.extractDesc"),
      },
      {
        icon: Brain,
        label: i18n.t("folder.steps.analyze"),
        detail: i18n.t("folder.steps.analyzeDesc"),
      },
      {
        icon: Sparkles,
        label: i18n.t("folder.steps.aiGenerate"),
        detail: i18n.t("folder.steps.aiGenerateDesc"),
      },
    ],
    youtube: [
      {
        icon: Play,
        label: i18n.t("folder.steps.ytTranscript"),
        detail: i18n.t("folder.steps.ytTranscriptDesc"),
      },
      {
        icon: Brain,
        label: i18n.t("folder.steps.ytSummarize"),
        detail: i18n.t("folder.steps.ytSummarizeDesc"),
      },
      {
        icon: Sparkles,
        label: i18n.t("folder.steps.aiGenerate"),
        detail: i18n.t("folder.steps.ytQuiz"),
      },
    ],
    text: [
      {
        icon: FileUp,
        label: i18n.t("folder.steps.textAnalyze"),
        detail: i18n.t("folder.steps.textAnalyzeDesc"),
      },
      {
        icon: Sparkles,
        label: i18n.t("folder.steps.aiGenerate"),
        detail: i18n.t("folder.steps.textQuiz"),
      },
    ],
  };
}

// Cumulative delay (ms) before advancing to each subsequent stage
const STAGE_DELAYS: Record<InputMode, number[]> = {
  files: [2500, 7000, 6000], // 2.5 s → 9.5 s → 15.5 s
  youtube: [5000, 12000], // 5 s → 17 s
  text: [2000], // 2 s
};

function GeneratingModal({
  open,
  inputMode,
}: {
  open: boolean;
  inputMode: InputMode;
}) {
  const stages = getGeneratingStages()[inputMode];
  const [currentStage, setCurrentStage] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentStage(0);
    if (!open) return;
    const stageDelays = STAGE_DELAYS[inputMode];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cumulative = 0;
    stageDelays.forEach((delay, i) => {
      cumulative += delay;
      const t = setTimeout(() => setCurrentStage(i + 1), cumulative);
      timers.push(t);
    });
    return () => timers.forEach(clearTimeout);
  }, [open, inputMode]);

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-sm gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Loader2 className="size-4 animate-spin text-primary" />
            {i18n.t("folder.generating")}
          </DialogTitle>
          <DialogDescription>
            {i18n.t("folder.generatingWait")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 px-6 pb-6 pt-3">
          {stages.map((stage, i) => {
            const status =
              i < currentStage
                ? "done"
                : i === currentStage
                  ? "active"
                  : "pending";
            const Icon = stage.icon;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-3 rounded-lg p-3 transition-all duration-500",
                  status === "active" && "bg-primary/8 ring-1 ring-primary/20",
                  status === "done" && "opacity-60",
                  status === "pending" && "opacity-30",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                    status === "done" && "bg-emerald-500/15 text-emerald-500",
                    status === "active" && "bg-primary/15 text-primary",
                    status === "pending" && "bg-muted text-muted-foreground",
                  )}
                >
                  {status === "done" ? (
                    <CheckCircle2 className="size-4" />
                  ) : status === "active" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </div>
                <div className="flex min-h-7 flex-col justify-center gap-0.5">
                  <span
                    className={cn(
                      "text-sm font-medium leading-tight",
                      status === "active"
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {stage.label}
                  </span>
                  {status === "active" && (
                    <span className="text-xs text-muted-foreground">
                      {stage.detail}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: QuizConfig = {
  numberOfQuestions: 5,
  questionType: "multiple-choice",
  difficulty: "medium",
  language: "vi",
  timePerQuestion: 30,
};

export function FolderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { folders } = useFolders();
  const folder = folders.find((f) => f.id === id);

  const [config, setConfig] = useState<QuizConfig>(DEFAULT_CONFIG);
  const [reusedFileIds, setReusedFileIds] = useState<string[]>([]);
  const [quizAction, setQuizAction] = useState<"generate" | "import">("generate");

  const generateQuiz = useGenerateQuiz();

  const inputReady = reusedFileIds.length > 0;

  const handleGenerate = () => {
    if (!inputReady) {
      toast.warning(t("folder.noMaterialSelected"), {
        description: t("folder.noMaterialSelectedDesc"),
      });
      return;
    }

    generateQuiz.mutate(
      {
        options: {
          inputMode: "files",
          files: [],
          youtubeInput: { url: "", captionLang: "vi" },
          rawText: "",
          folderId: id,
          reusedFileIds,
          action: quizAction,
        },
        config,
      },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: ["quizSets", id] });
          queryClient.invalidateQueries({ queryKey: ["uploadRecords", id] });

          if (data.tokenUsage && data.tokenUsage.total_tokens > 0) {
            const t = data.tokenUsage;
            toast.info("Token usage", {
              description: `Input: ${t.input_tokens.toLocaleString()} · Output: ${t.output_tokens.toLocaleString()} · Total: ${t.total_tokens.toLocaleString()} tokens`,
              duration: 6000,
            });
          }

          // Check for questions without correct answers (import mode)
          if (quizAction === "import") {
            const noAnswerCount = data.questions.filter(
              (q: QuizQuestion) => !q.correctAnswerId
            ).length;
            if (noAnswerCount > 0) {
              toast.warning(
                t("smartImportQuiz.missingAnswersTitle", { defaultValue: "Câu hỏi chưa có đáp án" }),
                {
                  description: t("smartImportQuiz.missingAnswersDesc", {
                    count: noAnswerCount,
                    defaultValue: `Có ${noAnswerCount} câu hỏi chưa có đáp án đúng. Vui lòng cập nhật thủ công.`,
                  }),
                  duration: 10000,
                },
              );
            }
          }

          navigate("/quiz", {
            state: {
              questions: data.questions,
              config,
              extractedText: data.extractedText,
              filesProcessed: data.filesProcessed,
              folderId: id,
              quizSetId: data.quizSetId,
              sourceFiles: [],
            },
          });
        },
        onError: (err) => {
          const { title, description, duration } = parseQuizError(err);
          toast.error(title, { description, duration: duration ?? 8000 });
        },
      },
    );
  };


  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 min-h-0 flex-col gap-4 p-6">
      <GeneratingModal open={generateQuiz.isPending} inputMode="files" />

      {/* Breadcrumb / Back */}
      <div className="flex items-center gap-3 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          onClick={() => navigate("/")}
        >
          <ArrowLeft className="size-4" />
          {t("folder.title")}
        </Button>
        <span className="text-muted-foreground">/</span>
        <div className="flex items-center gap-2">
          <Folder
            className="size-4"
            style={{ color: folder?.color ?? "hsl(var(--primary))" }}
          />
          <span className="font-medium text-sm">
            {folder?.name ?? t("folder.title")}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="materials" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0 w-fit">
          <TabsTrigger value="materials" className="gap-1.5">
            <FileUp className="size-3.5" />
            {t("folder.tabs.materials")}
            {id && <UploadCountBadge folderId={id} />}
          </TabsTrigger>
          <TabsTrigger value="create" className="gap-1.5">
            <Sparkles className="size-3.5" />
            {t("folder.tabs.createQuiz")}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="size-3.5" />
            {t("folder.tabs.history")}
            {id && <QuizCountBadge folderId={id} />}
          </TabsTrigger>
          <TabsTrigger value="stats" className="gap-1.5">
            <BarChart3 className="size-3.5" />
            {t("folder.tabs.stats")}
            {id && <StatsCountBadge folderId={id} />}
          </TabsTrigger>
        </TabsList>

        {/* ── Materials tab ──────────────────────────────────────── */}
        <TabsContent
          value="materials"
          className="flex-1 min-h-0 overflow-hidden mt-0 pt-4"
        >
          {id && <MaterialsTab folderId={id} />}
        </TabsContent>

        {/* ── Create tab ─────────────────────────────────────────── */}
        <TabsContent
          value="create"
          className="flex-1 min-h-0 overflow-hidden mt-0 pt-4"
        >
          <div className="flex gap-6 h-full min-h-0">
            {/* Left Column - Select materials */}
            <div className="flex flex-1 flex-col gap-6 overflow-y-auto pr-1">
              <MaterialSelectPanel
                folderId={id!}
                selectedIds={reusedFileIds}
                onSelectedIdsChange={setReusedFileIds}
              />
            </div>

            {/* Right Column - Config + Actions (always visible) */}
            <div className="flex w-80 shrink-0 flex-col h-full">
              <Card className="flex flex-col h-full">
                <CardHeader className="shrink-0 pb-3">
                  <CardTitle className="flex items-center gap-2">
                    <Settings2 className="size-5" />
                    {t("folder.quizConfig.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("folder.quizConfig.subtitle")}
                  </CardDescription>
                </CardHeader>

                {/* Mode Toggle: Generate vs Import */}
                <div className="px-6 pb-3">
                  <div className="flex rounded-lg border bg-muted/30 p-1 gap-1">
                    <button
                      type="button"
                      className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-all",
                        quizAction === "generate"
                          ? "bg-background shadow-sm text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setQuizAction("generate")}
                    >
                      <Sparkles className="size-3.5" />
                      {t("smartImportQuiz.modeGenerate", { defaultValue: "Tạo từ tài liệu" })}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-all",
                        quizAction === "import"
                          ? "bg-background shadow-sm text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setQuizAction("import")}
                    >
                      <FileSearch className="size-3.5" />
                      {t("smartImportQuiz.modeImport", { defaultValue: "Trích xuất đề thi" })}
                    </button>
                  </div>
                  {quizAction === "import" && (
                    <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                      {t("smartImportQuiz.importHint", {
                        defaultValue:
                          "AI sẽ tự động nhận diện và trích xuất nguyên bộ câu hỏi từ file đề thi. Số lượng, loại câu hỏi và độ khó sẽ được xác định tự động.",
                      })}
                    </p>
                  )}
                </div>

                {/* Config body — scrolls internally so footer stays visible */}
                <CardContent className="flex-1 min-h-0 p-0">
                  {quizAction === "generate" ? (
                    <ScrollArea className="h-full">
                      <div className="px-6 pb-4">
                        <QuizConfigPanel
                          config={config}
                          onConfigChange={setConfig}
                        />
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3 h-full px-6 text-center">
                      <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
                        <FileSearch className="size-7 text-primary" />
                      </div>
                      <p className="text-sm font-medium">
                        {t("smartImportQuiz.importReadyTitle", {
                          defaultValue: "Q&A Document",
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t("smartImportQuiz.importReadyDesc", {
                          defaultValue:
                            "Chọn file chứa đề thi bên trái, AI sẽ tự động trích xuất tất cả câu hỏi và đáp án.",
                        })}
                      </p>
                    </div>
                  )}
                </CardContent>

                {/* Buttons always anchored at the bottom of the card */}
                <CardFooter className="flex flex-col gap-2 pt-4 border-t">
                  <Button
                    size="lg"
                    className={cn(
                      "w-full gap-2 text-base font-semibold transition-all",
                      inputReady
                        ? quizAction === "import"
                          ? "bg-linear-to-r from-amber-500 to-orange-500 shadow-lg shadow-orange-500/25 hover:shadow-xl hover:shadow-orange-500/30 text-white"
                          : "bg-linear-to-r from-primary to-primary/80 shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30"
                        : "",
                    )}
                    disabled={!inputReady || generateQuiz.isPending}
                    onClick={handleGenerate}
                  >
                    {generateQuiz.isPending ? (
                      <>
                        <Loader2 className="size-5 animate-spin" />
                        {quizAction === "import"
                          ? t("smartImportQuiz.importing", { defaultValue: "Đang trích xuất..." })
                          : t("folder.generating")}
                      </>
                    ) : (
                      <>
                        {quizAction === "import" ? (
                          <FileSearch className="size-5" />
                        ) : (
                          <Sparkles className="size-5" />
                        )}
                        {quizAction === "import"
                          ? t("smartImportQuiz.importBtn", { defaultValue: "Trích xuất câu hỏi" })
                          : t("folder.createQuizBtn")}
                        <ArrowRight className="size-4" />
                      </>
                    )}
                  </Button>

                </CardFooter>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ── History tab ────────────────────────────────────────── */}
        <TabsContent
          value="history"
          className="flex-1 min-h-0 overflow-hidden mt-0 pt-4"
        >
          {id && <QuizHistorySection folderId={id} />}
        </TabsContent>

        {/* ── Stats tab ──────────────────────────────────────────── */}
        <TabsContent
          value="stats"
          className="flex-1 min-h-0 overflow-hidden mt-0 pt-4"
        >
          {id && <FolderStatsSection folderId={id} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
