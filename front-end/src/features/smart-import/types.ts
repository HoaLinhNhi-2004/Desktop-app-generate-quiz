// ── Types for Smart Folder Import ────────────────────────────────────────────

export type ImportFileStatus =
  | "scanning"
  | "categorizing"
  | "done"
  | "skipped"
  | "error"
  | "review";

export interface ImportFileInfo {
  name: string;
  status: ImportFileStatus;
  folderName: string;
  reason: string;
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
