import { APP_CONFIG } from "@/config/app";
import { ApiKeyError } from "./types";
import type {
  AddKeyResult,
  KeysResponse,
  GeminiApiKey,
  KeyUsageHistory,
  PoolUsageHistory,
  VerifyKeyResult,
} from "./types";

const API_URL = APP_CONFIG.API_URL;

/** Turn a failed response into an ApiKeyError carrying the backend's message.
 *
 * The backend answers every /api/ failure with JSON, but a crashed or
 * not-yet-started process still replies with HTML (or nothing) — parsing
 * defensively here is what keeps "Failed to add key" from being the only thing
 * the user ever sees.
 */
async function toApiKeyError(res: Response, fallback: string): Promise<ApiKeyError> {
  const raw = await res.text().catch(() => "");
  try {
    const data = JSON.parse(raw) as {
      error?: string;
      code?: string;
      verification?: AddKeyResult["verification"];
    };
    return new ApiKeyError(
      data.error || fallback,
      data.code || `http_${res.status}`,
      data.verification,
    );
  } catch {
    return new ApiKeyError(
      raw.trim().startsWith("<") || !raw.trim()
        ? `${fallback} (HTTP ${res.status})`
        : raw.slice(0, 200),
      `http_${res.status}`,
    );
  }
}

/** Distinguish "backend unreachable" from "backend said no". */
function toNetworkError(err: unknown, fallback: string): ApiKeyError {
  if (err instanceof ApiKeyError) return err;
  return new ApiKeyError(
    `${fallback}: ${err instanceof Error ? err.message : String(err)}`,
    "network_unreachable",
  );
}

export async function getKeysApi(): Promise<KeysResponse> {
  const res = await fetch(`${API_URL}/api/keys/`);
  if (!res.ok) throw new Error("Failed to fetch API keys");
  return res.json();
}

export async function addKeyApi(
  key: string,
  label?: string,
): Promise<AddKeyResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/keys/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, label }),
    });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toApiKeyError(res, "Failed to add key");
  return res.json();
}

export async function verifyKeyApi(id: string): Promise<VerifyKeyResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/keys/${id}/verify`, { method: "POST" });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toApiKeyError(res, "Failed to verify key");
  return res.json();
}

export async function updateKeyApi(
  id: string,
  data: { label?: string; status?: "active" | "disabled" },
): Promise<GeminiApiKey> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/keys/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toApiKeyError(res, "Failed to update key");
  return res.json();
}

export async function deleteKeyApi(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/keys/${id}`, { method: "DELETE" });
  } catch (err) {
    throw toNetworkError(err, "Không kết nối được backend");
  }
  if (!res.ok) throw await toApiKeyError(res, "Failed to delete key");
}

export async function getKeyUsageHistoryApi(
  keyId: string,
  days = 30,
): Promise<KeyUsageHistory> {
  const res = await fetch(
    `${API_URL}/api/keys/${keyId}/usage-history?days=${days}`,
  );
  if (!res.ok) throw new Error("Failed to fetch key usage history");
  return res.json();
}

export async function getPoolUsageHistoryApi(
  days = 30,
): Promise<PoolUsageHistory> {
  const res = await fetch(`${API_URL}/api/keys/usage-history?days=${days}`);
  if (!res.ok) throw new Error("Failed to fetch pool usage history");
  return res.json();
}
