import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  getUploadRecordsApi,
  deleteUploadRecordApi,
  getUploadsByQuizSetApi,
  uploadMaterialsApi,
  reprocessUploadApi,
  getUploadsByIdsApi,
  subscribeFolderProcessingApi,
} from "./api";
import type { UploadMaterialsOptions, UploadProcessingHandlers } from "./api";
import type { UploadRecord, UploadProcessingProgress } from "./types";
import { notifyInfo, notifyError } from "@/lib/notify";

/**
 * Hook to list upload records for a folder.
 * Auto-polls every 3s when any record is still processing.
 */
export function useUploadRecords(folderId?: string) {
  return useQuery<UploadRecord[], Error>({
    queryKey: ["uploadRecords", folderId ?? ""],
    queryFn: () => getUploadRecordsApi(folderId!),
    enabled: !!folderId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (
        data?.some(
          (r) =>
            r.processingStatus === "pending" ||
            r.processingStatus === "processing",
        )
      ) {
        return 3000;
      }
      return false;
    },
  });
}

/**
 * Hook to list upload records for a specific quiz set
 */
export function useUploadsByQuizSet(quizSetId?: string) {
  return useQuery<UploadRecord[], Error>({
    queryKey: ["uploadRecords", "quizSet", quizSetId ?? ""],
    queryFn: () => getUploadsByQuizSetApi(quizSetId!),
    enabled: !!quizSetId,
  });
}

/**
 * Hook to delete an upload record; auto-invalidates the list
 */
export function useDeleteUploadRecord() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteUploadRecordApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["uploadRecords"] });
    },
  });
}

/**
 * Hook to upload materials (files / youtube / text) independently.
 * Auto-invalidates upload records list on success.
 */
export function useUploadMaterials() {
  const queryClient = useQueryClient();
  return useMutation<UploadRecord[], Error, UploadMaterialsOptions>({
    mutationFn: uploadMaterialsApi,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["uploadRecords", variables.folderId],
      });
    },
  });
}

/**
 * Hook to re-trigger document processing for a record.
 * Auto-invalidates upload records list on success.
 */
export function useReprocessUpload() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation<UploadRecord, Error, string>({
    mutationFn: reprocessUploadApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["uploadRecords"] });
      notifyInfo(t("notifications.upload.reprocessStarted"));
    },
    onError: (err) => {
      notifyError(t("notifications.upload.reprocessFailed"), {
        description: err.message,
      });
    },
  });
}

/**
 * Live per-record processing progress for a folder.
 *
 * Decoration only: the 3 s `processingStatus` poll above stays the source of
 * truth, because job state is in-memory and a backend restart drops it. This
 * hook owns stage/percent; the poll owns status. It also fires no notification
 * — `useFolders` already announces the folder-wide completion, and one toast
 * per record would spam an 8-file upload.
 */
export function useUploadProcessingStream(
  folderId: string | undefined,
  enabled: boolean,
): Record<string, UploadProcessingProgress> {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<
    Record<string, UploadProcessingProgress>
  >({});

  // Deps are only the connection identity, so progress updates never cause a
  // re-subscribe (setProgress and queryClient are both stable).
  useEffect(() => {
    if (!folderId || !enabled) return;

    const handlers: UploadProcessingHandlers = {
      onEvent: (event) => {
        if (event.type === "stage") {
          const { recordId, stage, current, total } = event;
          setProgress((prev) => ({
            ...prev,
            [recordId]: { recordId, stage, current, total },
          }));
          return;
        }
        if (event.type === "done" || event.type === "error") {
          const { recordId } = event;
          setProgress((prev) => {
            const next = { ...prev };
            delete next[recordId];
            return next;
          });
          // Flip the row's badge now instead of waiting up to 3 s for the poll.
          queryClient.invalidateQueries({
            queryKey: ["uploadRecords", folderId],
          });
        }
      },
      onStreamError: () => setProgress({}),
    };

    return subscribeFolderProcessingApi(folderId, handlers);
  }, [folderId, enabled, queryClient]);

  return progress;
}

export function useUploadsByIds(ids?: string[]) {
  return useQuery<UploadRecord[]>({
    queryKey: ["uploadRecords", "byIds", ids],
    queryFn: () => getUploadsByIdsApi(ids!),
    enabled: !!ids && ids.length > 0,
  });
}
