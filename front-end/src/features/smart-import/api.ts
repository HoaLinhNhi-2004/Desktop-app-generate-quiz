import { APP_CONFIG } from "@/config/app";
import type { ImportJob, ScanResult } from "./types";

const API_URL = APP_CONFIG.API_URL;

/**
 * POST /api/folders/smart-import/scan
 * Preview-scan a directory without importing
 */
export async function scanFolderApi(dirPath: string): Promise<ScanResult> {
  const response = await fetch(`${API_URL}/api/folders/smart-import/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dirPath }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to scan directory");
  }
  return response.json();
}

/**
 * POST /api/folders/smart-import
 * Start a smart import job (background)
 */
export async function startSmartImportApi(
  dirPath: string,
): Promise<{ jobId: string }> {
  const response = await fetch(`${API_URL}/api/folders/smart-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dirPath }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to start import");
  }
  return response.json();
}

/**
 * GET /api/folders/smart-import/<jobId>
 * Poll for import job progress
 */
export async function getImportProgressApi(
  jobId: string,
): Promise<ImportJob> {
  const response = await fetch(
    `${API_URL}/api/folders/smart-import/${encodeURIComponent(jobId)}`,
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to get import progress");
  }
  return response.json();
}

/**
 * POST /api/folders/smart-import/<jobId>/pause
 * Pause a running import job
 */
export async function pauseImportApi(jobId: string): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/folders/smart-import/${encodeURIComponent(jobId)}/pause`,
    { method: "POST" },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to pause import");
  }
}

/**
 * POST /api/folders/smart-import/<jobId>/resume
 * Resume a paused import job
 */
export async function resumeImportApi(jobId: string): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/folders/smart-import/${encodeURIComponent(jobId)}/resume`,
    { method: "POST" },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to resume import");
  }
}

/**
 * POST /api/folders/smart-import/<jobId>/cancel
 * Cancel a running import job
 */
export async function cancelImportApi(jobId: string): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/folders/smart-import/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to cancel import");
  }
}
