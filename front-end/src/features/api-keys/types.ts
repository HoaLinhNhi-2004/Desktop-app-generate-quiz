export interface ModelUsageStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestsToday?: number;
  inputTokensToday?: number;
  outputTokensToday?: number;
}

export interface ModelSummary {
  model: string;
  displayName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
  limits: {
    rpd: number;
    rpm: number;
    tpm: number;
    tier: string;
  } | null;
}

export interface GeminiApiKey {
  id: string;
  label: string;
  key: string;
  status: "active" | "cooldown" | "disabled";
  usageCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  modelUsage: Record<string, ModelUsageStats>;
  requestsToday: number;
  datePst: string;
  lastUsedAt: string | null;
  lastError: string;
  createdAt: string | null;
}

export interface DailyUsageEntry {
  datePst: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface KeyUsageHistory {
  keyId: string;
  days: number;
  startDatePst: string;
  endDatePst: string;
  entries: DailyUsageEntry[];
}

export interface PoolUsageHistory {
  days: number;
  startDatePst: string;
  endDatePst: string;
  entries: DailyUsageEntry[];
}

export interface KeyPoolSummary {
  totalKeys: number;
  activeKeys: number;
  cooldownKeys: number;
  disabledKeys: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalUsage: number;
  totalErrors: number;
  modelUsage: ModelSummary[];
}

export interface KeysResponse {
  keys: GeminiApiKey[];
  summary: KeyPoolSummary;
}
