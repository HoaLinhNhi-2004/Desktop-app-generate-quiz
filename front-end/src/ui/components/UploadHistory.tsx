import { useTranslation } from "react-i18next";
import i18n from "@/config/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Image,
  FileSpreadsheet,
  Youtube,
  AlignLeft,
  Trash2,
  Upload,
  File,
  Link2,
  NotebookText,
  HardDrive,
} from "lucide-react";
import { useUploadRecords, useDeleteUploadRecord } from "@/features/upload";
import type { UploadRecord } from "@/features/upload";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    return <Image className="size-4 text-green-400" />;
  if (["docx", "doc"].includes(ext))
    return <FileSpreadsheet className="size-4 text-blue-400" />;
  return <File className="size-4 text-muted-foreground" />;
}

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
    text: { label: i18n.t("uploadHistory.textMode"), variant: "outline" },
  };
  const m = map[mode] ?? { label: mode, variant: "outline" as const };
  return (
    <Badge variant={m.variant} className="text-[10px] px-1.5 py-0">
      {m.label}
    </Badge>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface UploadHistoryProps {
  folderId: string;
}

export function UploadHistory({ folderId }: UploadHistoryProps) {
  const { t } = useTranslation();
  const { data: records, isLoading } = useUploadRecords(folderId);
  const deleteRecord = useDeleteUploadRecord();

  const handleDelete = (record: UploadRecord) => {
    deleteRecord.mutate(record.id, {
      onSuccess: () =>
        toast.success(t("uploadHistory.deleteSuccess"), {
          description: t("uploadHistory.deleteSuccessDesc", {
            name: record.originalName,
          }),
        }),
      onError: () =>
        toast.error(t("uploadHistory.deleteFailed"), {
          description: t("uploadHistory.deleteFailedDesc"),
        }),
    });
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="shrink-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="size-4" />
          {t("uploadHistory.title")}
        </CardTitle>
        <CardDescription>{t("uploadHistory.description")}</CardDescription>
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
          ) : !records || records.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Upload className="size-8 opacity-40" />
              <p className="text-sm">{t("uploadHistory.empty")}</p>
              <p className="text-xs text-muted-foreground/70">
                {t("uploadHistory.emptyHint")}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {records.map((record) => (
                <div
                  key={record.id}
                  className="flex items-center gap-3 px-6 py-3 hover:bg-muted/40 transition-colors"
                >
                  {/* Icon */}
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    {getFileIcon(record)}
                  </div>

                  {/* Name + meta */}
                  <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                    <span className="truncate text-sm font-medium">
                      {record.originalName}
                    </span>
                    {record.inputMode === "youtube" && record.sourceLabel && (
                      <a
                        href={record.sourceLabel}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-xs text-red-400 hover:underline max-w-[350px]"
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
                        className="truncate text-xs text-cyan-400 hover:underline max-w-[350px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {record.sourceLabel}
                      </a>
                    )}
                    {record.inputMode === "text" && record.sourceLabel && (
                      <p className="truncate text-xs text-muted-foreground/70 italic max-w-[350px]">
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
                    </div>
                  </div>

                  {/* Badge */}
                  <div className="shrink-0">
                    {getInputModeBadge(record.inputMode)}
                  </div>

                  {/* Delete */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={deleteRecord.isPending}
                    onClick={() => handleDelete(record)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
