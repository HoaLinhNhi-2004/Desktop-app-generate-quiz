import { APP_CONFIG } from "@/config/app";
import type {
  QuizConfig,
  QuizQuestion,
  UploadedFile,
  InputMode,
  YouTubeInput,
  QuizSetSummary,
  QuizSetDetail,
} from "./types";

const API_URL = APP_CONFIG.API_URL;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface GenerateQuizResponse {
  quizSetId: string;
  questions: QuizQuestion[];
  extractedText: string;
  totalTextLength: number;
  filesProcessed: number;
  config: QuizConfig;
  inputType: string;
  tokenUsage?: TokenUsage;
}

export interface ExtractTextResponse {
  text: string;
  totalLength: number;
  filesProcessed: number;
}

export interface GenerateQuizOptions {
  inputMode: InputMode;
  files?: UploadedFile[];
  youtubeInput?: YouTubeInput;
  rawText?: string;
  folderId?: string;
  reusedFileIds?: string[];
  action?: "generate" | "import";
}

function _appendConfig(formData: FormData, config: QuizConfig) {
  formData.append("numberOfQuestions", String(config.numberOfQuestions));
  formData.append("questionType", config.questionType);
  formData.append("difficulty", config.difficulty);
  formData.append("language", config.language);
  formData.append("timePerQuestion", String(config.timePerQuestion));
}

/**
 * POST /api/quiz/generate
 * Supports inputMode: 'files' | 'youtube' | 'text'
 */
export async function generateQuizApi(
  options: GenerateQuizOptions,
  config: QuizConfig,
): Promise<GenerateQuizResponse> {
  const {
    inputMode,
    files = [],
    youtubeInput,
    rawText,
    folderId,
    reusedFileIds,
    action = "generate",
  } = options;
  const formData = new FormData();

  formData.append("inputType", inputMode);
  formData.append("action", action);
  if (folderId) formData.append("folderId", folderId);
  _appendConfig(formData, config);

  if (inputMode === "files") {
    for (const uploadedFile of files) {
      formData.append("files", uploadedFile.file);
    }
    if (reusedFileIds && reusedFileIds.length > 0) {
      formData.append("reusedFileIds", JSON.stringify(reusedFileIds));
    }
  } else if (inputMode === "youtube" && youtubeInput) {
    formData.append("youtubeUrl", youtubeInput.url);
    formData.append("captionLang", youtubeInput.captionLang);
  } else if (inputMode === "text" && rawText !== undefined) {
    formData.append("rawText", rawText);
  }

  const response = await fetch(`${API_URL}/api/quiz/generate`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data.error || `Quiz generation failed (${response.status})`,
    );
  }

  return response.json();
}

export interface ExtractTextOptions {
  inputMode: InputMode;
  files?: UploadedFile[];
  youtubeInput?: YouTubeInput;
  rawText?: string;
  language?: string;
}

/**
 * POST /api/quiz/extract-text
 * Supports inputMode: 'files' | 'youtube' | 'text'
 */
export async function extractTextApi(
  options: ExtractTextOptions,
): Promise<ExtractTextResponse> {
  const {
    inputMode,
    files = [],
    youtubeInput,
    rawText,
    language = "vi",
  } = options;
  const formData = new FormData();

  formData.append("inputType", inputMode);
  formData.append("language", language);

  if (inputMode === "files") {
    for (const uploadedFile of files) {
      formData.append("files", uploadedFile.file);
    }
  } else if (inputMode === "youtube" && youtubeInput) {
    formData.append("youtubeUrl", youtubeInput.url);
    formData.append("captionLang", youtubeInput.captionLang);
  } else if (inputMode === "text" && rawText !== undefined) {
    formData.append("rawText", rawText);
  }

  const response = await fetch(`${API_URL}/api/quiz/extract-text`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data.error || `Text extraction failed (${response.status})`,
    );
  }

  return response.json();
}

/**
 * GET /api/quiz/health
 * Health check
 */
