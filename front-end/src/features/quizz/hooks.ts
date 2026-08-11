import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import {
  extractTextApi,
  getQuizSetsApi,
  getQuizSetApi,
  deleteQuizSetApi,
  updateQuizSetApi,
  startQuizStreamApi,
  subscribeQuizStreamApi,
} from "./api";
import type {
  ExtractTextResponse,
  ExtractTextOptions,
  GenerateQuizOptions,
  QuizStreamHandlers,
} from "./api";
import type {
  QuizConfig,
  QuizRouteState,
  QuizSetSummary,
  QuizSetDetail,
  QuizSource,
  QuizStreamAction,
  QuizStreamEvent,
  QuizStreamJob,
} from "./types";
import { parseQuizError } from "@/lib/quiz-error";
import { notifyInfo, notifyJobDone, notifyJobFailed } from "@/lib/notify";

/**
 * Hook to extract text preview from any input source
 */
export function useExtractText() {
  return useMutation<ExtractTextResponse, Error, ExtractTextOptions>({
    mutationFn: (opts) => extractTextApi(opts),
    onError: (error: Error) => {
      console.error("Text extraction failed:", error.message);
    },
  });
}

/**
 * Hook to list quiz sets for a folder (or all quiz sets)
 *
 * `refetchOnMount` overrides the global `false`: generation finishes after the
 * user has left the folder page, so the invalidation on `done` lands on an
 * inactive query — React Query flags it stale but never refetches it, and with
 * the global default the remounted history tab would keep serving the cached
 * list without the quiz that was just created.
 */
export function useQuizSets(folderId?: string) {
  return useQuery<QuizSetSummary[], Error>({
    queryKey: ["quizSets", folderId ?? "all"],
    queryFn: () => getQuizSetsApi(folderId),
    refetchOnMount: true,
  });
}

/**
 * Hook to delete a quiz set; auto-invalidates the list
 */
export function useDeleteQuizSet() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteQuizSetApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quizSets"] });
    },
  });
}

/**
 * Hook to update a quiz set and its questions
 */
export function useUpdateQuizSet() {
  const queryClient = useQueryClient();
  return useMutation<
    QuizSetDetail,
    Error,
    { id: string; payload: Partial<QuizSetDetail> }
  >({
    mutationFn: ({ id, payload }) => updateQuizSetApi(id, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["quizSets"] });
      queryClient.invalidateQueries({ queryKey: ["quizSet", data.id] });
    },
  });
}

// ─── Live generation ────────────────────────────────────────────────────────

export interface StartQuizStreamInput {
  options: GenerateQuizOptions;
  config: QuizConfig;
}

export interface QuizStreamContextValue {
  job: QuizStreamJob | null;
  isStarting: boolean;
  startQuizStream: (
    input: StartQuizStreamInput,
  ) => Promise<QuizStreamJob | null>;
  /** Stop listening and freeze the job as complete at whatever arrived. */
  stopQuizStream: () => void;
  /** Drop a finished job (widget dismiss / starting a new run). */
  clearQuizStream: () => void;
}

/**
 * Owns the live generation job. Mounted once via QuizStreamProvider so the job
 * survives navigating from the folder page to the quiz page.
 *
 * All state transitions happen inside EventSource callbacks rather than
 * effects — `react-hooks/set-state-in-effect` is enforced here, and the
 * callbacks are where the data arrives anyway.
 */
