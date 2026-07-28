import { APP_CONFIG } from "@/config/app";
import { openEventStream } from "@/lib/sse";
import type { UploadRecord, UploadProcessingEvent } from "./types";

const API_URL = APP_CONFIG.API_URL;

/**
 * GET /api/uploads?folder_id=<id>
 * List all upload records for a folder
 */
export async function getUploadRecordsApi(
  folderId: string,
): Promise<UploadRecord[]> {
  const response = await fetch(
    `${API_URL}/api/uploads/?folder_id=${encodeURIComponent(folderId)}`,
  );
  if (!response.ok) throw new Error("Failed to fetch upload records");
  return response.json();
}

/**
 * GET /api/uploads?quiz_set_id=<id>
 * List upload records associated with a specific quiz set
 */
export async function getUploadsByQuizSetApi(
  quizSetId: string,
): Promise<UploadRecord[]> {
  const response = await fetch(
    `${API_URL}/api/uploads/?quiz_set_id=${encodeURIComponent(quizSetId)}`,
  );
  if (!response.ok)
    throw new Error("Failed to fetch upload records for quiz set");
  return response.json();
}

/**
 * Returns the URL to stream a stored file (PDF, image, etc.)
 */
export function getUploadFileUrl(recordId: string): string {
  return `${API_URL}/api/uploads/${encodeURIComponent(recordId)}/file`;
}

/**
 * GET /api/uploads?ids=<comma-separated>
 * Fetch upload records by a list of IDs
 */
export async function getUploadsByIdsApi(
  ids: string[],
): Promise<UploadRecord[]> {
  if (ids.length === 0) return [];
  const response = await fetch(
    `${API_URL}/api/uploads/?ids=${ids.map(encodeURIComponent).join(",")}`,
  );
  if (!response.ok) throw new Error("Failed to fetch upload records by IDs");
  return response.json();
}

/**
 * DELETE /api/uploads/<id>
 * Delete a single upload record
 */
export async function deleteUploadRecordApi(id: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/uploads/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("Failed to delete upload record");
}

/**
 * POST /api/uploads/<id>/reprocess
 * Re-trigger document processing for a record
 */
export async function reprocessUploadApi(id: string): Promise<UploadRecord> {
  const response = await fetch(`${API_URL}/api/uploads/${id}/reprocess`, {
    method: "POST",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to reprocess");
  }
  return response.json();
}

/**
 * GET /api/uploads/<id>/content
 * Retrieve stored text content for a text-mode upload record
 */
export async function getUploadContentApi(id: string): Promise<string> {
  const response = await fetch(`${API_URL}/api/uploads/${id}/content`);
  if (!response.ok) throw new Error("Failed to fetch stored text content");
  const data = await response.json();
  return data.content;
}

export interface UploadMaterialsOptions {
  folderId: string;
  inputType: "files" | "youtube" | "text";
  files?: File[];
  youtubeUrl?: string;
  rawText?: string;
}

/**
 * POST /api/uploads/upload
 * Upload materials (files / YouTube / text) independently
 */
export async function uploadMaterialsApi(
  options: UploadMaterialsOptions,
): Promise<UploadRecord[]> {
  const formData = new FormData();
  formData.append("folderId", options.folderId);
  formData.append("inputType", options.inputType);

  if (options.inputType === "files" && options.files) {
    for (const file of options.files) {
      formData.append("files", file);
    }
  } else if (options.inputType === "youtube" && options.youtubeUrl) {
    formData.append("youtubeUrl", options.youtubeUrl);
  } else if (options.inputType === "text" && options.rawText) {
    formData.append("rawText", options.rawText);
  }

  const response = await fetch(`${API_URL}/api/uploads/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed (${response.status})`);
  }

  const data = await response.json();
  return data.records;
}

export interface UploadProcessingHandlers {
  onEvent: (event: UploadProcessingEvent) => void;
  onStreamError: (message: string) => void;
}

/**
 * GET /api/uploads/stream/<folderId> — live processing progress for every
 * record in the folder, multiplexed onto one connection.
 *
 * One stream per folder rather than per record: browsers allow only ~6
 * concurrent connections per origin, and per-record streams would starve the
 * polling that backs this up.
 *
 * Returns an unsubscribe function.
 */
export function subscribeFolderProcessingApi(
  folderId: string,
  handlers: UploadProcessingHandlers,
  cursor?: number,
): () => void {
  const params = cursor ? `?from=${cursor}` : "";
  const url = `${API_URL}/api/uploads/stream/${encodeURIComponent(folderId)}${params}`;

  const stream = openEventStream<UploadProcessingEvent>(url, {
    onMessage: handlers.onEvent,
    onGiveUp: handlers.onStreamError,
  });

  return stream.close;
}
