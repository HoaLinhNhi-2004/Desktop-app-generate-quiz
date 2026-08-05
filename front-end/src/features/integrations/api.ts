import { APP_CONFIG } from "@/config/app";
import { IntegrationError } from "./types";
import type {
  CredentialVerification,
  IntegrationProvider,
  IntegrationStatus,
  NotionPage,
  SaveCredentialsInput,
  SaveCredentialsResult,
} from "./types";

const API_URL = APP_CONFIG.API_URL;

/** Turn a failed response into an IntegrationError carrying the backend's message.
 *
 * The backend answers every /api/ failure with JSON, but a crashed or
 * not-yet-started process still replies with HTML (or nothing), so parsing
 * defensively is what keeps a real reason on screen instead of a generic
 * "request failed".
 */
async function toIntegrationError(
  res: Response,
  fallback: string,
): Promise<IntegrationError> {
  const raw = await res.text().catch(() => "");
  try {
    const data = JSON.parse(raw) as {
      error?: string;
      code?: string;
      verification?: CredentialVerification;
    };
    return new IntegrationError(
      data.error || fallback,
      data.code || `http_${res.status}`,
      data.verification,
    );
  } catch {
    return new IntegrationError(
      raw.trim().startsWith("<") || !raw.trim()
        ? `${fallback} (HTTP ${res.status})`
        : raw.slice(0, 200),
      `http_${res.status}`,
    );
  }
}

/** Distinguish "backend unreachable" from "backend said no". */
function toNetworkError(err: unknown, fallback: string): IntegrationError {
  if (err instanceof IntegrationError) return err;
  return new IntegrationError(
    `${fallback}: ${err instanceof Error ? err.message : String(err)}`,
    "network_unreachable",
  );
}

/**
 * GET /api/integrations/
 * Per-provider setup state: credentials, connection, redirect URI
 */
export async function getIntegrationsApi(): Promise<IntegrationStatus[]> {
  const res = await fetch(`${API_URL}/api/integrations/`);
  if (!res.ok) throw await toIntegrationError(res, "Failed to fetch integrations");
  const data = await res.json();
  return data.providers;
}

/**
 * POST /api/integrations/<provider>/credentials/verify
 * Check an OAuth app with the provider without storing it.
 *
 * A rejected credential is a normal 200 carrying a failing verdict — only a
 * malformed request or an unknown provider throws.
 */
export async function verifyCredentialsApi(
  input: SaveCredentialsInput,
): Promise<CredentialVerification> {
  const { provider, ...body } = input;
  let res: Response;
  try {
    res = await fetch(
      `${API_URL}/api/integrations/${provider}/credentials/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toIntegrationError(res, "Failed to verify credentials");
  const data = await res.json();
  return data.verification;
}

/**
 * PUT /api/integrations/<provider>/credentials
 * Verify then store. Rejected credentials come back as a thrown error.
 */
export async function saveCredentialsApi(
  input: SaveCredentialsInput,
): Promise<SaveCredentialsResult> {
  const { provider, ...body } = input;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/integrations/${provider}/credentials`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toIntegrationError(res, "Failed to save credentials");
  return res.json();
}

/** DELETE /api/integrations/<provider>/credentials */
export async function deleteCredentialsApi(
  provider: IntegrationProvider,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/integrations/${provider}/credentials`, {
      method: "DELETE",
    });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toIntegrationError(res, "Failed to remove credentials");
}

/** DELETE /api/integrations/<provider> — sign the account out, keep the OAuth app */
export async function disconnectIntegrationApi(
  provider: IntegrationProvider,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/integrations/${provider}`, {
      method: "DELETE",
    });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toIntegrationError(res, "Failed to disconnect");
}

/**
 * GET /api/integrations/notion/pages?q=
 * Pages the user shared with the integration on the consent screen
 */
export async function getNotionPagesApi(query: string): Promise<NotionPage[]> {
  const res = await fetch(
    `${API_URL}/api/integrations/notion/pages?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) throw await toIntegrationError(res, "Failed to list Notion pages");
  const data = await res.json();
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
