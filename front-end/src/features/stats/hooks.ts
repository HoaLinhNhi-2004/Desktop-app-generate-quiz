import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { saveAttemptApi, getFolderDetailStatsApi } from "./api";
import type { SaveAttemptPayload } from "./types";
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
  return useQuery({
    queryKey: ["stats", "folder", folderId],
    queryFn: () => getFolderDetailStatsApi(folderId),
    enabled: !!folderId,
  });
}
