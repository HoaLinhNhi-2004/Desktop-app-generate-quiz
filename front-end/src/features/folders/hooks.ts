import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Folder } from "./types";
import {
  getFoldersApi,
  createFolderApi,
  deleteFolderApi,
  updateFolderApi,
  toggleFavoriteApi,
  recordAccessApi,
} from "./api";
import {
  notifySuccess,
  notifyError,
  notifyJobDone,
} from "@/lib/notify";

const PROCESSING_POLL_INTERVAL = 5000; // ms — poll interval when files are processing
const FORCE_POLL_DURATION = 30_000;    // ms — keep polling after refresh to catch background processing

export function useFolders() {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const processingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const forcePollUntilRef = useRef<number>(0); // timestamp until which forced polling continues
  const prevProcessingTotalRef = useRef<number>(0); // tracks processing total to detect 0 transition

  const loadFolders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getFoldersApi();
      setFolders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load folders");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch folders on mount
  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  const refreshFolders = useCallback(async () => {
    try {
      const data = await getFoldersApi();
      setFolders(data);
      // After a refresh (e.g. import completed), force polling for a period
      // so we can catch background processing that starts after a slight delay
      forcePollUntilRef.current = Date.now() + FORCE_POLL_DURATION;
    } catch (err) {
      console.error("Failed to refresh folders", err);
    }
  }, []);

  // Auto-poll when any folder has files being processed OR during forced polling window
  useEffect(() => {
    const totalProcessing = folders.reduce(
      (sum, f) => sum + (f.processingCount ?? 0),
      0,
    );
    const hasProcessing = totalProcessing > 0;
    const isForcePolling = Date.now() < forcePollUntilRef.current;
    const shouldPoll = hasProcessing || isForcePolling;

    // Detect transition from "had processing" → "all done" and notify once
    if (prevProcessingTotalRef.current > 0 && totalProcessing === 0) {
      notifyJobDone(t("notifications.folder.processingDone"), {
        description: t("notifications.folder.processingDoneDesc"),
      });
    }
    prevProcessingTotalRef.current = totalProcessing;

    if (shouldPoll && !processingPollRef.current) {
      processingPollRef.current = setInterval(async () => {
        try {
          const data = await getFoldersApi();
          setFolders(data);
          const stillProcessing = data.some((f: Folder) => (f.processingCount ?? 0) > 0);
          const stillForced = Date.now() < forcePollUntilRef.current;
          // Stop polling only if no processing AND force window expired
          if (!stillProcessing && !stillForced) {
            if (processingPollRef.current) {
              clearInterval(processingPollRef.current);
              processingPollRef.current = null;
            }
          }
        } catch {
          // ignore
        }
      }, PROCESSING_POLL_INTERVAL);
    } else if (!shouldPoll && processingPollRef.current) {
      clearInterval(processingPollRef.current);
      processingPollRef.current = null;
    }

    return () => {
      if (processingPollRef.current) {
        clearInterval(processingPollRef.current);
        processingPollRef.current = null;
      }
    };
  }, [folders, t]);


  const createFolder = useCallback(
    async (name: string, description?: string, color?: string) => {
      try {
        const newFolder = await createFolderApi(name, description, color);
        setFolders((prev) => [...prev, newFolder]);
        notifySuccess(t("notifications.folder.created"), {
          description: t("notifications.folder.createdDesc", { name: newFolder.name }),
        });
        return newFolder;
      } catch (err) {
        notifyError(t("notifications.folder.createFailed"), {
          description: err instanceof Error ? err.message : undefined,
        });
        throw err;
      }
    },
    [t],
  );

  const deleteFolder = useCallback(
    async (id: string) => {
      try {
        await deleteFolderApi(id);
        setFolders((prev) => prev.filter((f) => f.id !== id));
        notifySuccess(t("notifications.folder.deleted"));
      } catch (err) {
        notifyError(t("notifications.folder.deleteFailed"), {
          description: err instanceof Error ? err.message : undefined,
        });
        throw err;
      }
    },
    [t],
  );

  const updateFolder = useCallback(
    async (
      id: string,
      data: Partial<Pick<Folder, "name" | "description" | "color">>,
    ) => {
      try {
        const updatedFolder = await updateFolderApi(id, data);
        setFolders((prev) =>
          prev.map((f) => (f.id === id ? updatedFolder : f)),
        );
        notifySuccess(t("notifications.folder.updated"));
        return updatedFolder;
      } catch (err) {
        notifyError(t("notifications.folder.updateFailed"), {
          description: err instanceof Error ? err.message : undefined,
        });
        throw err;
      }
    },
    [t],
  );

  const toggleFavorite = useCallback(
    async (id: string) => {
      try {
        const updatedFolder = await toggleFavoriteApi(id);
        setFolders((prev) => prev.map((f) => (f.id === id ? updatedFolder : f)));
        notifySuccess(
          updatedFolder.isFavorite
            ? t("notifications.folder.favoriteAdded")
            : t("notifications.folder.favoriteRemoved"),
        );
      } catch (err) {
        notifyError(t("notifications.folder.favoriteFailed"), {
          description: err instanceof Error ? err.message : undefined,
        });
        throw err;
      }
    },
    [t],
  );

  const recordAccess = useCallback(async (id: string) => {
    try {
      const updatedFolder = await recordAccessApi(id);
      setFolders((prev) => prev.map((f) => (f.id === id ? updatedFolder : f)));
    } catch (err) {
      console.error("Failed to record access", err);
    }
  }, []);

  return {
    folders,
    loading,
    error,
    createFolder,
    deleteFolder,
    updateFolder,
    toggleFavorite,
    recordAccess,
    refreshFolders,
  };
}
