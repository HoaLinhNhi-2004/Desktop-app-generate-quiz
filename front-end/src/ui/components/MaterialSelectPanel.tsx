import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/config/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FileText,
  Image as ImageIcon,
  Youtube,
  AlignLeft,
  File,
  FileSpreadsheet,
  Upload,
  CheckSquare,
  Loader2,
  CheckCircle2,
  Link2,
  NotebookText,
  HardDrive,
} from "lucide-react";
import { useUploadRecords, FILE_BACKED_MODES } from "@/features/upload";
import type { UploadRecord } from "@/features/upload";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

// ─── Component ────────────────────────────────────────────────────────────────

interface MaterialSelectPanelProps {
  folderId: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}

export function MaterialSelectPanel({
  folderId,
  selectedIds,
  onSelectedIdsChange,
}: MaterialSelectPanelProps) {
  const { t } = useTranslation();
  const {
    data: records,
    isLoading,
    isError,
    refetch,
  } = useUploadRecords(folderId);
  const selectedId = selectedIds[0] ?? "";

  // Only completed (processed) records can be selected for quiz generation.
  // File-backed modes additionally need the file to still exist on disk; URL and
  // text modes carry their content in the vector store, so completion is enough.
  const usableRecords = (records ?? []).filter(
    (r) =>
      r.processingStatus === "completed" &&
      (!FILE_BACKED_MODES.includes(r.inputMode) || r.hasFile),
  );
  // Records still being processed — shown separately
  const pendingRecords = (records ?? []).filter(
    (r) =>
      r.processingStatus === "processing" || r.processingStatus === "pending",
  );

  useEffect(() => {
    if (selectedIds.length > 1) {
      onSelectedIdsChange([selectedIds[0]]);
    }
  }, [selectedIds, onSelectedIdsChange]);

  const handleSelect = (id: string) => {
    onSelectedIdsChange(id ? [id] : []);
  };

  const clearSelection = () => {
    onSelectedIdsChange([]);
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="shrink-0 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckSquare className="size-4" />
              {t("materialSelect.title")}
              {selectedIds.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {t("materialSelect.selected")}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">
              {t("materialSelect.description")}
            </CardDescription>
          </div>
          {selectedId && (
            <button
              onClick={clearSelection}
              className="text-xs font-medium text-primary hover:underline"
            >
              {t("materialSelect.deselect")}
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full">
          {isLoading ? (
            <div className="space-y-2 px-6 pb-4">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="h-12 w-full animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground px-6">
              <Upload className="size-10 opacity-30" />
              <p className="text-sm font-medium">{t("materials.loadFailed")}</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : usableRecords.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground px-6">
              <Upload className="size-10 opacity-30" />
              <p className="text-sm font-medium">{t("materialSelect.empty")}</p>
              <p className="text-xs text-muted-foreground/70 text-center">
                {t("materialSelect.emptyHint")}
              </p>
            </div>
          ) : (
            <RadioGroup
              value={selectedId}
              onValueChange={handleSelect}
              className="divide-y px-2"
            >
              {usableRecords.map((record) => {
                const isSelected = selectedId === record.id;
                return (
                  <label
                    key={record.id}
                    htmlFor={`material-${record.id}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors",
                      isSelected
                        ? "bg-primary/5 hover:bg-primary/8"
                        : "hover:bg-muted/40",
                    )}
                  >
                    <RadioGroupItem
                      value={record.id}
                      id={`material-${record.id}`}
                      className="shrink-0"
                    />
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {getFileIcon(record)}
                    </div>
                    <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {record.originalName}
                        </span>
                        {getInputModeBadge(record.inputMode)}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatDate(record.createdAt)}</span>
                        {record.fileSize > 0 && (
                          <>
                            <span>·</span>
                            <span>{formatFileSize(record.fileSize)}</span>
                          </>
                        )}
                        <span className="inline-flex items-center gap-1 text-[10px] text-green-500">
                          <CheckCircle2 className="size-3" />
                          {i18n.t("materials.ready")}
                        </span>
                      </div>
                    </div>
                  </label>
                );
              })}
              {pendingRecords.length > 0 && (
                <div className="px-4 py-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("materialSelect.processingCount", {
                      count: pendingRecords.length,
                    })}
                  </p>
                  {pendingRecords.map((record) => (
                    <div
                      key={record.id}
                      className="flex items-center gap-3 opacity-60"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                        {getFileIcon(record)}
                      </div>
                      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                        <span className="truncate text-sm">
                          {record.originalName}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] text-blue-500">
                          <Loader2 className="size-3 animate-spin" />
                          {record.processingStatus === "processing"
                            ? t("materialSelect.processingStatus")
                            : t("materialSelect.pendingStatus")}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </RadioGroup>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
