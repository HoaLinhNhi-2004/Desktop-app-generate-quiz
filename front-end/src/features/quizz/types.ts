// Quiz types

export type QuestionType =
  | "multiple-choice"
  | "multiple-answer"
  | "true-false"
  | "fill-blank"
  /** Free-text answer, no options. Import-only — generation never produces it. */
  | "short-answer"
  | "mixed";

/** Whether a question was copied out of the source document or written by the model. */
export type QuestionOrigin = "extracted" | "generated";

export type Difficulty = "easy" | "medium" | "hard" | "mixed";

export interface QuizConfig {
  numberOfQuestions: number;
  questionType: QuestionType;
  difficulty: Difficulty;
  language: "vi" | "en";
  timePerQuestion: number; // seconds, 0 = no limit
}

export interface QuizOption {
  id: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  questionNumber: number;
  questionText: string;
  type: QuestionType;
  options: QuizOption[];
  correctAnswerId: string;
  correctAnswerIds?: string[]; // multiple-answer type only
  explanation?: string;
  sourcePages?: number[];
  sourceKeyword?: string[];
  origin?: QuestionOrigin;
}

/** Ways a question can be incomplete — see `validation.ts`. */
export type QuestionIssue =
  | "empty-text"
  | "empty-option"
  | "no-correct-answer"
  | "true-false-option-count";

export interface QuizState {
  questions: QuizQuestion[];
  answers: Record<string, string>; // questionId -> selectedOptionId
  currentQuestionIndex: number;
  startTime: number;
  endTime?: number;
}

export interface QuizResult {
  totalQuestions: number;
  correctAnswers: number;
  wrongAnswers: number;
  skippedQuestions: number;
  score: number; // percentage
  timeTaken: number; // seconds
  questionResults: {
    questionId: string;
    questionText: string;
    selectedAnswerId: string | null;
    selectedAnswerIds?: string[]; // multiple-answer type only
    correctAnswerId: string;
    correctAnswerIds?: string[]; // multiple-answer type only
    isCorrect: boolean;
  }[];
}

export interface QuizSetSummary {
  id: string;
  folderId: string | null;
  title: string;
  config: QuizConfig;
  createdAt: string;
  questionCount: number;
  pageDistribution?: {
    distribution: Record<string, number>; // page number (string) → question count
    totalPages: number;
  } | null;
  sourceUploadIds?: string[];
}

export interface QuizSetDetail extends QuizSetSummary {
  questions: QuizQuestion[];
}

export type InputMode = "files" | "youtube" | "text";

export interface YouTubeInput {
  url: string;
  captionLang: string;
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
  preview?: string;
}

// ─── Streaming quiz generation ──────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface PageDistribution {
  distribution: Record<string, number>; // page number (string) → question count
  totalPages: number;
}

export type QuizStreamStage =
  | "queued"
  | "extracting"
  | "ocr"
  | "analyzing"
  | "generating"
  | "saving";

export type QuizStreamStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "disconnected";

export type QuizStreamAction = "generate" | "import";

export type QuizStreamNoticeCode =
  | "rpmWait"
  | "modelFallback"
  | "cacheHit"
  | "topUp";

export interface QuizStreamStageEvent {
  type: "stage";
  stage: QuizStreamStage;
  detail?: string;
  /** 1-based sub-progress within the stage, e.g. OCR page 3 of 12 */
  current?: number;
  total?: number;
}

export interface QuizStreamMetaEvent {
  type: "meta";
  /** Length of the whole extracted document */
  totalTextLength: number;
  /** Length of the slice actually sent to the model — smaller for long documents */
  sourceTextLength?: number;
  filesProcessed: number;
  inputType: InputMode;
  /** 0 in import mode — the document decides how many questions there are */
  numberOfQuestions: number;
  config: QuizConfig;
}

export interface QuizStreamQuestionEvent {
  type: "question";
  /** 0-based slot; the backend emits densely and in order */
  index: number;
  /** Expected total, or 0 when unknown (import mode) */
  total: number;
  question: QuizQuestion;
}

export interface QuizStreamNoticeEvent {
  type: "notice";
  code: QuizStreamNoticeCode;
  message?: string;
  retryInSeconds?: number;
  model?: string;
  from?: string;
  to?: string;
  count?: number;
  round?: number;
  deficit?: number;
}

export interface QuizStreamDoneEvent {
  type: "done";
  quizSetId: string;
  questions: QuizQuestion[];
  config: QuizConfig;
  extractedText: string;
  totalTextLength: number;
  filesProcessed: number;
  /** Names of sources that were requested but yielded no text */
  filesSkipped?: string[];
  inputType: InputMode;
  tokenUsage?: TokenUsage;
  pageDistribution?: PageDistribution | null;
}

export interface QuizStreamErrorEvent {
  type: "error";
  message: string;
  fatal: boolean;
  status?: number;
  errorId?: string;
}

export interface QuizStreamPingEvent {
  type: "ping";
}

export interface QuizStreamResyncEvent {
  type: "resync";
}

export type QuizStreamEvent =
  | QuizStreamStageEvent
  | QuizStreamMetaEvent
  | QuizStreamQuestionEvent
  | QuizStreamNoticeEvent
  | QuizStreamDoneEvent
  | QuizStreamErrorEvent
  | QuizStreamPingEvent
  | QuizStreamResyncEvent;

export interface QuizStreamJob {
  jobId: string;
  quizSetId: string;
  folderId?: string;
  config: QuizConfig;
  action: QuizStreamAction;
  status: QuizStreamStatus;
  stage: QuizStreamStage;
  stageDetail?: string;
  stageCurrent?: number;
  stageTotal?: number;
  notice: QuizStreamNoticeEvent | null;
  questions: QuizQuestion[];
  /** config.numberOfQuestions until the backend revises it */
  expectedTotal: number;
  error: string | null;
  startedAt: number;
  /** epoch ms of the first question — drives the quiz timer */
  firstQuestionAt: number | null;
}

export interface QuizSourceFile {
  id: string;
  name: string;
  type: string;
  preview?: string;
}

/** Normalized view for QuizPage: a static replay and a live stream look alike. */
export interface QuizSource {
  questions: QuizQuestion[];
  loadedCount: number;
  expectedTotal: number;
  isLive: boolean;
  isStreamComplete: boolean;
  isRehydrating: boolean;
  stage: QuizStreamStage | null;
  stageDetail: string | null;
  stageCurrent: number | null;
  stageTotal: number | null;
  notice: QuizStreamNoticeEvent | null;
  error: string | null;
  firstQuestionAt: number | null;
  quizSetId?: string;
  folderId?: string;
  config?: QuizConfig;
  sourceFiles: QuizSourceFile[];
}

/** Typed shape of the state QuizPage receives via navigate(). */
export interface QuizRouteState {
  questions?: QuizQuestion[];
  config?: QuizConfig;
  folderId?: string;
  quizSetId?: string;
  sourceFiles?: QuizSourceFile[];
}