export function useQuizStream(): QuizStreamContextValue {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [job, setJob] = useState<QuizStreamJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const unsubRef = useRef<(() => void) | null>(null);
  const notifiedJobIdRef = useRef<string | null>(null);
  // Stable handler object: the subscription is created once per job, so nothing
  // can force a re-subscribe (which would mean a second connection).
  const handlersRef = useRef<QuizStreamHandlers>({
    onEvent: () => {},
    onStreamError: () => {},
  });

  const stopListening = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
  }, []);

  const clearQuizStream = useCallback(() => {
    stopListening();
    setJob(null);
  }, [stopListening]);

  const stopQuizStream = useCallback(() => {
    stopListening();
    setJob((prev) =>
      prev
        ? { ...prev, status: "completed", expectedTotal: prev.questions.length }
        : prev,
    );
  }, [stopListening]);

  const notifyTerminal = useCallback(
    (finished: QuizStreamJob) => {
      if (notifiedJobIdRef.current === finished.jobId) return;
      notifiedJobIdRef.current = finished.jobId;

      const count = finished.questions.length;
      const isImport = finished.action === "import";
      const goToQuiz = () => navigate("/quiz");

      if (finished.status === "completed") {
        notifyJobDone(
          isImport
            ? t("notifications.quiz.imported")
            : t("notifications.quiz.generated"),
          {
            description: isImport
              ? t("notifications.quiz.importedDesc", { count })
              : t("notifications.quiz.generatedDesc", { count }),
            onClick: goToQuiz,
          },
        );
        // Imported questions can legitimately lack a marked answer.
        if (isImport) {
          const missing = finished.questions.filter(
            (q) => !q.correctAnswerId,
          ).length;
          if (missing > 0) {
            notifyInfo(t("notifications.quiz.missingAnswers"), {
              description: t("notifications.quiz.missingAnswersDesc", {
                count: missing,
              }),
              duration: 10000,
            });
          }
        }
        return;
      }

      if (count > 0) {
        notifyJobFailed(t("notifications.quiz.streamPartial"), {
          description: t("notifications.quiz.streamPartialDesc", {
            count,
            total: finished.config.numberOfQuestions,
          }),
          onClick: goToQuiz,
        });
        return;
      }

      const parsed = parseQuizError(finished.error ?? "");
      notifyJobFailed(parsed.title, {
        description: parsed.description,
        duration: parsed.duration,
        onClick: finished.folderId
          ? () => navigate(`/folder/${finished.folderId}`)
          : undefined,
      });
    },
    [t, navigate],
  );

  const reduce = useCallback(
    (event: QuizStreamEvent) => {
      let terminal: QuizStreamJob | null = null;

      setJob((prev) => {
        if (!prev) return prev;

        switch (event.type) {
          case "ping":
          case "resync":
            return prev;
          case "stage":
            return {
              ...prev,
              status: "running",
              stage: event.stage,
              stageDetail: event.detail,
              stageCurrent: event.current,
              stageTotal: event.total,
            };
          case "meta":
            return {
              ...prev,
              status: "running",
              expectedTotal:
                event.numberOfQuestions > 0
                  ? event.numberOfQuestions
                  : prev.questions.length,
            };
          case "question": {
            const questions = [...prev.questions, event.question];
            return {
              ...prev,
              status: "running",
              questions,
              expectedTotal: Math.max(event.total, questions.length),
              firstQuestionAt: prev.firstQuestionAt ?? Date.now(),
            };
          }
          case "notice":
            return { ...prev, notice: event };
          case "done": {
            const next: QuizStreamJob = {
              ...prev,
              status: "completed",
              stage: "saving",
              notice: null,
              // Trust the persisted list: it carries the final ids and recovers
              // anything a dropped frame lost.
              questions:
                event.questions.length >= prev.questions.length
                  ? event.questions
                  : prev.questions,
              expectedTotal: Math.max(
                event.questions.length,
                prev.questions.length,
              ),
            };
            terminal = next;
            return next;
          }
          case "error": {
            if (!event.fatal) {
              return { ...prev, stageDetail: event.message };
            }
            const next: QuizStreamJob = {
              ...prev,
              status: "error",
              error: event.message,
              expectedTotal: prev.questions.length,
            };
            terminal = next;
            return next;
          }
        }
      });

      if (terminal) {
        stopListening();
        queryClient.invalidateQueries({ queryKey: ["quizSets"] });
        notifyTerminal(terminal);
      }
    },
    [stopListening, queryClient, notifyTerminal],
  );

  // Refresh the handlers in place rather than re-subscribing: the connection is
  // opened imperatively in startQuizStream and must outlive re-renders.
  useEffect(() => {
    handlersRef.current.onEvent = reduce;
    handlersRef.current.onStreamError = (message) => {
      setJob((prev) =>
        prev && prev.status === "running"
          ? { ...prev, status: "disconnected", error: message }
          : prev,
      );
    };
  }, [reduce]);

  const startQuizStream = useCallback(
    async ({
      options,
      config,
    }: StartQuizStreamInput): Promise<QuizStreamJob | null> => {
      stopListening();
      setJob(null);
      notifiedJobIdRef.current = null;
      setIsStarting(true);
      try {
        const { jobId, quizSetId } = await startQuizStreamApi(options, config);
        const action: QuizStreamAction =
          options.action === "import" ? "import" : "generate";
        const initial: QuizStreamJob = {
          jobId,
          quizSetId,
          folderId: options.folderId,
          config,
          action,
          status: "running",
          stage: "queued",
          notice: null,
          questions: [],
          // Import only knows its count up front when top-up is on; otherwise the
          // document decides and the `meta` event fills this in.
          expectedTotal:
            action === "import" && !options.topUp ? 0 : config.numberOfQuestions,
          error: null,
          startedAt: Date.now(),
          firstQuestionAt: null,
        };
        setJob(initial);
        unsubRef.current = subscribeQuizStreamApi(jobId, handlersRef.current);
        return initial;
      } catch (err) {
        const parsed = parseQuizError(err instanceof Error ? err : String(err));
        notifyJobFailed(parsed.title, {
          description: parsed.description,
          duration: parsed.duration,
        });
        return null;
      } finally {
        setIsStarting(false);
      }
    },
    [stopListening],
  );

  useEffect(() => stopListening, [stopListening]);

  return { job, isStarting, startQuizStream, stopQuizStream, clearQuizStream };
}

