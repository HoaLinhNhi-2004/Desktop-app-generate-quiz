import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  X,
  Minus,
  ChevronUp,
  FolderOpen,
  Bot,
  Check,
  AlertTriangle,
  Ban,
  Loader2,
  FolderPlus,
  ScanSearch,
  Pause,
  Play,
  Square,
  Eye,
  Clock,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import type { ImportJob, ImportFileStatus } from "@/features/smart-import";

interface SmartImportWidgetProps {
  job: ImportJob | null;
  isMinimized: boolean;
  onMinimize: () => void;
  onExpand: () => void;
  onDismiss: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}

function FileStatusIcon({ status }: { status: ImportFileStatus }) {
  switch (status) {
    case "scanning":
      return <ScanSearch className="size-3.5 text-blue-400 animate-pulse" />;
    case "categorizing":
      return <Bot className="size-3.5 text-violet-400 animate-spin" />;
    case "done":
      return <Check className="size-3.5 text-emerald-400" />;
    case "review":
      return <Eye className="size-3.5 text-orange-400" />;
    case "skipped":
      return <AlertTriangle className="size-3.5 text-amber-400" />;
    case "error":
      return <Ban className="size-3.5 text-red-400" />;
    default:
      return <Loader2 className="size-3.5 text-muted-foreground animate-spin" />;
  }
}

function StatusLabel({ status }: { status: ImportFileStatus }) {
  const { t } = useTranslation();
  const labels: Record<ImportFileStatus, string> = {
    scanning: t("smartImport.statusScanning", "Scanning..."),
    categorizing: t("smartImport.statusCategorizing", "AI analyzing..."),
    done: t("smartImport.statusDone", "Imported"),
    review: t("smartImport.statusReview", "Review"),
    skipped: t("smartImport.statusSkipped", "Skipped"),
    error: t("smartImport.statusError", "Error"),
  };
  return (
    <span
      className={`text-[10px] font-medium ${
        status === "done"
          ? "text-emerald-400"
          : status === "review"
            ? "text-orange-400"
            : status === "skipped"
              ? "text-amber-400"
              : status === "error"
                ? "text-red-400"
                : "text-muted-foreground"
      }`}
    >
      {labels[status]}
    </span>
  );
}