export async function healthCheckApi(): Promise<{ status: string }> {
  const response = await fetch(`${API_URL}/api/quiz/health`);
  if (!response.ok) {
    throw new Error("API is not available");
  }
  return response.json();
}

/**
 * GET /api/quiz/sets?folder_id=xxx
 * List quiz sets (optionally filtered by folder)
 */
export async function getQuizSetsApi(
  folderId?: string,
): Promise<QuizSetSummary[]> {
  const url = folderId
    ? `${API_URL}/api/quiz/sets?folder_id=${encodeURIComponent(folderId)}`
    : `${API_URL}/api/quiz/sets`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to fetch quiz history");
  return response.json();
}

/**
 * GET /api/quiz/sets/<id>
 * Get one quiz set with all questions
 */
export async function getQuizSetApi(id: string): Promise<QuizSetDetail> {
  const response = await fetch(`${API_URL}/api/quiz/sets/${id}`);
  if (!response.ok) throw new Error("Failed to fetch quiz set");
  return response.json();
}

/**
 * PUT /api/quiz/sets/<id>
 * Update a quiz set's title, config, and questions
 */
export async function updateQuizSetApi(
  id: string,
  payload: Partial<QuizSetDetail>
): Promise<QuizSetDetail> {
  const response = await fetch(`${API_URL}/api/quiz/sets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to update quiz set");
  }
  return response.json();
}

/**
 * DELETE /api/quiz/sets/<id>
 */
export async function deleteQuizSetApi(id: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/quiz/sets/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("Failed to delete quiz set");
}

export interface SourceTextPage {
  page: number;
  text: string;
  charCount: number;
}

export interface SourceTextResponse {
  pages: SourceTextPage[];
  inputType: "files" | "youtube" | "text" | "unknown";
  totalPages: number;
  youtubeUrl?: string;
}

/**
 * GET /api/quiz/sets/<id>/source-text
 * Returns the source document text split into per-page sections.
 */
export async function getQuizSetSourceTextApi(
  id: string,
): Promise<SourceTextResponse> {
  const response = await fetch(`${API_URL}/api/quiz/sets/${id}/source-text`);
  if (!response.ok) throw new Error("Failed to fetch source text");
  return response.json();
}

// ─── Heatmap blocks ─────────────────────────────────────────────────────────

export interface HeatmapBlock {
  page: number;
  bbox: [number, number, number, number]; // [x0, y0, x1, y1] in PDF points
  count: number;
  keywords: string[];
  pageWidth: number;
  pageHeight: number;
}

export interface HeatmapBlocksResponse {
  blocks: HeatmapBlock[];
  maxCount: number;
}

/**
 * GET /api/quiz/sets/<id>/heatmap-blocks
 * Returns block-level bounding boxes with heat counts for PDF overlay.
 */
export async function getHeatmapBlocksApi(
  id: string,
): Promise<HeatmapBlocksResponse> {
  const response = await fetch(`${API_URL}/api/quiz/sets/${id}/heatmap-blocks`);
  if (!response.ok) throw new Error("Failed to fetch heatmap blocks");
  return response.json();
}

// ─── YouTube timeline ───────────────────────────────────────────────────────

export interface YouTubeTimelineSegment {
  minute: number;
  label: string;
  questionCount: number;
  keywords: string[];
}

export interface YouTubeTimelineResponse {
  segments: YouTubeTimelineSegment[];
  totalDuration: number;
  youtubeUrl: string;
}

/**
 * GET /api/quiz/sets/<id>/youtube-timeline
 * Returns timeline heatmap data for YouTube-sourced quizzes.
 */
export async function getYouTubeTimelineApi(
  id: string,
): Promise<YouTubeTimelineResponse> {
  const response = await fetch(
    `${API_URL}/api/quiz/sets/${id}/youtube-timeline`,
  );
  if (!response.ok) throw new Error("Failed to fetch YouTube timeline");
  return response.json();
}
