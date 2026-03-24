import { useState, useCallback, useEffect, useRef } from "react";
import type { Folder } from "./types";
import {
  getFoldersApi,
  createFolderApi,
  deleteFolderApi,
  updateFolderApi,
  toggleFavoriteApi,
  recordAccessApi,
} from "./api";

const PROCESSING_POLL_INTERVAL = 5000; // ms — poll interval when files are processing
const FORCE_POLL_DURATION = 30_000;    // ms — keep polling after refresh to catch background processing

export function useFolders() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const processingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const forcePollUntilRef = useRef<number>(0); // timestamp until which forced polling continues

  const loadFolders = useCallback(async () => {
    try {
      setLoading(true);
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
    const hasProcessing = folders.some((f) => (f.processingCount ?? 0) > 0);
    const isForcePolling = Date.now() < forcePollUntilRef.current;
    const shouldPoll = hasProcessing || isForcePolling;

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
  }, [folders]);


  const createFolder = useCallback(
    async (name: string, description?: string, color?: string) => {
      try {
        const newFolder = await createFolderApi(name, description, color);
        setFolders((prev) => [...prev, newFolder]);
        return newFolder;
      } catch (err) {
        console.error("Failed to create folder", err);
        throw err;
      }
    },
    [],
  );

  const deleteFolder = useCallback(async (id: string) => {
    try {
      await deleteFolderApi(id);
      setFolders((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      console.error("Failed to delete folder", err);
      throw err;
    }
  }, []);

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
        return updatedFolder;
      } catch (err) {
        console.error("Failed to update folder", err);
        throw err;
      }
    },
    [],
  );

  const toggleFavorite = useCallback(async (id: string) => {
    try {
      const updatedFolder = await toggleFavoriteApi(id);
      setFolders((prev) => prev.map((f) => (f.id === id ? updatedFolder : f)));
    } catch (err) {
      console.error("Failed to toggle favorite", err);
      throw err;
    }
  }, []);

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
