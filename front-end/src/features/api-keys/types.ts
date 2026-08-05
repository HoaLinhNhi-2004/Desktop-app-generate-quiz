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
  inputTokensToday: number;
  outputTokensToday: number;
  tokensToday: number;
  datePst: string;
  lastUsedAt: string | null;
  lastError: string;
  createdAt: string | null;
}

/** Codes the backend returns when a key is checked against Google. */
export type KeyVerificationCode =
  | "valid"
  | "quota_exceeded"
  | "empty"
  | "invalid_format"
  | "invalid_key"
  | "api_disabled"
  | "permission_denied"
  | "rejected"
  | "decrypt_failed"
  | "network_error"
  | "service_unavailable"
  | "sdk_missing";

export interface KeyVerification {
  ok: boolean;
  code: KeyVerificationCode;
  /** English fallback from the backend, shown when no localized string exists. */
  message: string;
  /** False when the verdict is "we could not check", not "Google said no". */
  reachedGoogle: boolean;
}

export interface AddKeyResult extends GeminiApiKey {
  verification?: KeyVerification;
}

export interface VerifyKeyResult extends GeminiApiKey {
  verification: KeyVerification;
}

/** Error thrown by the api-keys API layer, carrying the backend's error code. */
export class ApiKeyError extends Error {
  readonly code: string;
  readonly verification?: KeyVerification;

  constructor(message: string, code: string, verification?: KeyVerification) {
    super(message);
    this.name = "ApiKeyError";
    this.code = code;
    this.verification = verification;
  }
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
  totalRequestsToday: number;
  totalInputTokensToday: number;
  totalOutputTokensToday: number;
  totalTokensToday: number;
  datePst?: string;
  modelUsage: ModelSummary[];
}

export interface KeysResponse {
  keys: GeminiApiKey[];
  summary: KeyPoolSummary;
}
