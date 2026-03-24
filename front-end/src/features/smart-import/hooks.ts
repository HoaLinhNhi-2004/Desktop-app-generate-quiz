import { useState, useCallback, useRef, useEffect } from "react";
import type { ImportJob } from "./types";
import {
  startSmartImportApi,
  getImportProgressApi,
  pauseImportApi,
  resumeImportApi,
  cancelImportApi,
} from "./api";

const POLL_INTERVAL = 1500; // ms

export function useSmartImport() {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const progress = await getImportProgressApi(jobId);
          setJob(progress);
          if (
            progress.status === "completed" ||
            progress.status === "error" ||
            progress.status === "cancelled"
          ) {
            stopPolling();
          }
        } catch {
          // Silently ignore polling errors
        }
      }, POLL_INTERVAL);
    },
    [stopPolling],
  );

  const startImport = useCallback(
    async (dirPath: string) => {
      setIsStarting(true);
      setError(null);
      setJob(null);
      try {
        const { jobId } = await startSmartImportApi(dirPath);
        // Immediately fetch the initial state
        const initial = await getImportProgressApi(jobId);
        setJob(initial);
        startPolling(jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      } finally {
        setIsStarting(false);
      }
    },
    [startPolling],
  );

  const pauseImport = useCallback(async () => {
    if (!job) return;
    try {
      await pauseImportApi(job.id);
    } catch (err) {
      console.error("Failed to pause:", err);
    }
  }, [job]);

  const resumeImport = useCallback(async () => {
    if (!job) return;
    try {
      await resumeImportApi(job.id);
    } catch (err) {
      console.error("Failed to resume:", err);
    }
  }, [job]);

  const cancelImport = useCallback(async () => {
    if (!job) return;
    try {
      await cancelImportApi(job.id);
    } catch (err) {
      console.error("Failed to cancel:", err);
    }
  }, [job]);

  const dismiss = useCallback(() => {
    stopPolling();
    setJob(null);
    setError(null);
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return {
    job,
    isStarting,
    error,
    isMinimized,
    setIsMinimized,
    startImport,
    pauseImport,
    resumeImport,
    cancelImport,
    dismiss,
  };
}
