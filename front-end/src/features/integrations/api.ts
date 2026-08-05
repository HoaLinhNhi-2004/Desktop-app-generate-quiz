import { APP_CONFIG } from "@/config/app";
import type {
  IntegrationProvider,
  IntegrationStatus,
  NotionPage,
} from "./types";

const API_URL = APP_CONFIG.API_URL;

/**
 * GET /api/integrations/
 * Per-provider configuration + connection status
 */
export async function getIntegrationsApi(): Promise<IntegrationStatus[]> {
  const response = await fetch(`${API_URL}/api/integrations/`);
  if (!response.ok) throw new Error("Failed to fetch integrations");
  const data = await response.json();
  return data.providers;
}

/** DELETE /api/integrations/<provider> */
export async function disconnectIntegrationApi(
  provider: IntegrationProvider,
): Promise<void> {
  const response = await fetch(`${API_URL}/api/integrations/${provider}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Disconnect failed (${response.status})`);
  }
}

/**
 * GET /api/integrations/notion/pages?q=
 * Pages the user shared with the integration on the consent screen
 */
export async function getNotionPagesApi(query: string): Promise<NotionPage[]> {
  const response = await fetch(
    `${API_URL}/api/integrations/notion/pages?q=${encodeURIComponent(query)}`,
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Failed to list Notion pages (${response.status})`);
  }
  const data = await response.json();
  return data.pages;
}

export function getAuthorizeUrl(provider: IntegrationProvider): string {
  return `${API_URL}/api/integrations/${provider}/authorize`;
}

/**
 * The Google Picker page. It creates the upload records itself, so the caller
 * only opens it and refetches the material list afterwards.
 */
export function getDrivePickerUrl(folderId: string): string {
  return `${API_URL}/api/integrations/google/picker?folderId=${encodeURIComponent(folderId)}`;
}

/**
 * Open a backend-served page (OAuth consent, Drive picker) outside the app.
 *
 * Electron routes it through the main process so the OS browser handles it —
 * Google refuses embedded webviews and the renderer's CSP blocks provider
 * scripts. In the browser dev setup a plain window.open is equivalent.
 */
export async function openExternalPage(url: string): Promise<boolean> {
  if (window.electron?.openExternalUrl) {
    return window.electron.openExternalUrl(url);
  }
  return window.open(url, "_blank", "noopener,noreferrer") !== null;
}
