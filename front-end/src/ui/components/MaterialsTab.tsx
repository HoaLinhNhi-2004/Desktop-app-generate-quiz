import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/config/i18n";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  Upload,
  FileText,
  Image as ImageIcon,
  X,
  FileUp,
  Youtube,
  AlignLeft,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Loader2,
  File,
  FileSpreadsheet,
  RefreshCw,
  Link2,
  NotebookText,
  HardDrive,
  ExternalLink,
  Search,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  useUploadRecords,
  useDeleteUploadRecord,
  useUploadMaterials,
  useReprocessUpload,
  useUploadProcessingStream,
  FILE_BACKED_MODES,
} from "@/features/upload";
import type {
  InputMode,
  UploadRecord,
  UploadProcessingProgress,
  UploadProcessingStage,
} from "@/features/upload";
import {
  useIntegrations,
  useConnectIntegration,
  useNotionPages,
  useOpenDrivePicker,
} from "@/features/integrations";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEXT_MAX_CHARS = 100_000;

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/bmp",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "text/csv", // .csv
];

const YT_URL_RE =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

const WEB_URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Loose comparison key so "…/bai-viet/" and "…/bai-viet#top" count as the same page. */
function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getFileIcon(record: UploadRecord) {
  if (record.inputMode === "youtube")
    return <Youtube className="size-4 text-red-400" />;
  if (record.inputMode === "web")
    return <Link2 className="size-4 text-cyan-400" />;
  if (record.inputMode === "notion")
    return <NotebookText className="size-4 text-neutral-300" />;
  if (record.inputMode === "gdrive")
    return <HardDrive className="size-4 text-yellow-400" />;
  if (record.inputMode === "text")
    return <AlignLeft className="size-4 text-blue-400" />;
  const ext = record.fileType.toLowerCase();
  if (ext === "pdf") return <FileText className="size-4 text-orange-400" />;
  if (["png", "jpg", "jpeg", "webp", "bmp", "tiff"].includes(ext))
    return <ImageIcon className="size-4 text-green-400" />;
  if (["docx", "doc"].includes(ext))
    return <FileSpreadsheet className="size-4 text-blue-400" />;
  return <File className="size-4 text-muted-foreground" />;
}

function getInputModeBadge(mode: string) {
  const map: Record<
    string,
    { label: string; variant: "default" | "secondary" | "outline" }
  > = {
    files: { label: "File", variant: "secondary" },
    youtube: { label: "YouTube", variant: "default" },
    web: { label: i18n.t("materials.modeWeb"), variant: "default" },
    notion: { label: "Notion", variant: "secondary" },
    gdrive: { label: "Drive", variant: "secondary" },
    text: { label: i18n.t("materials.text"), variant: "outline" },
  };
  const m = map[mode] ?? { label: mode, variant: "outline" as const };
  return (
    <Badge variant={m.variant} className="text-[10px] px-1.5 py-0">
      {m.label}
    </Badge>
  );
}

// Coarse weights so the bar advances monotonically through the pipeline; the
// backend only reports the stage plus its own page/chunk counter.
const STAGE_WEIGHTS: Record<UploadProcessingStage, [number, number]> = {
  queued: [0, 0],
  extracting: [5, 40],
  ocr: [40, 75],
  chunking: [75, 85],
  embedding: [85, 98],
};

function progressPercent(progress: UploadProcessingProgress): number {
  const [from, to] = STAGE_WEIGHTS[progress.stage];
  if (!progress.total || progress.total <= 0) return from;
  const ratio = Math.min(1, (progress.current ?? 0) / progress.total);
  return from + (to - from) * ratio;
}

function stageLabel(progress: UploadProcessingProgress): string {
  if (progress.stage === "ocr" && progress.total) {
    return i18n.t("materials.stream.ocr", {
      current: progress.current ?? 0,
      total: progress.total,
    });
  }
  return i18n.t(`materials.stream.${progress.stage}`);
}

