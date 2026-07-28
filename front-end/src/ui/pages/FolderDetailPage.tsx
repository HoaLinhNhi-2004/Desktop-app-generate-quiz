import { useState, useEffect } from "react";
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
  Sparkles,
  ArrowRight,
  Loader2,
  Settings2,
  ArrowLeft,
  Folder,
  Play,
  Trash2,
  History,
  BookOpen,
  FileUp,
  BarChart3,
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
  useQuizSets,
  useDeleteQuizSet,
  useQuizStreamContext,
  getQuizSetApi,
} from "@/features/quizz";
import type {
  QuizConfig,
  QuizQuestion,
  QuizRouteState,
  QuizSetSummary,
} from "@/features/quizz";
import { useFolders } from "../../features/folders";
import { useUploadRecords } from "@/features/upload";
import { FolderStatsSection } from "../components/folder-stats";
import { useFolderDetailStats } from "@/features/stats";

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

  const { job, isStarting, startQuizStream } = useQuizStreamContext();
  const isStreamRunning = job?.status === "running";

  const inputReady = reusedFileIds.length > 0;

  const handleGenerate = async () => {
    if (!inputReady) {
      toast.warning(t("folder.noMaterialSelected"), {
        description: t("folder.noMaterialSelectedDesc"),
      });
      return;
    }

    const started = await startQuizStream({
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
    });
    if (!started) return; // the provider already surfaced the error

    queryClient.invalidateQueries({ queryKey: ["quizSets", id] });
    queryClient.invalidateQueries({ queryKey: ["uploadRecords", id] });

    // Go straight to the quiz — questions stream in there.
    navigate("/quiz", {
      state: {
        config,
        folderId: id,
        quizSetId: started.quizSetId,
        sourceFiles: [],
      } satisfies QuizRouteState,
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 min-h-0 flex-col gap-4 p-6">

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
                    disabled={!inputReady || isStarting || isStreamRunning}
                    onClick={handleGenerate}
                  >
                    {isStarting || isStreamRunning ? (
                      <>
                        <Loader2 className="size-5 animate-spin" />
                        {quizAction === "import"
                          ? t("smartImportQuiz.importing", { defaultValue: "Đang trích xuất..." })
                          : t("folder.streamRunning")}
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

                  {isStreamRunning && (
                    <Button
                      variant="link"
                      size="sm"
                      className="w-full"
                      onClick={() => navigate("/quiz")}
                    >
                      {t("folder.streamRunningHint")}
                    </Button>
                  )}

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
