import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddKeyResult,
  GeminiApiKey,
  KeyPoolSummary,
  KeysResponse,
  KeyUsageHistory,
  PoolUsageHistory,
  VerifyKeyResult,
} from "./types";
import {
  addKeyApi,
  deleteKeyApi,
  getKeyUsageHistoryApi,
  getKeysApi,
  getPoolUsageHistoryApi,
  updateKeyApi,
  verifyKeyApi,
} from "./api";

const QUERY_KEY = ["api-keys"] as const;

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
};

export function useApiKeys() {
  const qc = useQueryClient();

  const query = useQuery<KeysResponse, Error>({
    queryKey: QUERY_KEY,
    queryFn: getKeysApi,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const addMutation = useMutation<
    AddKeyResult,
    Error,
    { key: string; label?: string }
  >({
    mutationFn: ({ key, label }) => addKeyApi(key, label),
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
    GeminiApiKey,
    Error,
    { id: string; currentStatus: GeminiApiKey["status"] }
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
    GeminiApiKey,
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
    addKey: (key: string, label?: string): Promise<AddKeyResult> =>
      addMutation.mutateAsync({ key, label }),
    verifyKey: (id: string): Promise<VerifyKeyResult> =>
      verifyMutation.mutateAsync(id),
    toggleKey: async (
      id: string,
      currentStatus: GeminiApiKey["status"],
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