function getProcessingBadge(
  record: UploadRecord,
  progress?: UploadProcessingProgress,
) {
  if (
    progress &&
    (record.processingStatus === "processing" ||
      record.processingStatus === "pending")
  ) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] text-blue-500">
        <Loader2 className="size-3 animate-spin" />
        {stageLabel(progress)}
        <Progress value={progressPercent(progress)} className="h-1 w-20" />
      </span>
    );
  }

  switch (record.processingStatus) {
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-blue-500">
          <Loader2 className="size-3 animate-spin" />
          {i18n.t("materials.processing")}
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-green-500">
          <CheckCircle2 className="size-3" />
          {i18n.t("materials.ready")}
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
          <AlertCircle className="size-3" />
          {i18n.t("materials.processingError")}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {i18n.t("materials.pending", "Pending...")}
        </span>
      );
  }
}


// ─── Upload Form ──────────────────────────────────────────────────────────────

function UploadForm({ folderId }: { folderId: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<InputMode>("files");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [ytUrl, setYtUrl] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [rawText, setRawText] = useState("");
  const uploadMaterials = useUploadMaterials();
  const { data: existingRecords } = useUploadRecords(folderId);

  const [notionUrl, setNotionUrl] = useState("");
  const [notionQuery, setNotionQuery] = useState("");
  const [notionSearch, setNotionSearch] = useState("");
  const { data: integrations } = useIntegrations();
  const connectIntegration = useConnectIntegration();
  const openDrivePicker = useOpenDrivePicker();

  const reportExternalOpen = useCallback(
    async (open: () => Promise<boolean>) => {
      const opened = await open();
      if (opened) toast.info(i18n.t("settings.integrations.browserOpened"));
      else toast.error(i18n.t("settings.integrations.openFailed"));
    },
    [],
  );
  const notionStatus = integrations?.find((i) => i.provider === "notion");
  const notionConnected = !!notionStatus?.connection;
  const googleStatus = integrations?.find((i) => i.provider === "google");
  const googleConnected = !!googleStatus?.connection;
  const { data: notionPages, isFetching: notionLoading } = useNotionPages(
    notionSearch,
    mode === "notion" && notionConnected,
  );

  // Notion search is a network round-trip per keystroke otherwise.
  useEffect(() => {
    const timer = setTimeout(() => setNotionSearch(notionQuery.trim()), 400);
    return () => clearTimeout(timer);
  }, [notionQuery]);

  const [isDragging, setIsDragging] = useState(false);

  const processFiles = useCallback((fileList: FileList | File[]) => {
    const all = Array.from(fileList);
    const valid = all.filter((f) => ACCEPTED_TYPES.includes(f.type));
    const rejected = all.filter((f) => !ACCEPTED_TYPES.includes(f.type));
    if (rejected.length > 0) {
      toast.error(i18n.t("materials.unsupportedFile"), {
        description: i18n.t("materials.unsupportedFileDesc", {
          names: rejected.map((f) => f.name).join(", "),
        }),
      });
    }
    if (valid.length > 0) setPendingFiles((prev) => [...prev, ...valid]);
  }, []);

  const removeFile = (idx: number) =>
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));

  const ytValid = ytUrl === "" || YT_URL_RE.test(ytUrl);
  const ytFilled = ytUrl.trim() !== "";

  const webValid = webUrl === "" || WEB_URL_RE.test(webUrl.trim());
  const webFilled = webUrl.trim() !== "";

  const canSubmit =
    (mode === "files" && pendingFiles.length > 0) ||
    (mode === "youtube" && ytFilled && ytValid) ||
    (mode === "web" && webFilled && webValid) ||
    (mode === "notion" && notionUrl !== "") ||
    (mode === "text" &&
      rawText.trim().length > 0 &&
      rawText.length <= TEXT_MAX_CHARS);

  const handleSubmit = () => {
    if (!canSubmit) return;

    // ── Duplicate detection ──
    if (existingRecords && existingRecords.length > 0) {
      if (mode === "files") {
        const dupes = pendingFiles.filter((f) =>
          existingRecords.some(
            (r) =>
              r.inputMode === "files" &&
              r.originalName === f.name &&
              r.fileSize === f.size,
          ),
        );
        if (dupes.length > 0) {
          toast.warning(t("materials.duplicateFile"), {
            description: dupes.map((f) => f.name).join(", "),
          });
          return;
        }
      } else if (mode === "youtube") {
        const newVideoId = YT_URL_RE.exec(ytUrl)?.[1];
        if (newVideoId) {
          const existing = existingRecords.find((r) => {
            if (r.inputMode !== "youtube" || !r.sourceLabel) return false;
            const existingId = YT_URL_RE.exec(r.sourceLabel)?.[1];
            return existingId === newVideoId;
          });
          if (existing) {
            toast.warning(t("materials.duplicateYoutube"), {
              description: existing.sourceLabel,
            });
            return;
          }
        }
      } else if (mode === "web") {
        const key = normalizeUrl(webUrl);
        const existing = existingRecords.find(
          (r) => r.inputMode === "web" && normalizeUrl(r.sourceLabel) === key,
        );
        if (existing) {
          toast.warning(t("materials.duplicateWeb"), {
            description: existing.sourceLabel,
          });
          return;
        }
      } else if (mode === "notion") {
        const key = normalizeUrl(notionUrl);
        const existing = existingRecords.find(
          (r) => r.inputMode === "notion" && normalizeUrl(r.sourceLabel) === key,
        );
        if (existing) {
          toast.warning(t("materials.duplicateNotion"), {
            description: existing.originalName,
          });
          return;
        }
      } else if (mode === "text") {
        const trimmed = rawText.trim();
        const existing = existingRecords.find(
          (r) =>
            r.inputMode === "text" &&
            r.sourceLabel ===
              (trimmed.length > 200
                ? trimmed.slice(0, 200) + "\u2026"
                : trimmed),
        );
        if (existing) {
          toast.warning(t("materials.duplicateText"));
          return;
        }
      }
    }

    uploadMaterials.mutate(
      {
        folderId,
        inputType: mode,
        files: mode === "files" ? pendingFiles : undefined,
        youtubeUrl: mode === "youtube" ? ytUrl : undefined,
        sourceUrl:
          mode === "web"
            ? webUrl.trim()
            : mode === "notion"
              ? notionUrl
              : undefined,
        rawText: mode === "text" ? rawText : undefined,
      },
      {
        onSuccess: (records) => {
          toast.success(t("materials.uploadSuccess"), {
            description: t("materials.uploadSuccessDesc", {
              count: records.length,
            }),
          });
          setPendingFiles([]);
          setYtUrl("");
          setWebUrl("");
          setNotionUrl("");
          setRawText("");
        },
        onError: (err) => {
          toast.error(t("materials.uploadFailed"), {
            description: err.message,
          });
        },
      },
    );
  };

  type ModeButton = { value: InputMode; label: string; icon: React.ReactNode };

  const localModes: ModeButton[] = [
    {
      value: "files",
      label: t("materials.modeFiles"),
      icon: <Upload className="size-4" />,
    },
    {
      value: "youtube",
      label: "YouTube",
      icon: <Youtube className="size-4" />,
    },
    {
      value: "text",
      label: t("materials.modeText"),
      icon: <AlignLeft className="size-4" />,
    },
  ];

  // Providers with no OAuth app in this build are hidden rather than shown
  // permanently disabled — there is nothing the user could do about them.
  const serviceModes: ModeButton[] = [
    {
      value: "web",
      label: t("materials.modeWeb"),
      icon: <Link2 className="size-4" />,
    },
    ...(notionStatus?.configured
      ? [
          {
            value: "notion" as InputMode,
            label: "Notion",
            icon: <NotebookText className="size-4" />,
          },
        ]
      : []),
    ...(googleStatus?.configured
      ? [
          {
            value: "gdrive" as InputMode,
            label: "Drive",
            icon: <HardDrive className="size-4" />,
          },
        ]
      : []),
  ];

  const renderModeRow = (buttons: ModeButton[]) => (
    <div className="flex gap-1 rounded-lg bg-muted p-1">
      {buttons.map((m) => (
        <button
          key={m.value}
          onClick={() => setMode(m.value)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
            mode === m.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m.icon}
          {m.label}
        </button>
      ))}
    </div>
  );

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="shrink-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="size-4" />
          {t("materials.addMaterial")}
        </CardTitle>
        <CardDescription>{t("materials.addMaterialDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-4">
        {/* Mode selector */}
        <div className="space-y-1.5">
          {renderModeRow(localModes)}
          <p className="px-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("materials.modeGroupServices")}
          </p>
          {renderModeRow(serviceModes)}
        </div>

        {/* Files mode */}
        {mode === "files" && (
          <div className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                processFiles(e.dataTransfer.files);
              }}
              className={cn(
                "relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 transition-all duration-200",
                isDragging
                  ? "border-primary bg-primary/5 scale-[1.01]"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30",
              )}
            >
              <div
                className={cn(
                  "flex size-12 items-center justify-center rounded-xl transition-colors",
                  isDragging ? "bg-primary/10" : "bg-muted",
                )}
              >
                <Upload
                  className={cn(
                    "size-6 transition-colors",
                    isDragging ? "text-primary" : "text-muted-foreground",
                  )}
                />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">
                  {isDragging
                    ? t("materials.dropFilesHere")
                    : t("materials.dragOrClickFiles")}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  PDF, DOCX, PNG, JPG, WEBP, BMP
                </p>
              </div>
              <Button variant="outline" size="sm" className="relative">
                <FileUp className="size-4" />
                {t("materials.chooseFile")}
                <input
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.bmp,.xlsx,.xls,.csv"
                  onChange={(e) => {
                    if (e.target.files) processFiles(e.target.files);
                    e.target.value = "";
                  }}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </Button>
            </div>

            {pendingFiles.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("materials.filesSelected", { count: pendingFiles.length })}
                </p>
                {pendingFiles.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(f.size)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={t("a11y.labels.removeFile", { name: f.name })}
                      onClick={() => removeFile(i)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* YouTube mode */}
        {mode === "youtube" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
              <p className="font-medium">{t("materials.youtubeTitle")}</p>
              <p className="mt-0.5 text-xs opacity-80">
                {t("materials.youtubeDescription")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="yt-url-mat">{t("materials.youtubeLabel")}</Label>
              <div className="relative">
                <Youtube className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="yt-url-mat"
                  placeholder="https://www.youtube.com/watch?v=..."
                  className={cn(
                    "pl-9 pr-9",
                    ytFilled && !ytValid
                      ? "border-destructive focus-visible:ring-destructive"
                      : ytFilled && ytValid
                        ? "border-green-500 focus-visible:ring-green-500"
                        : "",
                  )}
                  value={ytUrl}
                  onChange={(e) => setYtUrl(e.target.value)}
                />
                {ytFilled && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    {ytValid ? (
                      <CheckCircle2 className="size-4 text-green-500" />
                    ) : (
                      <AlertCircle className="size-4 text-destructive" />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Web page mode */}
        {mode === "web" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-cyan-200 bg-cyan-50 p-3 text-sm text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-300">
              <p className="font-medium">{t("materials.webTitle")}</p>
              <p className="mt-0.5 text-xs opacity-80">
                {t("materials.webDescription")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="web-url-mat">{t("materials.webLabel")}</Label>
              <div className="relative">
                <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="web-url-mat"
                  placeholder="https://vi.wikipedia.org/wiki/..."
                  aria-describedby="web-url-mat-hint"
                  aria-invalid={webFilled && !webValid}
                  className={cn(
                    "pl-9 pr-9",
                    webFilled && !webValid
                      ? "border-destructive focus-visible:ring-destructive"
                      : webFilled && webValid
                        ? "border-green-500 focus-visible:ring-green-500"
                        : "",
                  )}
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                />
                {webFilled && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    {webValid ? (
                      <CheckCircle2 className="size-4 text-green-500" />
                    ) : (
                      <AlertCircle className="size-4 text-destructive" />
                    )}
                  </div>
                )}
              </div>
              <p
                id="web-url-mat-hint"
                className="text-xs text-muted-foreground"
              >
                {t("materials.webHint")}
              </p>
            </div>
          </div>
        )}

        {/* Notion mode */}
        {mode === "notion" && !notionConnected && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">{t("materials.notionTitle")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("materials.notionConnectHint")}
              </p>
            </div>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => reportExternalOpen(() => connectIntegration("notion"))}
            >
              <ExternalLink className="size-4" />
              {t("materials.notionConnect")}
            </Button>
          </div>
        )}

        {mode === "notion" && notionConnected && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="notion-search-mat">
                {t("materials.notionPickLabel")}
              </Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="notion-search-mat"
                  className="pl-9"
                  placeholder={t("materials.notionSearchPlaceholder")}
                  value={notionQuery}
                  onChange={(e) => setNotionQuery(e.target.value)}
                />
              </div>
            </div>

            {notionLoading && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t("materials.notionLoading")}
              </p>
            )}

            {!notionLoading && notionPages?.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("materials.notionEmpty")}
              </p>
            )}

            <div className="max-h-56 space-y-1 overflow-y-auto">
              {(notionPages ?? []).map((page) => (
                <button
                  key={page.id}
                  onClick={() => setNotionUrl(page.url)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    notionUrl === page.url
                      ? "border-primary bg-primary/5"
                      : "border-transparent hover:bg-muted/50",
                  )}
                >
                  <NotebookText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">{page.title}</span>
                  {notionUrl === page.url && (
                    <CheckCircle2 className="ml-auto size-4 shrink-0 text-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Google Drive mode — the picker itself creates the records */}
        {mode === "gdrive" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">{t("materials.driveTitle")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {googleConnected
                  ? t("materials.driveDescription")
                  : t("materials.driveConnectHint")}
              </p>
            </div>
            {googleConnected ? (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => reportExternalOpen(() => openDrivePicker(folderId))}
              >
                <HardDrive className="size-4" />
                {t("materials.drivePick")}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => reportExternalOpen(() => connectIntegration("google"))}
              >
                <ExternalLink className="size-4" />
                {t("materials.driveConnect")}
              </Button>
            )}
          </div>
        )}

        {/* Text mode */}
        {mode === "text" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <p className="font-medium">{t("materials.textDirectInput")}</p>
              <p className="mt-0.5 text-xs opacity-80">
                {t("materials.textInfoDescription", {
                  max: TEXT_MAX_CHARS.toLocaleString(),
                })}
              </p>
            </div>
            <textarea
              className={cn(
                "min-h-40 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:ring-2",
                rawText.length > TEXT_MAX_CHARS
                  ? "border-destructive focus:ring-destructive/30"
                  : "border-input focus:ring-ring/30",
              )}
              placeholder={t("materials.textPlaceholder")}
              aria-label={t("a11y.labels.textContent")}
              aria-invalid={rawText.length > TEXT_MAX_CHARS}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              spellCheck={false}
            />
            <div className="flex items-center justify-between text-xs">
              <span
                className={cn(
                  "font-medium tabular-nums",
                  rawText.length > TEXT_MAX_CHARS
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {rawText.length.toLocaleString()} /{" "}
                {TEXT_MAX_CHARS.toLocaleString()} {t("materials.characters")}
              </span>
            </div>
          </div>
        )}

        {/* Actions — Drive has no form to submit; its picker does the work */}
        <div
          className={cn(
            "flex items-center gap-2 pt-1",
            mode === "gdrive" && "hidden",
          )}
        >
          <Button
            className="gap-2"
            disabled={!canSubmit || uploadMaterials.isPending}
            onClick={handleSubmit}
          >
            {uploadMaterials.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("materials.uploading")}
              </>
            ) : (
              <>
                <Upload className="size-4" />
                {t("materials.upload")}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Materials List ───────────────────────────────────────────────────────────

function MaterialsList({ folderId }: { folderId: string }) {
  const { t } = useTranslation();
  const {
    data: records,
    isLoading,
    isError,
    refetch,
  } = useUploadRecords(folderId);
  const deleteRecord = useDeleteUploadRecord();
  const reprocess = useReprocessUpload();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const hasActive = !!records?.some(
    (r) =>
      r.processingStatus === "pending" || r.processingStatus === "processing",
  );
  const liveProgress = useUploadProcessingStream(folderId, hasActive);

  const handleDelete = (record: UploadRecord) => {
    setPendingId(record.id);
    deleteRecord.mutate(record.id, {
      onSuccess: () =>
        toast.success(t("materials.deleteSuccess"), {
          description: t("materials.deleteSuccessDesc", {
            name: record.originalName,
          }),
        }),
      onError: () =>
        toast.error(t("materials.deleteFailed"), {
          description: t("materials.deleteFailedDesc"),
        }),
      onSettled: () => setPendingId(null),
    });
  };

  const handleReprocess = (record: UploadRecord) => {
    setPendingId(record.id);
    reprocess.mutate(record.id, { onSettled: () => setPendingId(null) });
  };

  if (isLoading) {
    return (
      <div className="space-y-2 py-4">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="h-14 w-full animate-pulse rounded-md bg-muted"
          />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
        <Upload className="size-10 opacity-30" />
        <p className="text-sm font-medium">{t("materials.loadFailed")}</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!records || records.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
        <Upload className="size-10 opacity-30" />
        <p className="text-sm font-medium">{t("materials.noMaterials")}</p>
        <p className="text-xs text-muted-foreground/70">
          {t("materials.noMaterialsHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      <AnimatePresence>
        {records.map((record) => (
          <motion.div
            key={record.id}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-3 px-1 py-3 hover:bg-muted/40 transition-colors rounded-lg"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              {getFileIcon(record)}
            </div>
            <div className="flex flex-1 flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {record.originalName}
                </span>
                {getInputModeBadge(record.inputMode)}
              </div>
              {record.inputMode === "youtube" && record.sourceLabel && (
                <a
                  href={record.sourceLabel}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-xs text-red-400 hover:underline max-w-87.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {record.sourceLabel}
                </a>
              )}
              {record.inputMode === "web" && record.sourceLabel && (
                <a
                  href={record.sourceLabel}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-xs text-cyan-400 hover:underline max-w-87.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {record.sourceLabel}
                </a>
              )}
              {record.inputMode === "gdrive" && record.sourceLabel && (
                <a
                  href={record.sourceLabel}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-xs text-yellow-500 hover:underline max-w-87.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {record.sourceLabel}
                </a>
              )}
              {record.inputMode === "notion" && record.sourceLabel && (
                <a
                  href={record.sourceLabel}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-xs text-muted-foreground hover:underline max-w-87.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {record.sourceLabel}
                </a>
              )}
              {record.inputMode === "text" && record.sourceLabel && (
                <p className="truncate text-xs text-muted-foreground/70 italic max-w-87.5">
                  {record.sourceLabel}
                </p>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{formatDate(record.createdAt)}</span>
                {record.fileSize > 0 && (
                  <>
                    <span>·</span>
                    <span>{formatFileSize(record.fileSize)}</span>
                  </>
                )}
                {!record.hasFile &&
                  FILE_BACKED_MODES.includes(record.inputMode) && (
                    <span className="text-amber-500">
                      · {t("materials.fileNotOnServer")}
                    </span>
                  )}
                {getProcessingBadge(record, liveProgress[record.id])}
              </div>
            </div>
            {record.processingStatus === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-blue-500"
                disabled={pendingId === record.id}
                onClick={() => handleReprocess(record)}
                title={t("materials.reprocess")}
                aria-label={t("a11y.labels.reprocessMaterial", {
                  name: record.originalName,
                })}
              >
                {pendingId === record.id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
            )}
            <ConfirmDialog
              destructive
              title={t("confirm.deleteMaterial.title", {
                name: record.originalName,
              })}
              description={t("confirm.deleteMaterial.desc")}
              confirmLabel={t("common.delete")}
              pending={pendingId === record.id}
              onConfirm={() => handleDelete(record)}
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                disabled={pendingId === record.id}
                aria-label={t("a11y.labels.deleteMaterial", {
                  name: record.originalName,
                })}
              >
                {pendingId === record.id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
              </Button>
            </ConfirmDialog>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface MaterialsTabProps {
  folderId: string;
}

export function MaterialsTab({ folderId }: MaterialsTabProps) {
  const { t } = useTranslation();
  const { data: records } = useUploadRecords(folderId);

  return (
    <div className="flex gap-6 h-full min-h-0">
      {/* Left column: Upload form (always visible) */}
      <div className="w-100 shrink-0 h-full">
        <UploadForm folderId={folderId} />
      </div>

      {/* Right column: Materials list */}
      <Card className="flex flex-1 flex-col min-w-0 h-full">
        <CardHeader className="shrink-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileUp className="size-4" />
            {t("materials.uploadedMaterials")}
            {records && records.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {records.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="mt-1">
            {t("materials.chooseForQuiz")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0">
          <ScrollArea className="h-full">
            <MaterialsList folderId={folderId} />
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