// ─── Quiz source (static replay | live stream | rehydrate) ──────────────────

const EMPTY_SOURCE: QuizSource = {
  questions: [],
  loadedCount: 0,
  expectedTotal: 0,
  isLive: false,
  isStreamComplete: true,
  isRehydrating: false,
  stage: null,
  stageDetail: null,
  stageCurrent: null,
  stageTotal: null,
  notice: null,
  error: null,
  firstQuestionAt: null,
  sourceFiles: [],
};

/**
 * Normalize the three ways QuizPage can receive a quiz so the page never
 * branches on them:
 *   1. static    — the full list arrived in location.state (replay from history)
 *   2. live      — a generation job is streaming into the provider
 *   3. rehydrate — only a quizSetId survived (Electron's F5 wipes the provider)
 */
export function useQuizSource(job: QuizStreamJob | null): QuizSource {
  const location = useLocation();
  const routeState = location.state as QuizRouteState | null;

  const staticQuestions = routeState?.questions;
  const hasStatic = !!staticQuestions && staticQuestions.length > 0;
  const rehydrateId = !hasStatic && !job ? routeState?.quizSetId : undefined;

  const { data: rehydrated, isLoading: isRehydrating } = useQuery<
    QuizSetDetail,
    Error
  >({
    queryKey: ["quizSet", rehydrateId ?? ""],
    queryFn: () => getQuizSetApi(rehydrateId!),
    enabled: !!rehydrateId,
    retry: false,
  });

  return useMemo<QuizSource>(() => {
    if (hasStatic && staticQuestions) {
      return {
        ...EMPTY_SOURCE,
        questions: staticQuestions,
        loadedCount: staticQuestions.length,
        expectedTotal: staticQuestions.length,
        quizSetId: routeState?.quizSetId,
        folderId: routeState?.folderId,
        config: routeState?.config,
        sourceFiles: routeState?.sourceFiles ?? [],
      };
    }

    if (job) {
      // Generation stops accepting questions at the configured count and saves
      // them under the ids already streamed, so the list is final the moment it
      // is full. The backend still needs a few seconds to merge and persist —
      // blocking the quiz on that leaves the user staring at "generating 5/5".
      // Import has no target count, so it stays gated on the job's own status.
      const targetMet =
        job.action === "generate" &&
        job.expectedTotal > 0 &&
        job.questions.length >= job.expectedTotal;

      return {
        questions: job.questions,
        loadedCount: job.questions.length,
        expectedTotal: Math.max(job.expectedTotal, job.questions.length),
        isLive: true,
        isStreamComplete:
          targetMet ||
          job.status === "completed" ||
          job.status === "disconnected" ||
          (job.status === "error" && job.questions.length > 0),
        isRehydrating: false,
        stage: job.stage,
        stageDetail: job.stageDetail ?? null,
        stageCurrent: job.stageCurrent ?? null,
        stageTotal: job.stageTotal ?? null,
        notice: job.notice,
        error: job.error,
        firstQuestionAt: job.firstQuestionAt,
        quizSetId: job.quizSetId,
        folderId: job.folderId,
        config: job.config,
        sourceFiles: [],
      };
    }

    if (rehydrated) {
      return {
        ...EMPTY_SOURCE,
        questions: rehydrated.questions,
        loadedCount: rehydrated.questions.length,
        expectedTotal: rehydrated.questions.length,
        quizSetId: rehydrated.id,
        folderId: rehydrated.folderId ?? undefined,
        config: rehydrated.config,
      };
    }

    if (rehydrateId) {
      return { ...EMPTY_SOURCE, isRehydrating, quizSetId: rehydrateId };
    }

    return EMPTY_SOURCE;
  }, [
    hasStatic,
    staticQuestions,
    job,
    rehydrated,
    rehydrateId,
    isRehydrating,
    routeState,
  ]);
}