export function SmartImportWidget({
  job,
  isMinimized,
  onMinimize,
  onExpand,
  onDismiss,
  onPause,
  onResume,
  onCancel,
}: SmartImportWidgetProps) {
  const { t } = useTranslation();

  const isRunning = job
    ? !["completed", "error", "cancelled"].includes(job.status)
    : false;

  const progress = useMemo(() => {
    if (!job || job.totalFiles === 0) return 0;
    return Math.round(
      ((job.completed + job.skipped + (job.reviewCount || 0)) /
        job.totalFiles) *
        100,
    );
  }, [job]);

  const statusText = useMemo(() => {
    if (!job) return "";
    if (job.paused) return t("smartImport.paused", "Paused");
    if (job.rateLimitInfo) return job.rateLimitInfo;
    switch (job.status) {
      case "scanning":
        return t("smartImport.scanning", "Scanning directory...");
      case "categorizing":
        return t("smartImport.categorizing", "AI categorizing files...");
      case "importing":
        return t("smartImport.importing", "Importing files...");
      case "completed":
        return t("smartImport.completed", "Import completed!");
      case "cancelled":
        return t("smartImport.cancelled", "Import cancelled");
      case "error":
        return t("smartImport.errorStatus", "Import failed");
      default:
        return "";
    }
  }, [job, t]);

  if (!job) return null;

  // ── Minimized bar ──────────────────────────────────────────────
  if (isMinimized) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="fixed bottom-4 right-4 z-50"
      >
        <button
          onClick={onExpand}
          className="flex items-center gap-2.5 rounded-xl bg-card/95 backdrop-blur-xl border border-border/50 shadow-2xl px-4 py-2.5 hover:bg-accent/50 transition-all cursor-pointer group"
        >
          <div className="relative">
            <FolderOpen className="size-4 text-primary" />
            {isRunning && !job.paused && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-blue-400 animate-pulse" />
            )}
            {job.paused && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber-400" />
            )}
          </div>
          <div className="flex flex-col items-start">
            <span className="text-xs font-medium text-foreground">
              {job.status === "completed"
                ? t("smartImport.completedShort", "Done")
                : job.status === "cancelled"
                  ? t("smartImport.cancelledShort", "Cancelled")
                  : job.paused
                    ? t("smartImport.pausedShort", "Paused")
                    : `${job.completed + job.skipped}/${job.totalFiles}`}
            </span>
            <Progress value={progress} className="w-28 h-1 mt-0.5" />
          </div>
          <ChevronUp className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
      </motion.div>
    );
  }

  // ── Expanded widget ────────────────────────────────────────────
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 40, scale: 0.95 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed bottom-4 right-4 z-50 w-[360px] rounded-2xl bg-card/95 backdrop-blur-xl border border-border/50 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30 bg-muted/20">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">
              {t("smartImport.title", "Smart Import")}
            </span>
            {isRunning && !job.paused && (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            )}
            {job.paused && (
              <Clock className="size-3 text-amber-400" />
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {/* Pause/Resume button */}
            {isRunning && onPause && onResume && (
              <button
                onClick={job.paused ? onResume : onPause}
                className="size-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
                title={job.paused ? "Resume" : "Pause"}
              >
                {job.paused ? (
                  <Play className="size-3.5 text-emerald-400" />
                ) : (
                  <Pause className="size-3.5 text-muted-foreground" />
                )}
              </button>
            )}
            {/* Cancel button */}
            {isRunning && onCancel && (
              <button
                onClick={onCancel}
                className="size-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 transition-colors"
                title="Cancel"
              >
                <Square className="size-3 text-red-400" />
              </button>
            )}
            {/* Minimize button */}
            <button
              onClick={onMinimize}
              className="size-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
            >
              <Minus className="size-3.5 text-muted-foreground" />
            </button>
            {/* Close button — only when job is finished */}
            {!isRunning && (
              <button
                onClick={onDismiss}
                className="size-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
              >
                <X className="size-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>

        {/* Progress section */}
        <div className="px-4 py-3 border-b border-border/20">
          <div className="flex items-center justify-between mb-1.5">
            <span className={`text-xs ${job.paused ? "text-amber-400" : job.rateLimitInfo ? "text-orange-400" : "text-muted-foreground"}`}>
              {statusText}
            </span>
            <span className="text-xs font-semibold text-foreground">
              {job.completed + job.skipped + (job.reviewCount || 0)}/{job.totalFiles}
            </span>
          </div>
          <Progress value={progress} className="h-1.5" />

          {/* Summary badges */}
          {(job.status === "completed" || job.status === "importing" || job.status === "cancelled") && (
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              {job.completed > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">
                  <Check className="size-2.5" />
                  {job.completed} {t("smartImport.imported", "imported")}
                </span>
              )}
              {(job.reviewCount || 0) > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400">
                  <Eye className="size-2.5" />
                  {job.reviewCount} {t("smartImport.reviewLabel", "to review")}
                </span>
              )}
              {job.skipped > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                  <AlertTriangle className="size-2.5" />
                  {job.skipped} {t("smartImport.skippedLabel", "skipped")}
                </span>
              )}
              {job.createdFolders.length > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400">
                  <FolderPlus className="size-2.5" />
                  {job.createdFolders.length} {t("smartImport.newFolders", "new")}
                </span>
              )}
            </div>
          )}

          {/* Error display */}
          {job.error && (
            <div className="mt-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
              {job.error}
            </div>
          )}
        </div>

        {/* File list */}
        <ScrollArea className="max-h-[280px]">
          <div className="px-2 py-1.5">
            {job.files.map((file, idx) => (
              <motion.div
                key={`${file.name}-${idx}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(idx * 0.02, 0.5) }}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors group"
              >
                <FileStatusIcon status={file.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">
                    {file.name}
                  </p>
                  {file.folderName && (file.status === "done" || file.status === "review") && (
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <FolderOpen className="size-2.5" />
                      {file.folderName}
                    </p>
                  )}
                  {file.reason && (file.status === "skipped" || file.status === "error" || file.status === "review") && (
                    <p className={`text-[10px] mt-0.5 truncate ${file.status === "review" ? "text-orange-400/80" : "text-amber-400/80"}`}>
                      {file.reason}
                    </p>
                  )}
                </div>
                <StatusLabel status={file.status} />
              </motion.div>
            ))}
          </div>
        </ScrollArea>

        {/* Footer */}
        {!isRunning && (
          <div className="px-4 py-2.5 border-t border-border/20 bg-muted/10">
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={onDismiss}
            >
              {t("common.close", "Close")}
            </Button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

export default SmartImportWidget;
