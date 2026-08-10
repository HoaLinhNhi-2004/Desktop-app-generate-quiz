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
import { notifyJobDone, notifyJobFailed, notifyInfo, notifyError } from "@/lib/notify";

const POLL_INTERVAL = 1500;
// Backend restarts wipe in-memory job state, so a run of failed polls means the
// job is gone for good — not a blip. Give up rather than freeze the widget.
const MAX_POLL_FAILURES = 5;
type TerminalStatus = "completed" | "error" | "cancelled";

export function useSmartImport() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [job, setJob] = useState<ImportJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailuresRef = useRef(0);
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
      pollFailuresRef.current = 0;
      setIsDisconnected(false);
      pollRef.current = setInterval(async () => {
        try {
          const progress = await getImportProgressApi(jobId);
          pollFailuresRef.current = 0;
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
          pollFailuresRef.current += 1;
          if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
            stopPolling();
            setIsDisconnected(true);
            notifyJobFailed(t("notifications.smartImport.disconnected"), {
              description: t("notifications.smartImport.disconnectedDesc"),
            });
          }
        }
      }, POLL_INTERVAL);
    },
    [stopPolling, notifyTerminal, t],
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
        const message = err instanceof Error ? err.message : "Import failed";
        setError(message);
        // The dialog closes before this resolves, so a toast is the only place
        // the user can learn the import never started.
        notifyError(t("notifications.smartImport.failed"), {
          description: message,
        });
      } finally {
        setIsStarting(false);
      }
    },
    [startPolling, t],
  );

  const pauseImport = useCallback(async () => {
    if (!job) return;
    const jobId = job.id;
    setJob((prev) => (prev ? { ...prev, paused: true } : prev));
    try {
      await pauseImportApi(jobId);
      await refetchOnce(jobId);
    } catch (err) {
      setJob((prev) => (prev ? { ...prev, paused: false } : prev));
      notifyError(t("notifications.smartImport.pauseFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [job, refetchOnce, t]);

  const resumeImport = useCallback(async () => {
    if (!job) return;
    const jobId = job.id;
    setJob((prev) => (prev ? { ...prev, paused: false } : prev));
    try {
      await resumeImportApi(jobId);
      await refetchOnce(jobId);
    } catch (err) {
      setJob((prev) => (prev ? { ...prev, paused: true } : prev));
      notifyError(t("notifications.smartImport.resumeFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [job, refetchOnce, t]);

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
      setJob((prev) => (prev ? { ...prev, cancelRequested: false } : prev));
      notifyError(t("notifications.smartImport.cancelFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [job, refetchOnce, t]);

  const dismiss = useCallback(() => {
    stopPolling();
    setJob(null);
    setError(null);
    setIsDisconnected(false);
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return {
    job,
    isStarting,
    error,
    isDisconnected,
    isMinimized,
    setIsMinimized,
    startImport,
    pauseImport,
    resumeImport,
    cancelImport,
    dismiss,
  };
}
