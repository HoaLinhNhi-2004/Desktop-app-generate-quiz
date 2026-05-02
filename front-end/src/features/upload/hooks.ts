import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  getUploadRecordsApi,
  deleteUploadRecordApi,
  getUploadsByQuizSetApi,
  uploadMaterialsApi,
  reprocessUploadApi,
  getUploadsByIdsApi,
} from "./api";
import type { UploadMaterialsOptions } from "./api";
import type { UploadRecord } from "./types";
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

export function useUploadsByIds(ids?: string[]) {
  return useQuery<UploadRecord[]>({
    queryKey: ["uploadRecords", "byIds", ids],
    queryFn: () => getUploadsByIdsApi(ids!),
    enabled: !!ids && ids.length > 0,
  });
}
