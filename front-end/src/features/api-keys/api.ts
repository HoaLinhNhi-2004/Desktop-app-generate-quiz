import { APP_CONFIG } from "@/config/app";
import type {
  KeysResponse,
  GeminiApiKey,
  KeyUsageHistory,
  PoolUsageHistory,
} from "./types";

const API_URL = APP_CONFIG.API_URL;

export async function getKeysApi(): Promise<KeysResponse> {
  const res = await fetch(`${API_URL}/api/keys/`);
  if (!res.ok) throw new Error("Failed to fetch API keys");
  return res.json();
}

export async function addKeyApi(
  key: string,
  label?: string,
): Promise<GeminiApiKey> {
  const res = await fetch(`${API_URL}/api/keys/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, label }),
  });
  if (res.status === 409) throw new Error("Key đã tồn tại");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to add key");
  }
  return res.json();
}

export async function updateKeyApi(
  id: string,
  data: { label?: string; status?: "active" | "disabled" },
): Promise<GeminiApiKey> {
  const res = await fetch(`${API_URL}/api/keys/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update key");
  return res.json();
}

export async function deleteKeyApi(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/keys/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete key");
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
