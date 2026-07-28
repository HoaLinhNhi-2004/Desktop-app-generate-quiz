export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
  preview?: string;
}

export type InputMode = "files" | "youtube" | "text";

export interface YouTubeInput {
  url: string;
  captionLang: string;
}

/** A record of a previously uploaded file stored in the DB */
// ─── Streaming document processing ──────────────────────────────────────────

export type UploadProcessingStage =
  | "queued"
  | "extracting"
  | "ocr"
  | "chunking"
  | "embedding";

export interface UploadProcessingProgress {
  recordId: string;
  stage: UploadProcessingStage;
  current?: number;
  total?: number;
}

export interface UploadProcessingStageEvent extends UploadProcessingProgress {
  type: "stage";
}

export interface UploadProcessingDoneEvent {
  type: "done";
  recordId: string;
  chunkCount: number;
}

export interface UploadProcessingErrorEvent {
  type: "error";
  recordId: string;
  message: string;
}

export interface UploadProcessingPingEvent {
  type: "ping";
}

export interface UploadProcessingResyncEvent {
  type: "resync";
}

export type UploadProcessingEvent =
  | UploadProcessingStageEvent
  | UploadProcessingDoneEvent
  | UploadProcessingErrorEvent
  | UploadProcessingPingEvent
  | UploadProcessingResyncEvent;

export interface UploadRecord {
  id: string;
  folderId: string;
  originalName: string;
  fileSize: number;
  fileType: string;
  inputMode: InputMode;
  sourceLabel: string;
  storedPath: boolean;
  hasFile: boolean;
  quizSetId: string | null;
  createdAt: string;
  processingStatus: "pending" | "processing" | "completed" | "failed";
  processingError: string | null;
  chunkCount: number;
}
