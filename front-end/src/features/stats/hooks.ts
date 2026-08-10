import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { saveAttemptApi, getFolderDetailStatsApi } from "./api";
import type { FolderDetailStats, SaveAttemptPayload } from "./types";
import { notifyError } from "@/lib/notify";

/** Save a quiz attempt result */
export function useSaveAttempt() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useMutation<unknown, Error, SaveAttemptPayload>({
    mutationFn: (payload) => saveAttemptApi(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["attempts"] });
    },
    onError: (err) => {
      notifyError(t("notifications.stats.saveFailed"), {
        description: err.message,
      });
    },
  });
}

/** Folder detail stats */
export function useFolderDetailStats(folderId: string) {
  return useQuery<FolderDetailStats, Error>({
    queryKey: ["stats", "folder", folderId],
    queryFn: () => getFolderDetailStatsApi(folderId),
    enabled: !!folderId,
    // Same reason as useQuizSets: the attempt is saved on the quiz page, so the
    // invalidation lands while this query is unmounted and the global
    // `refetchOnMount: false` would keep the stale numbers on the way back.
    refetchOnMount: true,
  });
}
