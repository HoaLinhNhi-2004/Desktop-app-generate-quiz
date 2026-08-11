// ── Types for Smart Folder Import ────────────────────────────────────────────

export type ImportFileStatus =
  | "scanning"
  | "categorizing"
  | "done"
  | "skipped"
  | "error"
  | "review";

export interface ImportFileInfo {
  /** Absolute source path — unique per file, unlike `name` */
  key: string;
  name: string;
  status: ImportFileStatus;
  folderName: string;
  reason: string;
  /** Id of the created UploadedFileRecord, empty until the file is imported */
  recordId: string;
}

export interface ImportJob {
  id: string;
  status:
    | "scanning"
    | "categorizing"
    | "importing"
    | "completed"
    | "error"
    | "cancelled";
  dirPath: string;
  totalFiles: number;
  completed: number;
  skipped: number;
  reviewCount: number;
  files: ImportFileInfo[];
  createdFolders: string[];
  error: string | null;
  /** Set when the job finished but some files fell back to directory-name filing */
  warning: string;
  startedAt: string;
  paused: boolean;
  cancelRequested: boolean;
  rateLimitInfo: string;
}

export interface ScanResult {
  dirPath: string;
  totalFiles: number;
  files: {
    name: string;
    ext: string;
    size: number;
    relDir: string;
  }[];
}
