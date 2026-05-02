import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  generateQuizApi,
  extractTextApi,
  getQuizSetsApi,
  deleteQuizSetApi,
  updateQuizSetApi,
} from "./api";
import type {
  GenerateQuizResponse,
  ExtractTextResponse,
  GenerateQuizOptions,
  ExtractTextOptions,
} from "./api";
import type { QuizConfig, QuizSetSummary, QuizSetDetail } from "./types";
import { notifyJobDone } from "@/lib/notify";

interface GenerateQuizInput {
  options: GenerateQuizOptions;
  config: QuizConfig;
}

/**
 * Hook to generate quiz from any input source (files / youtube / text)
 */
export function useGenerateQuiz() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return useMutation<GenerateQuizResponse, Error, GenerateQuizInput>({
    mutationFn: ({ options, config }) => generateQuizApi(options, config),
    onSuccess: (data, variables) => {
      const count = data.questions.length;
      const isImport = variables.options.action === "import";
      const folderId = variables.options.folderId;
      notifyJobDone(
        isImport
          ? t("notifications.quiz.imported")
          : t("notifications.quiz.generated"),
        {
          description: isImport
            ? t("notifications.quiz.importedDesc", { count })
            : t("notifications.quiz.generatedDesc", { count }),
          onClick: folderId ? () => navigate(`/folder/${folderId}`) : undefined,
        },
      );
    },
    onError: (error: Error) => {
      console.error("Quiz generation failed:", error.message);
    },
  });
}

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
 */
export function useQuizSets(folderId?: string) {
  return useQuery<QuizSetSummary[], Error>({
    queryKey: ["quizSets", folderId ?? "all"],
    queryFn: () => getQuizSetsApi(folderId),
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
      // Invalidate specific quiz query if cached
      queryClient.invalidateQueries({ queryKey: ["quizSet", data.id] });
    },
  });
}
