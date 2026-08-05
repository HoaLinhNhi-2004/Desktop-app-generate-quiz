/** Providers the backend knows how to call. Mirrors `PROVIDERS` in
 *  `back-end/app/features/llm/registry.py` — keep the two in sync. */
export type LlmProvider =
  | "gemini"
  | "anthropic"
  | "openai"
  | "deepseek"
  | "groq"
  | "xai"
  | "mistral"
  | "openrouter";

export interface ProviderInfo {
  id: LlmProvider;
  displayName: string;
  /** Wire format: gemini | anthropic | openai */
  dialect: string;
  /** What the key looks like, e.g. "sk-ant-…". Empty when there is no fixed shape. */
  keyHint: string;
  consoleUrl: string;
  supportsVision: boolean;
  freeTier: boolean;
  defaultModels: string[];
  /** Models actually used, in fallback order (override → catalogue → defaults). */
  modelChain: string[];
  /** Non-empty when the user pinned the chain by hand. */
  modelChainOverride: string[];
  cachedModelCount: number;
  totalKeys: number;
  activeKeys: number;
  isDefault: boolean;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  defaultProvider: LlmProvider;
  crossProviderFallback: boolean;
}

export interface LlmSettings {
  defaultProvider: LlmProvider;
  /** When off, a run fails instead of spilling over to another (possibly paid) provider. */
  crossProviderFallback: boolean;
  modelChains: Record<string, string[]>;
}

export interface ProviderModel {
  provider: LlmProvider;
  model: string;
  displayName: string;
  rank: number;
  rpd: number;
  rpm: number;
  tpm: number;
  tier: string;
  fetchedAt: string | null;
}

export interface RefreshModelsResult {
  provider: LlmProvider;
  count: number;
  models: ProviderModel[];
  modelChain: string[];
}

export interface ProviderUsage {
  provider: LlmProvider;
  totalKeys: number;
  activeKeys: number;
  totalTokens: number;
  requestsToday: number;
}

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
  provider: LlmProvider;
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

export interface LlmApiKey {
  id: string;
  provider: LlmProvider;
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

/** Codes the backend returns when a key is checked with its provider. */
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
  | "models_unavailable"
  | "sdk_missing";

export interface KeyVerification {
  ok: boolean;
  code: KeyVerificationCode;
  /** English fallback from the backend, shown when no localized string exists. */
  message: string;
  /** False when the verdict is "we could not check", not "the provider said no". */
  reachedProvider: boolean;
  /** @deprecated Gemini-era name for `reachedProvider`; still sent for compatibility. */
  reachedGoogle: boolean;
}

export interface AddKeyResult extends LlmApiKey {
  verification?: KeyVerification;
}

export interface VerifyKeyResult extends LlmApiKey {
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
  provider: LlmProvider;
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
  providerUsage: ProviderUsage[];
}

export interface KeysResponse {
  keys: LlmApiKey[];
  summary: KeyPoolSummary;
}
