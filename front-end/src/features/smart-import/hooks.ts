import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { ImportJob } from "./types";
import {
  startSmartImportApi,
  getImportProgressApi,
  pauseImportApi,
  resumeImportApi,
  cancelImportApi,
} from "./api";
import { notifyJobDone, notifyJobFailed, notifyInfo } from "@/lib/notify";

const POLL_INTERVAL = 1500;
type TerminalStatus = "completed" | "error" | "cancelled";

export function useSmartImport() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [job, setJob] = useState<ImportJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedJobIdRef = useRef<string | null>(null); // tracks last job id we notified about

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const notifyTerminal = useCallback(
    (progress: ImportJob, status: TerminalStatus) => {
      if (notifiedJobIdRef.current === progress.id) return;
      notifiedJobIdRef.current = progress.id;
      const goHome = () => navigate("/");
      if (status === "completed") {
        notifyJobDone(t("notifications.smartImport.completed"), {
          description: t("notifications.smartImport.completedDesc", {
            imported: progress.completed,
            folders: progress.createdFolders.length,
          }),
          onClick: goHome,
        });
      } else if (status === "error") {
        notifyJobFailed(t("notifications.smartImport.failed"), {
          description: progress.error ?? undefined,
          onClick: goHome,
        });
      } else {
        notifyInfo(t("notifications.smartImport.cancelled"));
      }
    },
    [t, navigate],
  );

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
            notifyTerminal(progress, progress.status);
          }
        } catch {
          // Silently ignore polling errors
        }
      }, POLL_INTERVAL);
    },
    [stopPolling, notifyTerminal],
  );

  const startImport = useCallback(
    async (dirPath: string) => {
      setIsStarting(true);
      setError(null);
      setJob(null);
      notifiedJobIdRef.current = null;
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
