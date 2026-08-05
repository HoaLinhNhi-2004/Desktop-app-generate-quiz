import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getIntegrationsApi,
  disconnectIntegrationApi,
  getNotionPagesApi,
  getAuthorizeUrl,
  getDrivePickerUrl,
  openExternalPage,
} from "./api";
import type {
  IntegrationProvider,
  IntegrationStatus,
  NotionPage,
} from "./types";

export const INTEGRATIONS_QUERY_KEY = ["integrations"] as const;

export function useIntegrations() {
  return useQuery<IntegrationStatus[], Error>({
    queryKey: INTEGRATIONS_QUERY_KEY,
    queryFn: getIntegrationsApi,
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, IntegrationProvider>({
    mutationFn: disconnectIntegrationApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
    },
  });
}

/** Notion page list for the material picker; only queried once connected. */
export function useNotionPages(query: string, enabled: boolean) {
  return useQuery<NotionPage[], Error>({
    queryKey: ["notionPages", query],
    queryFn: () => getNotionPagesApi(query),
    enabled,
  });
}

/**
 * Start an OAuth flow in the system browser.
 *
 * The consent screen lives outside the app, so nothing here can await its
 * result — instead the status is refetched the next time the window regains
 * focus, which is when the user has come back from the browser.
 */
export function useConnectIntegration() {
  const queryClient = useQueryClient();

  return useCallback(
    async (provider: IntegrationProvider) => {
      const opened = await openExternalPage(getAuthorizeUrl(provider));
      if (!opened) return false;

      const onFocus = () => {
        queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
        window.removeEventListener("focus", onFocus);
      };
      window.addEventListener("focus", onFocus);
      return true;
    },
    [queryClient],
  );
}

/**
 * Open the Google Picker for a folder.
 *
 * The picker page creates the records server-side, so nothing comes back
 * through this call — the folder's material list is refetched once the user
 * returns to the app window. The existing 3s poll only runs once a record is
 * already known to be pending, which is too late to notice new ones.
 */
export function useOpenDrivePicker() {
  const queryClient = useQueryClient();

  return useCallback(
    async (folderId: string) => {
      const opened = await openExternalPage(getDrivePickerUrl(folderId));
      if (!opened) return false;

      const onFocus = () => {
        queryClient.invalidateQueries({ queryKey: ["uploadRecords", folderId] });
        window.removeEventListener("focus", onFocus);
      };
      window.addEventListener("focus", onFocus);
      return true;
    },
    [queryClient],
  );
}
