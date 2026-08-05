import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  checkForUpdateApi,
  isUpdateCheckSupported,
  openReleasePageApi,
} from "./api";
import type { UpdateInfo } from "./types";

export const UPDATE_QUERY_KEY = ["appUpdate"] as const;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DISMISSED_STORAGE_KEY = "quizgen-dismissed-update";

function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Latest release vs. the running build.
 *
 * The main process caches successful responses for 30 min, so the interval here
 * only decides how soon a long-running window notices a release, not how often
 * GitHub is actually hit.
 */
export function useUpdateCheck() {
  return useQuery<UpdateInfo, Error>({
    queryKey: UPDATE_QUERY_KEY,
    queryFn: () => checkForUpdateApi(false),
    enabled: isUpdateCheckSupported(),
    staleTime: CHECK_INTERVAL_MS,
    refetchInterval: CHECK_INTERVAL_MS,
    retry: false,
  });
}

/** "Check now" button — bypasses the main-process cache and seeds the shared query. */
export function useManualUpdateCheck() {
  const queryClient = useQueryClient();

  return useMutation<UpdateInfo, Error, void>({
    mutationFn: () => checkForUpdateApi(true),
    onSuccess: (data) => queryClient.setQueryData(UPDATE_QUERY_KEY, data),
  });
}

/**
 * Whether the in-app notice for the pending version was already dismissed.
 *
 * Dismissal is per version, so a later release notifies again; it silences the
 * toast only — the settings card and the toolbar badge stay visible.
 */
export function useUpdateDismissal(version: string | null | undefined) {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    readDismissedVersion,
  );

  const dismiss = useCallback(() => {
    if (!version) return;
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, version);
    } catch {
      // Private mode / quota — the notice simply reappears next launch.
    }
    setDismissedVersion(version);
  }, [version]);

  return {
    isDismissed: version !== null && version !== undefined && dismissedVersion === version,
    dismiss,
  };
}

/** Opens the GitHub release page in the system browser. */
export function useOpenReleasePage() {
  return useCallback(async (url: string | null) => {
    if (!url) return false;
    return openReleasePageApi(url);
  }, []);
}
