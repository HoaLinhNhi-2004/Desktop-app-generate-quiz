import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddKeyResult,
  KeyPoolSummary,
  KeysResponse,
  KeyUsageHistory,
  LlmApiKey,
  LlmProvider,
  LlmSettings,
  PoolUsageHistory,
  ProvidersResponse,
  RefreshModelsResult,
  VerifyKeyResult,
} from "./types";
import {
  addKeyApi,
  deleteKeyApi,
  getKeyUsageHistoryApi,
  getKeysApi,
  getLlmSettingsApi,
  getPoolUsageHistoryApi,
  getProvidersApi,
  refreshProviderModelsApi,
  updateKeyApi,
  updateLlmSettingsApi,
  verifyKeyApi,
} from "./api";

const QUERY_KEY = ["api-keys"] as const;
const PROVIDERS_KEY = ["api-keys", "providers"] as const;

const emptySummary: KeyPoolSummary = {
  totalKeys: 0,
  activeKeys: 0,
  cooldownKeys: 0,
  disabledKeys: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  totalUsage: 0,
  totalErrors: 0,
  totalRequestsToday: 0,
  totalInputTokensToday: 0,
  totalOutputTokensToday: 0,
  totalTokensToday: 0,
  modelUsage: [],
  providerUsage: [],
};

export function useApiKeys() {
  const qc = useQueryClient();

  const query = useQuery<KeysResponse, Error>({
    queryKey: QUERY_KEY,
    queryFn: getKeysApi,
  });

  // QUERY_KEY is a prefix of PROVIDERS_KEY, so this refreshes both.
  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const addMutation = useMutation<
    AddKeyResult,
    Error,
    { provider: LlmProvider; key: string; label?: string }
  >({
    mutationFn: ({ provider, key, label }) => addKeyApi(provider, key, label),
    onSuccess: () => {
      void invalidate();
    },
  });

  const verifyMutation = useMutation<VerifyKeyResult, Error, string>({
    mutationFn: (id) => verifyKeyApi(id),
    onSuccess: () => {
      void invalidate();
    },
  });

  const toggleMutation = useMutation<
    LlmApiKey,
    Error,
    { id: string; currentStatus: LlmApiKey["status"] }
  >({
    mutationFn: ({ id, currentStatus }) =>
      updateKeyApi(id, {
        status: currentStatus === "disabled" ? "active" : "disabled",
      }),
    onSuccess: () => {
      void invalidate();
    },
  });

  const updateLabelMutation = useMutation<
    LlmApiKey,
    Error,
    { id: string; label: string }
  >({
    mutationFn: ({ id, label }) => updateKeyApi(id, { label }),
    onSuccess: () => {
      void invalidate();
    },
  });

  const removeMutation = useMutation<void, Error, string>({
    mutationFn: (id) => deleteKeyApi(id),
    onSuccess: () => {
      void invalidate();
    },
  });

  return {
    keys: query.data?.keys ?? [],
    summary: query.data?.summary ?? emptySummary,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    refresh: async (): Promise<void> => {
      await query.refetch();
    },
    addKey: (
      provider: LlmProvider,
      key: string,
      label?: string,
    ): Promise<AddKeyResult> => addMutation.mutateAsync({ provider, key, label }),
    verifyKey: (id: string): Promise<VerifyKeyResult> =>
      verifyMutation.mutateAsync(id),
    toggleKey: async (
      id: string,
      currentStatus: LlmApiKey["status"],
    ): Promise<void> => {
      await toggleMutation.mutateAsync({ id, currentStatus });
    },
    updateLabel: async (id: string, label: string): Promise<void> => {
      await updateLabelMutation.mutateAsync({ id, label });
    },
    removeKey: async (id: string): Promise<void> => {
      await removeMutation.mutateAsync(id);
    },
  };
}

/** Provider catalogue + which one runs by default. */
export function useProviders() {
  const qc = useQueryClient();

  const query = useQuery<ProvidersResponse, Error>({
    queryKey: PROVIDERS_KEY,
    queryFn: getProvidersApi,
  });

  // Changing the default provider or a model chain also changes what
  // /api/keys/ reports, so invalidate the whole api-keys tree.
  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const settingsMutation = useMutation<LlmSettings, Error, Partial<LlmSettings>>({
    mutationFn: (patch) => updateLlmSettingsApi(patch),
    onSuccess: () => {
      void invalidate();
    },
  });

  const refreshMutation = useMutation<RefreshModelsResult, Error, LlmProvider>({
    mutationFn: (provider) => refreshProviderModelsApi(provider),
    onSuccess: () => {
      void invalidate();
    },
  });

  return {
    providers: query.data?.providers ?? [],
    defaultProvider: query.data?.defaultProvider ?? "gemini",
    crossProviderFallback: query.data?.crossProviderFallback ?? true,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    savingSettings: settingsMutation.isPending,
    refreshingModels: refreshMutation.isPending,
    setDefaultProvider: async (provider: LlmProvider): Promise<void> => {
      await settingsMutation.mutateAsync({ defaultProvider: provider });
    },
    setCrossProviderFallback: async (enabled: boolean): Promise<void> => {
      await settingsMutation.mutateAsync({ crossProviderFallback: enabled });
    },
    setModelChain: async (
      provider: LlmProvider,
      models: string[],
    ): Promise<void> => {
      await settingsMutation.mutateAsync({ modelChains: { [provider]: models } });
    },
    refreshModels: (provider: LlmProvider): Promise<RefreshModelsResult> =>
      refreshMutation.mutateAsync(provider),
  };
}

export function useLlmSettings() {
  return useQuery<LlmSettings, Error>({
    queryKey: ["api-keys", "settings"],
    queryFn: getLlmSettingsApi,
  });
}

export function useKeyUsageHistory(keyId: string | null, days = 30) {
  return useQuery<KeyUsageHistory, Error>({
    queryKey: ["api-keys", "usage-history", keyId, days],
    queryFn: () => {
      if (!keyId) throw new Error("keyId is required");
      return getKeyUsageHistoryApi(keyId, days);
    },
    enabled: !!keyId,
  });
}

export function usePoolUsageHistory(days = 30) {
  return useQuery<PoolUsageHistory, Error>({
    queryKey: ["api-keys", "usage-history", "pool", days],
    queryFn: () => getPoolUsageHistoryApi(days),
  });
}
