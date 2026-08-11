import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  FILE_ACCEPT_ATTRIBUTE,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  isSupportedFile,
} from "@/lib/file-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, Image as ImageIcon, X, FileUp, FileSpreadsheet } from "lucide-react";
import type { UploadedFile } from "@/features/upload";

interface FileUploadProps {
  files: UploadedFile[];
  onFilesChange: (files: UploadedFile[]) => void;
  className?: string;
}

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileUpload({
  files,
  onFilesChange,
  className,
}: FileUploadProps) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);

  const processFiles = useCallback(
    (fileList: FileList | File[]) => {
      const newFiles: UploadedFile[] = [];
      const rejected: string[] = [];
      const tooBig: string[] = [];

      Array.from(fileList).forEach((file) => {
        // Extension, not `File.type`: browsers leave the MIME type empty for
        // .pptx and .csv often enough that supported files were dropped here —
        // silently, since this branch just returned.
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

        // Create preview for images and pdfs and docx
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
      if (newFiles.length > 0) {
        onFilesChange([...files, ...newFiles]);
      }
    },
    [files, onFilesChange, t],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(e.dataTransfer.files);
    },
    [processFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        processFiles(e.target.files);
      }
      e.target.value = "";
    },
    [processFiles],
  );

  const removeFile = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (file?.preview) {
        URL.revokeObjectURL(file.preview);
      }
      onFilesChange(files.filter((f) => f.id !== id));
    },
    [files, onFilesChange],
  );

  const getFileIcon = (type: string) => {
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
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
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
              ? t("fileUpload.dropHere")
              : t("fileUpload.dragOrClick")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("fileUpload.supportedFormats")}
          </p>
        </div>

        <Button variant="outline" size="sm" className="relative">
          <FileUp className="size-4" />
          {t("fileUpload.chooseFile")}
          <input
            type="file"
            multiple
            accept={FILE_ACCEPT_ATTRIBUTE}
            onChange={handleFileInput}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </Button>
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">
              {t("fileUpload.selectedFiles", { count: files.length })}
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
              {t("fileUpload.removeAll")}
            </Button>
          </div>

          <div className="space-y-2">
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50"
              >
                {file.preview ? (
                  <img
                    src={file.preview}
                    alt={file.name}
                    className="size-10 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex size-10 items-center justify-center rounded-md bg-muted">
                    {getFileIcon(file.type)}
                  </div>
                )}
                <div className="flex-1 overflow-hidden">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                    </span>
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-1.5 py-0"
                    >
                      {file.type === "application/pdf"
                        ? "PDF"
                        : file.type.includes("wordprocessingml") ||
                            file.type.includes("msword")
                          ? "Word"
                          : file.type.includes("spreadsheetml") || 
                            file.type.includes("ms-excel")
                            ? "Excel"
                            : file.type === "text/csv"
                              ? "CSV"
                              : "Ảnh"}
                    </Badge>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeFile(file.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