// ─── In-progress answers, kept across navigation ────────────────────────────

export interface QuizDraft {
  answers: Record<string, string>;
  currentIndex: number;
}

// Module-level: leaving /quiz to check the source document while the rest of the
// quiz is still generating must not discard what has been answered so far.
const quizDrafts = new Map<string, QuizDraft>();

// The in-memory map dies on reload, and in Electron Ctrl+R is one keystroke
// away — so mirror it to localStorage as well.
const DRAFT_STORAGE_PREFIX = "quiz-draft:";

function draftStorageKey(quizSetId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${quizSetId}`;
}

function readStoredDraft(quizSetId: string): QuizDraft | undefined {
  try {
    const raw = localStorage.getItem(draftStorageKey(quizSetId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as QuizDraft;
    if (!parsed || typeof parsed !== "object" || !parsed.answers)
      return undefined;
    return { answers: parsed.answers, currentIndex: parsed.currentIndex ?? 0 };
  } catch {
    return undefined;
  }
}

export function useQuizDraft(quizSetId: string | undefined) {
  const [initialDraft] = useState<QuizDraft>(
    () =>
      (quizSetId
        ? (quizDrafts.get(quizSetId) ?? readStoredDraft(quizSetId))
        : undefined) ?? {
        answers: {},
        currentIndex: 0,
      },
  );

  const saveDraft = useCallback(
    (draft: QuizDraft) => {
      if (!quizSetId) return;
      quizDrafts.set(quizSetId, draft);
      try {
        localStorage.setItem(draftStorageKey(quizSetId), JSON.stringify(draft));
      } catch {
        // Quota or private mode — the in-memory copy still covers navigation.
      }
    },
    [quizSetId],
  );

  const clearDraft = useCallback(() => {
    if (!quizSetId) return;
    quizDrafts.delete(quizSetId);
    try {
      localStorage.removeItem(draftStorageKey(quizSetId));
    } catch {
      // Nothing to recover from — the draft is already gone in memory.
    }
  }, [quizSetId]);

  return { initialDraft, saveDraft, clearDraft };
}
