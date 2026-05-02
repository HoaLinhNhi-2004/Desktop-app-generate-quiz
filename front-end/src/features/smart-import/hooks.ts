import { useState, useCallback, useRef, useEffect } from "react";
import type { ImportJob } from "./types";
import {
  startSmartImportApi,
  getImportProgressApi,
  pauseImportApi,
  resumeImportApi,
  cancelImportApi,
} from "./api";

const POLL_INTERVAL = 1500;

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

  const refetchOnce = useCallback(async (jobId: string) => {
    try {
      const fresh = await getImportProgressApi(jobId);
      setJob(fresh);
    } catch {
      // ignore
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
    const jobId = job.id;
    setJob((prev) => (prev ? { ...prev, paused: true } : prev));
    try {
      await pauseImportApi(jobId);
      await refetchOnce(jobId);
    } catch (err) {
      console.error("Failed to pause:", err);
      setJob((prev) => (prev ? { ...prev, paused: false } : prev));
    }
  }, [job, refetchOnce]);

  const resumeImport = useCallback(async () => {
    if (!job) return;
    const jobId = job.id;
    setJob((prev) => (prev ? { ...prev, paused: false } : prev));
    try {
      await resumeImportApi(jobId);
      await refetchOnce(jobId);
    } catch (err) {
      console.error("Failed to resume:", err);
      setJob((prev) => (prev ? { ...prev, paused: true } : prev));
    }
  }, [job, refetchOnce]);

  const cancelImport = useCallback(async () => {
    if (!job) return;
    const jobId = job.id;
    setJob((prev) =>
      prev ? { ...prev, cancelRequested: true, paused: false } : prev,
    );
    try {
      await cancelImportApi(jobId);
      await refetchOnce(jobId);
    } catch (err) {
      console.error("Failed to cancel:", err);
    }
  }, [job, refetchOnce]);

  const dismiss = useCallback(() => {
    stopPolling();
    setJob(null);
    setError(null);
  }, [stopPolling]);

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
