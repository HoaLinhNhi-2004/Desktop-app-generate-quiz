import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  FILE_ACCEPT_ATTRIBUTE,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  isSupportedFile,
} from "@/lib/file-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  History,
  Check,
  FileSpreadsheet,
} from "lucide-react";
import type { UploadedFile, InputMode, YouTubeInput } from "@/features/upload";
import { useUploadRecords, getUploadContentApi } from "@/features/upload";
import type { UploadRecord } from "@/features/upload";
import { toast } from "sonner";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEXT_MAX_CHARS = 20_000;

const CAPTION_LANG_OPTIONS = [
  { value: "vi", label: "Tiếng Việt" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "zh-Hans", label: "中文 (简体)" },
  { value: "zh-Hant", label: "中文 (繁體)" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
];

const YT_URL_RE =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// ─── Props ────────────────────────────────────────────────────────────────────

interface InputSourceTabsProps {
  mode: InputMode;
  files: UploadedFile[];
  youtubeInput: YouTubeInput;
  rawText: string;
  onModeChange: (mode: InputMode) => void;
  onFilesChange: (files: UploadedFile[]) => void;
  onYoutubeChange: (input: YouTubeInput) => void;
  onTextChange: (text: string) => void;
  folderId?: string;
  reusedFileIds: string[];
  onReusedFileIdsChange: (ids: string[]) => void;
  className?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidYouTubeUrl(url: string): boolean {
  return YT_URL_RE.test(url);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FileIcon({ type }: { type: string }) {
  if (type === "application/pdf") {
    return <FileText className="size-5 text-red-500" />;
  }
  if (
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    type === "application/msword"
  ) {
    return <FileText className="size-5 text-blue-500" />;
  }
  if (
    type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel" ||
    type === "text/csv"
  ) {
    return <FileSpreadsheet className="size-5 text-green-600" />;
  }
  return <ImageIcon className="size-5 text-green-500" />;
}

// ─── File Upload Tab ──────────────────────────────────────────────────────────

function ReusableFileItem({
  record,
  isSelected,
  onToggle,
}: {
  record: UploadRecord;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const ext = record.fileType.toLowerCase();
  const available = record.hasFile;
  let icon = <FileText className="size-4 text-muted-foreground" />;
  if (ext === "pdf") icon = <FileText className="size-4 text-red-500" />;
  else if (["docx", "doc"].includes(ext))
    icon = <FileText className="size-4 text-blue-500" />;
  else if (["png", "jpg", "jpeg", "webp", "bmp", "tiff"].includes(ext))
    icon = <ImageIcon className="size-4 text-green-500" />;
  else if (["xlsx", "xls", "csv"].includes(ext))
    icon = <FileSpreadsheet className="size-4 text-green-600" />;

  const sizeStr =
    record.fileSize < 1024
      ? `${record.fileSize} B`
      : record.fileSize < 1024 * 1024
        ? `${(record.fileSize / 1024).toFixed(1)} KB`
        : `${(record.fileSize / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <button
      type="button"
      onClick={available ? onToggle : undefined}
      disabled={!available}
      className={cn(
        "flex items-center gap-2.5 w-full rounded-lg border px-3 py-2 text-left transition-colors",
        !available && "opacity-50 cursor-not-allowed",
        available && isSelected
          ? "border-primary bg-primary/5"
          : "border-transparent hover:bg-muted/50",
        !available && "hover:bg-transparent",
      )}
    >
      <div
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
          available && isSelected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/30",
          !available && "opacity-40",
        )}
      >
        {available && isSelected && <Check className="size-3" />}
      </div>
      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{record.originalName}</p>
        <p className="text-[11px] text-muted-foreground">
          {sizeStr} · {new Date(record.createdAt).toLocaleDateString("vi-VN")}
          {!available && (
            <span className="ml-1 text-amber-500">
              {" "}
              · {t("inputSource.fileNotOnServer")}
            </span>
          )}
        </p>
      </div>
    </button>
  );
}

function FileUploadTab({
  files,
  onFilesChange,
  folderId,
  reusedFileIds,
  onReusedFileIdsChange,
}: {
  files: UploadedFile[];
  onFilesChange: (files: UploadedFile[]) => void;
  folderId?: string;
  reusedFileIds: string[];
  onReusedFileIdsChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);

  const processFiles = useCallback(
    (fileList: FileList | File[]) => {
      const newFiles: UploadedFile[] = [];
      const rejected: string[] = [];
      const tooBig: string[] = [];
      Array.from(fileList).forEach((file) => {
        // Extension rather than `File.type` — see FileUpload.tsx.
        if (!isSupportedFile(file.name)) {
          rejected.push(file.name);
          return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          tooBig.push(file.name);
          return;
        }
        const uploadedFile: UploadedFile = {
          id: generateId(),
          name: file.name,
          size: file.size,
          type: file.type,
          file,
        };
        if (
          file.type.startsWith("image/") ||
          file.type === "application/pdf" ||
          file.type ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          file.type === "application/msword"
        ) {
          uploadedFile.preview = URL.createObjectURL(file);
        }
        newFiles.push(uploadedFile);
      });
      if (rejected.length > 0) {
        toast.error(t("materials.unsupportedFile"), {
          description: t("materials.unsupportedFileDesc", {
            names: rejected.join(", "),
          }),
        });
      }
      if (tooBig.length > 0) {
        toast.error(t("materials.fileTooLarge", { limit: MAX_UPLOAD_MB }), {
          description: tooBig.join(", "),
        });
      }
      if (newFiles.length > 0) onFilesChange([...files, ...newFiles]);
    },
    [files, onFilesChange, t],
  );

  const removeFile = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (file?.preview) URL.revokeObjectURL(file.preview);
      onFilesChange(files.filter((f) => f.id !== id));
    },
    [files, onFilesChange],
  );

  return (
    <div className="space-y-4">
      {/* Drop Zone */}
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
          "relative flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-8 transition-all duration-200",
          isDragging
            ? "border-primary bg-primary/5 scale-[1.01]"
            : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30",
        )}
      >
        <div
          className={cn(
            "flex size-16 items-center justify-center rounded-2xl transition-colors",
            isDragging ? "bg-primary/10" : "bg-muted",
          )}
        >
          <Upload
            className={cn(
              "size-8 transition-colors",
              isDragging ? "text-primary" : "text-muted-foreground",
            )}
          />
        </div>
        <div className="text-center">
          <p className="text-base font-medium">
            {isDragging
              ? t("inputSource.dropHere")
              : t("inputSource.dragOrClick")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("inputSource.supportedFormats")}
          </p>
        </div>
        <Button variant="outline" size="sm" className="relative">
          <FileUp className="size-4" />
          {t("inputSource.chooseFile")}
          <input
            type="file"
            multiple
            accept={FILE_ACCEPT_ATTRIBUTE}
            onChange={(e) => {
              if (e.target.files) processFiles(e.target.files);
              e.target.value = "";
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </Button>
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">
              {t("inputSource.selectedFiles", { count: files.length })}
            </p>
            <Button
              variant="ghost"
              size="xs"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                files.forEach((f) => {
                  if (f.preview) URL.revokeObjectURL(f.preview);
                });
                onFilesChange([]);
              }}
            >
              {t("inputSource.removeAll")}
            </Button>
          </div>
          <div className="space-y-1.5">
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2"
              >
                <FileIcon type={file.type} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeFile(file.id)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Previously uploaded files — pick from history */}
      <PreviousUploadsSection
        folderId={folderId}
        reusedFileIds={reusedFileIds}
        onReusedFileIdsChange={onReusedFileIdsChange}
      />
    </div>
  );
}

function PreviousUploadsSection({
  folderId,
  reusedFileIds,
  onReusedFileIdsChange,
}: {
  folderId?: string;
  reusedFileIds: string[];
  onReusedFileIdsChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { data: records, isLoading } = useUploadRecords(folderId);
  const [expanded, setExpanded] = useState(false);

  // Show all file-type records; available ones can be selected, unavailable are greyed out
  const fileRecords = (records ?? []).filter((r) => r.inputMode === "files");

  if (!folderId || isLoading || fileRecords.length === 0) return null;

  const toggleFile = (id: string) => {
    if (reusedFileIds.includes(id)) {
      onReusedFileIdsChange(reusedFileIds.filter((x) => x !== id));
    } else {
      onReusedFileIdsChange([...reusedFileIds, id]);
    }
  };

  const displayRecords = expanded ? fileRecords : fileRecords.slice(0, 4);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <History className="size-3.5 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">
          {t("inputSource.previousFiles")}
        </p>
        {reusedFileIds.length > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-xs">
            {reusedFileIds.length} {t("inputSource.selected")}
          </Badge>
        )}
      </div>
      <div className="space-y-1">
        {displayRecords.map((record) => (
          <ReusableFileItem
            key={record.id}
            record={record}
            isSelected={reusedFileIds.includes(record.id)}
            onToggle={() => toggleFile(record.id)}
          />
        ))}
      </div>
      {fileRecords.length > 4 && (
        <Button
          variant="ghost"
          size="xs"
          className="w-full text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("inputSource.collapse")
            : t("inputSource.showMore", { count: fileRecords.length - 4 })}
        </Button>
      )}
      {reusedFileIds.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => onReusedFileIdsChange([])}
        >
          {t("inputSource.deselectAll")}
        </Button>
      )}
    </div>
  );
}

// ─── YouTube Tab ──────────────────────────────────────────────────────────────

function PreviousYouTubeSection({
  folderId,
  onSelect,
}: {
  folderId?: string;
  onSelect: (url: string) => void;
}) {
  const { t } = useTranslation();
  const { data: records } = useUploadRecords(folderId);
  const ytRecords = (records ?? []).filter(
    (r) => r.inputMode === "youtube" && r.sourceLabel,
  );

  if (!folderId || ytRecords.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <History className="size-3.5 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">
          {t("inputSource.previousYoutubeLinks")}
        </p>
      </div>
      <div className="space-y-1">
        {ytRecords.map((record) => (
          <button
            key={record.id}
            type="button"
            onClick={() => onSelect(record.sourceLabel)}
            className="flex items-center gap-2.5 w-full rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:bg-muted/50"
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded bg-red-500/10">
              <Youtube className="size-3.5 text-red-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-red-400">
                {record.sourceLabel}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {new Date(record.createdAt).toLocaleDateString("vi-VN")}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function YouTubeTab({
  youtubeInput,
  onYoutubeChange,
  folderId,
}: {
  youtubeInput: YouTubeInput;
  onYoutubeChange: (input: YouTubeInput) => void;
  folderId?: string;
}) {
  const { t } = useTranslation();
  const urlValid =
    youtubeInput.url === "" || isValidYouTubeUrl(youtubeInput.url);
  const urlFilled = youtubeInput.url.trim() !== "";

  return (
    <div className="space-y-5">
      {/* Info banner */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
        <p className="font-medium">{t("inputSource.youtubeTitle")}</p>
        <p className="mt-0.5 text-xs opacity-80">
          {t("inputSource.youtubeDescription")}
        </p>
      </div>

      {/* URL Input */}
      <div className="space-y-2">
        <Label htmlFor="yt-url">{t("inputSource.youtubeLabel")}</Label>
        <div className="relative">
          <Youtube className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="yt-url"
            placeholder="https://www.youtube.com/watch?v=..."
            className={cn(
              "pl-9 pr-9",
              urlFilled && !urlValid
                ? "border-destructive focus-visible:ring-destructive"
                : urlFilled && urlValid
                  ? "border-green-500 focus-visible:ring-green-500"
                  : "",
            )}
            value={youtubeInput.url}
            onChange={(e) =>
              onYoutubeChange({ ...youtubeInput, url: e.target.value })
            }
          />
          {urlFilled && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {urlValid ? (
                <CheckCircle2 className="size-4 text-green-500" />
              ) : (
                <AlertCircle className="size-4 text-destructive" />
              )}
            </div>
          )}
        </div>
        {urlFilled && !urlValid && (
          <p className="text-xs text-destructive">
            {t("inputSource.youtubeInvalid")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Hỗ trợ: youtube.com/watch?v=..., youtu.be/..., /shorts/..., /embed/...
        </p>
      </div>

      {/* Caption Language */}
      <div className="space-y-2">
        <Label htmlFor="caption-lang">
          {t("inputSource.subtitleLanguage")}
        </Label>
        <Select
          value={youtubeInput.captionLang}
          onValueChange={(val) =>
            onYoutubeChange({ ...youtubeInput, captionLang: val })
          }
        >
          <SelectTrigger id="caption-lang">
            <SelectValue placeholder={t("inputSource.subtitlePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {CAPTION_LANG_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("inputSource.subtitleNote")}
        </p>
      </div>

      {/* Previous YouTube links */}
      <PreviousYouTubeSection
        folderId={folderId}
        onSelect={(url) => onYoutubeChange({ ...youtubeInput, url })}
      />
    </div>
  );
}

// ─── Text Tab ─────────────────────────────────────────────────────────────────

function PreviousTextSection({
  folderId,
  onSelect,
}: {
  folderId?: string;
  onSelect: (text: string) => void;
}) {
  const { t } = useTranslation();
  const { data: records } = useUploadRecords(folderId);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const textRecords = (records ?? []).filter(
    (r) => r.inputMode === "text" && r.hasFile,
  );

  if (!folderId || textRecords.length === 0) return null;

  async function handleRestore(record: UploadRecord) {
    setLoadingId(record.id);
    try {
      const content = await getUploadContentApi(record.id);
      onSelect(content);
      toast.success(t("inputSource.textRestored"));
    } catch {
      toast.error(t("inputSource.textLoadError"));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <History className="size-3.5 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">
          {t("inputSource.previousTexts")}
        </p>
      </div>
      <div className="space-y-1">
        {textRecords.map((record) => (
          <button
            key={record.id}
            type="button"
            disabled={loadingId === record.id}
            onClick={() => handleRestore(record)}
            className={cn(
              "flex items-center gap-2.5 w-full rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:bg-muted/50",
              loadingId === record.id && "opacity-60",
            )}
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded bg-amber-500/10">
              <AlignLeft className="size-3.5 text-amber-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {record.sourceLabel || t("inputSource.textDirectInput")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {new Date(record.createdAt).toLocaleDateString("vi-VN")}
                {record.fileSize > 0 && ` · ${formatFileSize(record.fileSize)}`}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TextInputTab({
  rawText,
  onTextChange,
  folderId,
}: {
  rawText: string;
  onTextChange: (text: string) => void;
  folderId?: string;
}) {
  const { t } = useTranslation();
  const charCount = rawText.length;
  const isOverLimit = charCount > TEXT_MAX_CHARS;

  return (
    <div className="space-y-3">
      {/* Info */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <p className="font-medium">{t("inputSource.textDirectInput")}</p>
        <p className="mt-0.5 text-xs opacity-80">
          {t("inputSource.textDirectDescription")}
        </p>
      </div>

      {/* Textarea */}
      <div className="space-y-1.5">
        <textarea
          className={cn(
            "min-h-65 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:ring-2",
            isOverLimit
              ? "border-destructive focus:ring-destructive/30"
              : "border-input focus:ring-ring/30",
          )}
          placeholder={t("inputSource.textPlaceholder")}
          value={rawText}
          onChange={(e) => onTextChange(e.target.value)}
          spellCheck={false}
        />
        {/* Character counter */}
        <div className="flex items-center justify-between text-xs">
          <span
            className={cn(
              "font-medium tabular-nums",
              isOverLimit ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {charCount.toLocaleString()} / {TEXT_MAX_CHARS.toLocaleString()}{" "}
            {t("inputSource.characters")}
          </span>
          {isOverLimit && (
            <span className="text-destructive">
              {t("inputSource.textOverLimit", {
                count: charCount - TEXT_MAX_CHARS,
              })}
            </span>
          )}
        </div>
      </div>

      {/* Previous text entries */}
      <PreviousTextSection folderId={folderId} onSelect={onTextChange} />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function InputSourceTabs({
  mode,
  files,
  youtubeInput,
  rawText,
  onModeChange,
  onFilesChange,
  onYoutubeChange,
  onTextChange,
  folderId,
  reusedFileIds,
  onReusedFileIdsChange,
  className,
}: InputSourceTabsProps) {
  const { t } = useTranslation();
  // Summary badges for files tab
  const pdfCount = files.filter((f) => f.type === "application/pdf").length;
  const docCount = files.filter(
    (f) =>
      f.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      f.type === "application/msword",
  ).length;
  const excelCount = files.filter(
    (f) =>
      f.type ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      f.type === "application/vnd.ms-excel" ||
      f.type === "text/csv",
  ).length;
  const imgCount = files.filter((f) => f.type.startsWith("image/")).length;

  return (
    <div className={className}>
      <Tabs
        value={mode}
        onValueChange={(v) => onModeChange(v as InputMode)}
        className="flex flex-col gap-4"
      >
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="files" className="gap-1.5">
            <Upload className="size-4" />
            {t("inputSource.tabs.files")}
            {(files.length > 0 || reusedFileIds.length > 0) && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                {files.length + reusedFileIds.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="youtube" className="gap-1.5">
            <Youtube className="size-4" />
            YouTube
            {mode === "youtube" &&
              youtubeInput.url &&
              isValidYouTubeUrl(youtubeInput.url) && (
                <CheckCircle2 className="ml-1 size-3.5 text-green-500" />
              )}
          </TabsTrigger>
          <TabsTrigger value="text" className="gap-1.5">
            <AlignLeft className="size-4" />
            {t("inputSource.tabs.text")}
            {mode === "text" && rawText.trim().length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                {rawText.length > 999
                  ? `${Math.round(rawText.length / 1000)}k`
                  : rawText.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Stats bar when files mode has content */}
        {mode === "files" && files.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {pdfCount > 0 && (
              <Badge variant="outline" className="gap-1">
                <FileText className="size-3 text-red-500" />
                {pdfCount} PDF
              </Badge>
            )}
            {docCount > 0 && (
              <Badge variant="outline" className="gap-1">
                <FileText className="size-3 text-blue-500" />
                {docCount} DOCX
              </Badge>
            )}
            {excelCount > 0 && (
              <Badge variant="outline" className="gap-1">
                <FileSpreadsheet className="size-3 text-green-600" />
                {excelCount} Excel
              </Badge>
            )}
            {imgCount > 0 && (
              <Badge variant="outline" className="gap-1">
                <ImageIcon className="size-3 text-green-500" />
                {imgCount} {t("inputSource.images")}
              </Badge>
            )}
          </div>
        )}

        <TabsContent value="files" className="mt-0">
          <FileUploadTab
            files={files}
            onFilesChange={onFilesChange}
            folderId={folderId}
            reusedFileIds={reusedFileIds}
            onReusedFileIdsChange={onReusedFileIdsChange}
          />
        </TabsContent>

        <TabsContent value="youtube" className="mt-0">
          <YouTubeTab
            youtubeInput={youtubeInput}
            onYoutubeChange={onYoutubeChange}
            folderId={folderId}
          />
        </TabsContent>

        <TabsContent value="text" className="mt-0">
          <TextInputTab
            rawText={rawText}
            onTextChange={onTextChange}
            folderId={folderId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Returns true when the current input source has enough content to generate a quiz.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isInputReady(
  mode: InputMode,
  files: UploadedFile[],
  youtubeInput: YouTubeInput,
  rawText: string,
  reusedFileIds: string[] = [],
): boolean {
  if (mode === "files") return files.length > 0 || reusedFileIds.length > 0;
  if (mode === "youtube")
    return (
      youtubeInput.url.trim() !== "" && isValidYouTubeUrl(youtubeInput.url)
    );
  if (mode === "text")
    return rawText.trim().length > 0 && rawText.length <= TEXT_MAX_CHARS;
  return false;
}
