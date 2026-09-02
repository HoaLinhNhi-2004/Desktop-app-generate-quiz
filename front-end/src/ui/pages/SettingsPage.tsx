import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/config/i18n";
import { cn } from "@/lib/utils";
import {
  ApiKeyError,
  useApiKeys,
  useKeyUsageHistory,
  usePoolUsageHistory,
  useProviders,
} from "@/features/api-keys";
import type {
  AddKeyResult,
  DailyUsageEntry,
  KeyVerification,
  LlmApiKey,
  LlmProvider,
  ModelSummary,
  ModelUsageStats,
  ProviderInfo,
} from "@/features/api-keys";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Key,
  Plus,
  Trash2,
  RefreshCw,
  Zap,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Ban,
  Activity,
  ArrowUpDown,
  Pencil,
  Cpu,
  Gauge,
  History,
  ShieldCheck,
  Accessibility,
  Plug,
  HardDrive,
  NotebookText,
  ExternalLink,
  Loader2,
  Settings2,
  Copy,
  Sparkles,
  ListRestart,
} from "lucide-react";
import { useA11y } from "@/config/a11y-provider";
import type { SpeechRate } from "@/lib/use-speech";
import {
  useIntegrations,
  useDisconnectIntegration,
  useConnectIntegration,
  useVerifyCredentials,
  useSaveCredentials,
  useDeleteCredentials,
  openExternalPage,
  IntegrationError,
} from "@/features/integrations";
import type {
  CredentialCheck,
  CredentialVerification,
  IntegrationProvider,
  IntegrationStatus,
} from "@/features/integrations";

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function timeAgo(isoDate: string | null): string {
  if (!isoDate) return i18n.t("settings.timeAgo.never");
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return i18n.t("settings.timeAgo.justNow");
  if (mins < 60) return i18n.t("settings.timeAgo.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n.t("settings.timeAgo.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return i18n.t("settings.timeAgo.daysAgo", { n: days });
}

const statusConfig = {
  active: {
    labelKey: "settings.status.active",
    color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    icon: CheckCircle2,
  },
  cooldown: {
    labelKey: "settings.status.cooldown",
    color: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    icon: Clock,
  },
  disabled: {
    labelKey: "settings.status.disabled",
    color: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    icon: Ban,
  },
} as const;

const modelColors: Record<string, string> = {
  "gemini-2.5-flash": "text-blue-400",
  "gemini-2.5-flash-lite": "text-cyan-400",
  "gemini-2.0-flash": "text-amber-400",
};

/** One accent per provider so a key's vendor is readable at a glance. */
const providerStyles: Record<LlmProvider, string> = {
  gemini: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  anthropic: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  openai: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  deepseek: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  groq: "bg-red-500/15 text-red-400 border-red-500/30",
  xai: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  mistral: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  openrouter: "bg-violet-500/15 text-violet-400 border-violet-500/30",
};

function ProviderBadge({
  provider,
  displayName,
}: {
  provider: LlmProvider;
  displayName?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 text-[10px] font-medium",
        providerStyles[provider] ?? providerStyles.gemini,
      )}
    >
      <Sparkles className="size-2.5" />
      {displayName ?? provider}
    </Badge>
  );
}

function KeyStatusBadge({ status }: { status: LlmApiKey["status"] }) {
  const { t } = useTranslation();
  const cfg = statusConfig[status] || statusConfig.disabled;
  const Icon = cfg.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-xs font-medium", cfg.color)}
    >
      <Icon className="size-3" />
      {t(cfg.labelKey)}
    </Badge>
  );
}

/** Map a backend error code to a localized explanation.
 *
 * Falls back to the backend's own message rather than a fixed string, so an
 * unmapped code still tells the user what Google actually said.
 */
function useKeyMessages() {
  const { t } = useTranslation();

  const translateOr = (path: string, fallback: string): string => {
    const translated = t(path);
    return translated === path ? fallback : translated;
  };

  return {
    errorMessage: (err: unknown): string => {
      if (err instanceof ApiKeyError) {
        return translateOr(`settings.keyErrors.${err.code}`, err.message);
      }
      return err instanceof Error ? err.message : t("settings.addKeyError");
    },
    /** Non-blocking note for a key that was stored but not fully confirmed. */
    warning: (verification?: KeyVerification): string | null => {
      if (!verification || verification.code === "valid") return null;
      return translateOr(
        `settings.keyWarnings.${verification.code}`,
        verification.message,
      );
    },
  };
}

function AddKeyDialog({
  onAdd,
  providers,
  defaultProvider,
}: {
  onAdd: (
    provider: LlmProvider,
    key: string,
    label: string,
  ) => Promise<AddKeyResult>;
  providers: ProviderInfo[];
  defaultProvider: LlmProvider;
}) {
  const { t } = useTranslation();
  const { errorMessage, warning } = useKeyMessages();
  const [provider, setProvider] = useState<LlmProvider>(defaultProvider);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = providers.find((p) => p.id === provider);

  function reset() {
    setProvider(defaultProvider);
    setKey("");
    setLabel("");
    setError(null);
  }

  async function handleSubmit() {
    if (!key.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      const added = await onAdd(provider, key.trim(), label.trim());
      reset();
      setOpen(false);
      const note = warning(added.verification);
      if (note) toast.warning(note);
      else toast.success(t("settings.addKeySuccess"));
    } catch (err) {
      // Kept inline (not only a toast) so the user can read it while fixing the key.
      setError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-4" />
          {t("settings.addKeyButton")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.addKeyDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.addKeyDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="key-provider">
              {t("settings.addKeyDialog.providerField")}
            </Label>
            <Select
              value={provider}
              onValueChange={(next) => {
                setProvider(next as LlmProvider);
                setError(null);
              }}
            >
              <SelectTrigger id="key-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      {p.displayName}
                      {p.freeTier && (
                        <span className="text-[10px] text-emerald-400">
                          {t("settings.providers.freeTier")}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected?.consoleUrl && (
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                onClick={() => openExternalPage(selected.consoleUrl)}
              >
                <ExternalLink className="size-3" />
                {t("settings.addKeyDialog.getKeyLink", {
                  provider: selected.displayName,
                })}
              </button>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="api-key">{t("settings.apiKeyLabel")}</Label>
            <Input
              id="api-key"
              type="password"
              placeholder={selected?.keyHint || "sk-…"}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              aria-invalid={error !== null}
              aria-describedby={error ? "api-key-error" : undefined}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="key-label">
              {t("settings.addKeyDialog.labelField")}
            </Label>
            <Input
              id="key-label"
              placeholder={t("settings.addKeyDialog.labelPlaceholder")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>
          {error && (
            <p
              id="api-key-error"
              role="alert"
              className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 p-2.5 text-xs text-red-400"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">
              {t("settings.addKeyDialog.cancelButton")}
            </Button>
          </DialogClose>
          <Button onClick={handleSubmit} disabled={!key.trim() || adding}>
            {adding && <Loader2 className="size-3.5 animate-spin" />}
            {adding
              ? t("settings.addKeyDialog.addingButton")
              : t("settings.addKeyDialog.addButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Today vs RPD cell ───────────────────────────────────────────────────────

function TodayVsRpdCell({
  requestsToday,
  rpd,
}: {
  requestsToday: number;
  rpd: number;
}) {
  if (rpd <= 0) {
    return <span className="text-muted-foreground/50 text-xs">-</span>;
  }
  const pct = Math.min(100, Math.round((requestsToday / rpd) * 100));
  const tone =
    pct >= 90
      ? "text-red-400"
      : pct >= 70
        ? "text-amber-400"
        : "text-emerald-400";
  return (
    <div className="flex flex-col items-end gap-1">
      <span className={cn("text-xs font-mono font-semibold", tone)}>
        {requestsToday}
        <span className="text-muted-foreground"> / {rpd}</span>
      </span>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all",
            pct >= 90
              ? "bg-red-400"
              : pct >= 70
                ? "bg-amber-400"
                : "bg-emerald-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Provider selection ──────────────────────────────────────────────────────

function ProviderRow({
  provider,
  isDefault,
  onRefreshModels,
  refreshing,
}: {
  provider: ProviderInfo;
  isDefault: boolean;
  onRefreshModels: () => Promise<void>;
  refreshing: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        isDefault
          ? "border-primary/40 bg-primary/5"
          : "border-border/50 bg-card/50",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ProviderBadge
            provider={provider.id}
            displayName={provider.displayName}
          />
          {isDefault && (
            <Badge variant="outline" className="text-[10px]">
              {t("settings.providers.defaultBadge")}
            </Badge>
          )}
          {provider.totalKeys === 0 ? (
            <span className="text-[11px] text-muted-foreground/70">
              {t("settings.providers.noKeys")}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t("settings.providers.keyCount", {
                active: provider.activeKeys,
                total: provider.totalKeys,
              })}
            </span>
          )}
          {!provider.supportsVision && (
            <span className="text-[11px] text-amber-400/80">
              {t("settings.providers.noVision")}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onRefreshModels}
          disabled={refreshing || provider.totalKeys === 0}
          title={
            provider.totalKeys === 0
              ? t("settings.providers.refreshNeedsKey")
              : undefined
          }
        >
          <ListRestart className={cn("size-3.5", refreshing && "animate-spin")} />
          {t("settings.providers.refreshModels")}
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {t("settings.providers.chainLabel")}
        </span>
        {provider.modelChain.map((model, index) => (
          <span
            key={model}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {index + 1}. {model}
          </span>
        ))}
        {provider.modelChainOverride.length > 0 && (
          <span className="text-[10px] text-primary">
            {t("settings.providers.pinned")}
          </span>
        )}
        {provider.cachedModelCount > 0 && (
          <span className="text-[10px] text-muted-foreground/60">
            {t("settings.providers.catalogueCount", {
              count: provider.cachedModelCount,
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function ProvidersCard() {
  const { t } = useTranslation();
  const {
    providers,
    defaultProvider,
    crossProviderFallback,
    loading,
    setDefaultProvider,
    setCrossProviderFallback,
    refreshModels,
    savingSettings,
  } = useProviders();
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(
    null,
  );

  async function handleRefresh(provider: LlmProvider) {
    setRefreshingProvider(provider);
    try {
      const result = await refreshModels(provider);
      toast.success(
        t("settings.providers.refreshSuccess", { count: result.count }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.providers.refreshFailed"),
      );
    } finally {
      setRefreshingProvider(null);
    }
  }

  async function saveSetting(apply: () => Promise<void>) {
    try {
      await apply();
      toast.success(t("settings.settingsSaved"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.saveSettingsFailed"),
      );
    }
  }

  const configured = providers.filter((p) => p.totalKeys > 0);

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" />
          {t("settings.providers.title")}
        </CardTitle>
        <CardDescription>
          {t("settings.providers.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:max-w-xs">
          <Label htmlFor="default-provider">
            {t("settings.providers.defaultLabel")}
          </Label>
          <Select
            value={defaultProvider}
            onValueChange={(next) => {
              void saveSetting(() => setDefaultProvider(next as LlmProvider));
            }}
            disabled={loading || savingSettings}
          >
            <SelectTrigger id="default-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayName}
                  {p.totalKeys === 0 && ` — ${t("settings.providers.noKeys")}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border/50 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="cross-provider-fallback" className="text-sm">
              {t("settings.providers.fallbackLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.providers.fallbackDescription")}
            </p>
          </div>
          <Switch
            id="cross-provider-fallback"
            checked={crossProviderFallback}
            onCheckedChange={(checked) => {
              void saveSetting(() => setCrossProviderFallback(checked));
            }}
            disabled={loading || savingSettings}
          />
        </div>

        <div className="space-y-2">
          {(configured.length > 0 ? configured : providers).map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              isDefault={p.id === defaultProvider}
              refreshing={refreshingProvider === p.id}
              onRefreshModels={() => handleRefresh(p.id)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Per-model usage table (global) ──────────────────────────────────────────

function ModelUsageTable({ models }: { models: ModelSummary[] }) {
  const { t } = useTranslation();
  if (models.length === 0) return null;

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Cpu className="size-4 text-primary" />
          {t("settings.modelUsage.title")}
        </CardTitle>
        <CardDescription>
          {t("settings.modelUsage.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">
                  {t("settings.modelUsage.headers.model")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.headers.todayRpd")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.headers.tokensToday")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.headers.lifetime")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">RPM</th>
                <th className="pb-2 pl-3 font-medium text-right">TPM</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const color = modelColors[m.model] || "text-foreground";
                const tokensToday = m.inputTokensToday + m.outputTokensToday;
                return (
                  <tr
                    key={m.model}
                    className="border-b border-border/30 last:border-0"
                  >
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <Cpu className={cn("size-3.5 shrink-0", color)} />
                        <div>
                          <p className={cn("font-medium text-xs", color)}>
                            {m.displayName}
                          </p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {m.model}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <TodayVsRpdCell
                        requestsToday={m.requestsToday}
                        rpd={m.limits?.rpd ?? 0}
                      />
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                      {tokensToday > 0 ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="font-semibold">
                            {formatNumber(tokensToday)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            <span className="text-blue-400">
                              {formatNumber(m.inputTokensToday)}
                            </span>
                            {" / "}
                            <span className="text-violet-400">
                              {formatNumber(m.outputTokensToday)}
                            </span>
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td
                      className="py-2.5 px-3 text-right font-mono text-xs text-muted-foreground"
                      title={t("settings.modelUsage.lifetimeTooltip")}
                    >
                      {m.requests > 0 ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <span>{m.requests} req</span>
                          <span className="text-[10px]">
                            {formatNumber(m.totalTokens)} tok
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {m.limits ? (
                        <span className="text-xs text-muted-foreground">
                          {m.limits.rpm}
                          {t("settings.rateLimit.perMinute")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">
                          -
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      {m.limits ? (
                        <span className="text-xs text-muted-foreground">
                          {formatNumber(m.limits.tpm)}
                          {t("settings.rateLimit.perMinute")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">
                          -
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Per-key model mini table ────────────────────────────────────────────────

function KeyModelBreakdown({
  modelUsage,
}: {
  modelUsage: Record<string, ModelUsageStats>;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(modelUsage).filter(([, s]) => s.requests > 0);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1.5 space-y-1">
      {entries.map(([model, stats]) => {
        const color = modelColors[model] || "text-foreground";
        return (
          <div key={model} className="flex items-center gap-2 text-[10px]">
            <Cpu className={cn("size-2.5 shrink-0", color)} />
            <span className={cn("font-medium min-w-[100px]", color)}>
              {model}
            </span>
            <span className="text-muted-foreground">
              {stats.requests} {t("settings.breakdown.req")}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-blue-400">
              {formatNumber(stats.inputTokens)} {t("settings.breakdown.in")}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-violet-400">
              {formatNumber(stats.outputTokens)} {t("settings.breakdown.out")}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="font-semibold">
              {formatNumber(stats.totalTokens)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Key history dialog ──────────────────────────────────────────────────────

type HistoryRange = 7 | 30 | 90;

function aggregateByDate(
  entries: DailyUsageEntry[],
): { date: string; requests: number; totalTokens: number }[] {
  const byDate = new Map<string, { requests: number; totalTokens: number }>();
  for (const e of entries) {
    const bucket = byDate.get(e.datePst) ?? { requests: 0, totalTokens: 0 };
    bucket.requests += e.requests;
    bucket.totalTokens += e.totalTokens;
    byDate.set(e.datePst, bucket);
  }
  return Array.from(byDate.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function KeyHistoryDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: LlmApiKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [range, setRange] = useState<HistoryRange>(30);
  const { data, isLoading } = useKeyUsageHistory(open ? apiKey.id : null, range);

  const chartData = data ? aggregateByDate(data.entries) : [];
  const totalRequests = chartData.reduce((s, d) => s + d.requests, 0);
  const totalTokens = chartData.reduce((s, d) => s + d.totalTokens, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings.history.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.history.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 pt-2">
          <div className="text-xs text-muted-foreground">
            {apiKey.label || t("settings.keyCard.noLabel")} ·{" "}
            <span className="font-mono">{apiKey.key}</span>
          </div>
          <div className="flex gap-1">
            {([7, 30, 90] as const).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setRange(r)}
              >
                {t(`settings.history.range${r}`)}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="rounded-lg border border-border/50 bg-card/50 p-3">
            <p className="text-[10px] text-muted-foreground">
              {t("settings.history.totalRequests")}
            </p>
            <p className="text-xl font-semibold">{totalRequests}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-card/50 p-3">
            <p className="text-[10px] text-muted-foreground">
              {t("settings.history.totalTokens")}
            </p>
            <p className="text-xl font-semibold">
              {formatNumber(totalTokens)}
            </p>
          </div>
        </div>

        <div className="h-64 pt-2">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin mr-2" />
              {t("settings.history.loading")}
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("settings.history.noData")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.15}
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-muted-foreground"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-muted-foreground"
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 11,
                    padding: "6px 10px",
                    color: "hsl(var(--foreground))",
                  }}
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.1 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="requests"
                  fill="hsl(217 91% 60%)"
                  name={t("settings.stats.requests")}
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">
              {t("settings.addKeyDialog.cancelButton")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Key Card ────────────────────────────────────────────────────────────────

function KeyCard({
  apiKey,
  providerName,
  onToggle,
  onDelete,
  onRename,
  onVerify,
}: {
  apiKey: LlmApiKey;
  providerName?: string;
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRename: (label: string) => Promise<void>;
  onVerify: () => Promise<KeyVerification>;
}) {
  const { t } = useTranslation();
  const { errorMessage, warning } = useKeyMessages();
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(apiKey.label);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const totalTokens = apiKey.totalTokens;
  const successRate =
    apiKey.usageCount > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((apiKey.usageCount - apiKey.errorCount) / apiKey.usageCount) *
                100,
            ),
          ),
        )
      : 100;

  async function handleSaveLabel() {
    if (saving) return;
    setSaving(true);
    try {
      await onRename(labelDraft);
      setEditing(false);
    } catch {
      // Parent đã hiển thị toast.error; giữ edit mode để user retry
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  }

  async function handleToggle() {
    if (toggling) return;
    setToggling(true);
    try {
      await onToggle();
    } finally {
      setToggling(false);
    }
  }

  async function handleVerify() {
    if (verifying) return;
    setVerifying(true);
    try {
      const verification = await onVerify();
      if (!verification.ok) {
        toast.error(
          `${t("settings.verify.failed")} — ${errorMessage(
            new ApiKeyError(verification.message, verification.code),
          )}`,
        );
        return;
      }
      const note = warning(verification);
      if (note) toast.warning(note);
      else toast.success(t("settings.verify.valid"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Card className="group relative overflow-hidden border-border/50 bg-card/50 transition-colors hover:border-border">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            {/* Label + status */}
            <div className="flex items-center gap-2">
              {editing ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    className="h-7 w-48 text-sm"
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveLabel();
                      if (e.key === "Escape") setEditing(false);
                    }}
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional focus on inline edit toggle
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={saving}
                    onClick={handleSaveLabel}
                  >
                    {saving && <Loader2 className="size-3 animate-spin" />}
                    {t("settings.keyCard.save")}
                  </Button>
                </div>
              ) : (
                <button
                  className="flex items-center gap-1.5 text-sm font-semibold hover:text-primary transition-colors"
                  onClick={() => {
                    setLabelDraft(apiKey.label);
                    setEditing(true);
                  }}
                >
                  {apiKey.label || t("settings.keyCard.noLabel")}
                  <Pencil className="size-3 opacity-0 group-hover:opacity-50" />
                </button>
              )}
              <ProviderBadge
                provider={apiKey.provider}
                displayName={providerName}
              />
              <KeyStatusBadge status={apiKey.status} />
            </div>

            {/* Masked key */}
            <p className="font-mono text-xs text-muted-foreground truncate">
              {apiKey.key}
            </p>

            {/* Today stats — primary */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-medium">
                {t("settings.keyCard.todayLabel")}
              </span>
              <span className="flex items-center gap-1 text-foreground">
                <Activity className="size-3 text-purple-400" />
                <strong>{apiKey.requestsToday}</strong>{" "}
                <span className="text-muted-foreground">
                  {t("settings.stats.requests")}
                </span>
              </span>
              <span className="flex items-center gap-1 text-foreground">
                <Zap className="size-3 text-blue-400" />
                <strong>{formatNumber(apiKey.tokensToday)}</strong>{" "}
                <span className="text-muted-foreground">
                  {t("settings.stats.tokens")}
                </span>
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <Clock className="size-3" />
                {timeAgo(apiKey.lastUsedAt)}
              </span>
            </div>

            {/* Today token breakdown bar */}
            {apiKey.tokensToday > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>
                    {t("settings.stats.input")}:{" "}
                    {formatNumber(apiKey.inputTokensToday)}
                  </span>
                  <span>
                    {t("settings.stats.output")}:{" "}
                    {formatNumber(apiKey.outputTokensToday)}
                  </span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bg-blue-500 transition-all"
                    style={{
                      width: `${(apiKey.inputTokensToday / apiKey.tokensToday) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-violet-500 transition-all"
                    style={{
                      width: `${(apiKey.outputTokensToday / apiKey.tokensToday) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Lifetime stats — secondary */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/70">
              <span className="uppercase tracking-wide font-medium">
                {t("settings.keyCard.lifetimeLabel")}
              </span>
              <span>
                <strong className="text-muted-foreground">
                  {apiKey.usageCount}
                </strong>{" "}
                {t("settings.stats.requests")}
              </span>
              <span>
                <strong className="text-muted-foreground">
                  {formatNumber(totalTokens)}
                </strong>{" "}
                {t("settings.stats.tokens")}
              </span>
              {apiKey.errorCount > 0 && (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="size-2.5 text-red-400" />
                  <strong className="text-red-400">
                    {apiKey.errorCount}
                  </strong>{" "}
                  {t("settings.stats.errors")}
                </span>
              )}
            </div>

            {/* Per-model breakdown */}
            <KeyModelBreakdown modelUsage={apiKey.modelUsage} />

            {/* Success rate */}
            {apiKey.usageCount > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">
                  {t("settings.modelUsage.successRate")}
                </span>
                <Progress
                  value={successRate}
                  className="h-1.5 flex-1 max-w-[120px]"
                />
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    successRate >= 90
                      ? "text-emerald-400"
                      : successRate >= 70
                        ? "text-amber-400"
                        : "text-red-400",
                  )}
                >
                  {successRate}%
                </span>
              </div>
            )}

            {/* Last error */}
            {apiKey.lastError && (
              <p className="text-[10px] text-red-400/80 truncate max-w-[400px]">
                {t("settings.modelUsage.errorPrefix")} {apiKey.lastError}
              </p>
            )}
          </div>

          {/* Right: Controls */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <Switch
              checked={apiKey.status !== "disabled"}
              onCheckedChange={handleToggle}
              disabled={toggling}
              aria-label={t("settings.toggleAriaLabel")}
            />
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-emerald-400"
                onClick={handleVerify}
                disabled={verifying}
                aria-label={t("settings.verify.button")}
                title={t("settings.verify.button")}
              >
                {verifying ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="size-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                onClick={() => setHistoryOpen(true)}
                aria-label={t("settings.history.buttonLabel")}
              >
                <History className="size-3.5" />
              </Button>
              <ConfirmDialog
                destructive
                title={t("confirm.deleteApiKey.title")}
                description={t("confirm.deleteApiKey.desc")}
                confirmLabel={t("common.delete")}
                pending={deleting}
                onConfirm={handleDelete}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                  disabled={deleting}
                  aria-label={t("a11y.labels.deleteApiKey")}
                >
                  {deleting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </ConfirmDialog>
            </div>
          </div>
        </div>
      </CardContent>
      <KeyHistoryDialog
        apiKey={apiKey}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
    </Card>
  );
}

// ─── Pool history card (combined across all keys) ────────────────────────────

type PoolHistoryRange = 7 | 30 | 90;

function PoolHistoryCard() {
  const { t } = useTranslation();
  const [range, setRange] = useState<PoolHistoryRange>(30);
  const { data, isLoading } = usePoolUsageHistory(range);

  const { chartData, totalRequests, totalTokens, perDayAvg } = useMemo(() => {
    const entries = data?.entries ?? [];
    const byDate = new Map<
      string,
      { date: string; requests: number; totalTokens: number }
    >();
    for (const e of entries) {
      const bucket = byDate.get(e.datePst) ?? {
        date: e.datePst,
        requests: 0,
        totalTokens: 0,
      };
      bucket.requests += e.requests;
      bucket.totalTokens += e.totalTokens;
      byDate.set(e.datePst, bucket);
    }
    const rows = Array.from(byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const totReq = rows.reduce((s, r) => s + r.requests, 0);
    const totTok = rows.reduce((s, r) => s + r.totalTokens, 0);
    return {
      chartData: rows,
      totalRequests: totReq,
      totalTokens: totTok,
      perDayAvg: rows.length > 0 ? Math.round(totReq / rows.length) : 0,
    };
  }, [data]);

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <History className="size-4 text-primary" />
              {t("settings.poolHistory.title")}
            </CardTitle>
            <CardDescription>
              {t("settings.poolHistory.description")}
            </CardDescription>
          </div>
          <div className="flex gap-1 shrink-0">
            {([7, 30, 90] as const).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setRange(r)}
              >
                {t(`settings.history.range${r}`)}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border/50 bg-card/50 p-3">
            <p className="text-[10px] text-muted-foreground">
              {t("settings.poolHistory.totalRequests")}
            </p>
            <p className="text-xl font-semibold">{totalRequests}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-card/50 p-3">
            <p className="text-[10px] text-muted-foreground">
              {t("settings.poolHistory.totalTokens")}
            </p>
            <p className="text-xl font-semibold">
              {formatNumber(totalTokens)}
            </p>
          </div>
          <div className="rounded-lg border border-border/50 bg-card/50 p-3">
            <p className="text-[10px] text-muted-foreground">
              {t("settings.poolHistory.perDayAvg")}
            </p>
            <p className="text-xl font-semibold">{perDayAvg}</p>
          </div>
        </div>

        <div className="h-56">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin mr-2" />
              {t("settings.poolHistory.loading")}
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("settings.poolHistory.noData")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.15}
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-muted-foreground"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-muted-foreground"
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 11,
                    padding: "6px 10px",
                    color: "hsl(var(--foreground))",
                  }}
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.1 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="requests"
                  fill="hsl(217 91% 60%)"
                  name={t("settings.poolHistory.requests")}
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

const PROVIDER_META: Record<
  IntegrationProvider,
  { name: string; icon: typeof HardDrive; consoleUrl: string; stepCount: number }
> = {
  google: {
    name: "Google Drive",
    icon: HardDrive,
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    stepCount: 5,
  },
  notion: {
    name: "Notion",
    icon: NotebookText,
    consoleUrl: "https://www.notion.so/my-integrations",
    stepCount: 4,
  },
};

/** Same contract as useKeyMessages: a localized string per backend code,
 * falling back to the provider's own wording for anything unmapped. */
function useIntegrationMessages() {
  const { t } = useTranslation();

  const translateOr = (path: string, fallback: string): string => {
    const translated = t(path);
    return translated === path ? fallback : translated;
  };

  return {
    errorMessage: (err: unknown): string => {
      if (err instanceof IntegrationError) {
        return translateOr(`settings.integrations.errors.${err.code}`, err.message);
      }
      return err instanceof Error ? err.message : t("settings.integrations.saveFailed");
    },
    checkMessage: (check: CredentialCheck): string =>
      translateOr(`settings.integrations.errors.${check.code}`, check.message),
  };
}

function VerificationReport({
  verification,
}: {
  verification: CredentialVerification;
}) {
  const { t } = useTranslation();
  const { checkMessage } = useIntegrationMessages();

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/30 p-2.5">
      {verification.checks.map((check) => {
        // "Could not reach the provider" is neither a pass nor a failure — it
        // must not show a green tick the user would read as confirmation.
        const unknown = check.ok && !check.reachedProvider;
        return (
          <p
            key={check.name}
            className={cn(
              "flex items-start gap-1.5 text-xs",
              unknown
                ? "text-amber-400"
                : check.ok
                  ? "text-emerald-400"
                  : "text-red-400",
            )}
          >
            {unknown ? (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            ) : check.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <Ban className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>
              <span className="font-medium">
                {t(`settings.integrations.checkNames.${check.name}`)}:
              </span>{" "}
              {checkMessage(check)}
            </span>
          </p>
        );
      })}
    </div>
  );
}

function ProviderSetupDialog({ status }: { status: IntegrationStatus }) {
  const { t } = useTranslation();
  const { errorMessage } = useIntegrationMessages();
  const meta = PROVIDER_META[status.provider];
  const verify = useVerifyCredentials();
  const save = useSaveCredentials();
  const remove = useDeleteCredentials();

  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState(status.credential?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [pickerApiKey, setPickerApiKey] = useState("");
  const [report, setReport] = useState<CredentialVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = status.credential;
  // A stored secret stays masked, so an untouched field means "keep it" and
  // the client ID alone is enough to submit the form.
  const canSubmit =
    clientId.trim() !== "" && (clientSecret.trim() !== "" || !!stored);

  function resetFrom(next: IntegrationStatus) {
    setClientId(next.credential?.clientId ?? "");
    setClientSecret("");
    setPickerApiKey("");
    setReport(null);
    setError(null);
  }

  function payload() {
    return {
      provider: status.provider,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      pickerApiKey: pickerApiKey.trim(),
    };
  }

  async function handleVerify() {
    setError(null);
    setReport(null);
    try {
      setReport(await verify.mutateAsync(payload()));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleSave() {
    setError(null);
    try {
      const result = await save.mutateAsync(payload());
      setReport(result.verification);
      setOpen(false);
      if (result.connectionCleared) {
        toast.warning(t("settings.integrations.savedConnectionCleared"));
      } else if (!result.verification.reachedProvider) {
        toast.warning(t("settings.integrations.savedUnverified"));
      } else {
        toast.success(t("settings.integrations.saved"));
      }
    } catch (err) {
      // Kept inline as well as in the report so it stays readable while fixing.
      setError(errorMessage(err));
      if (err instanceof IntegrationError && err.verification) {
        setReport(err.verification);
      }
    }
  }

  async function handleRemove() {
    setError(null);
    try {
      await remove.mutateAsync(status.provider);
      setOpen(false);
      toast.success(t("settings.integrations.credentialsRemoved"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openConsole() {
    // Refused rather than silent when the main process does not allow the host.
    const opened = await openExternalPage(meta.consoleUrl);
    if (!opened) toast.error(t("settings.integrations.openFailed"));
  }

  async function copyRedirectUri() {
    try {
      await navigator.clipboard.writeText(status.redirectUri);
      toast.success(t("settings.integrations.copied"));
    } catch {
      toast.error(t("settings.integrations.copyFailed"));
    }
  }

  const busy = verify.isPending || save.isPending || remove.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) resetFrom(status);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Settings2 className="size-4" />
          {t("settings.integrations.configure")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("settings.integrations.setupTitle", { provider: meta.name })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.integrations.setupDescription")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-3">
          <div className="grid gap-4 py-1">
            <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
              {Array.from({ length: meta.stepCount }, (_, i) => (
                <li key={i}>
                  {t(`settings.integrations.steps.${status.provider}.${i + 1}`)}
                </li>
              ))}
            </ol>

            <Button
              variant="ghost"
              size="sm"
              className="w-fit gap-1.5 px-2 text-xs"
              onClick={openConsole}
            >
              <ExternalLink className="size-3.5" />
              {t("settings.integrations.openConsole", { provider: meta.name })}
            </Button>

            <div className="grid gap-2">
              <Label htmlFor={`redirect-${status.provider}`}>
                {t("settings.integrations.redirectUriLabel")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`redirect-${status.provider}`}
                  readOnly
                  value={status.redirectUri}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={copyRedirectUri}
                  aria-label={t("settings.integrations.copyRedirectUri")}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor={`client-id-${status.provider}`}>
                {t("settings.integrations.clientIdLabel")}
              </Label>
              <Input
                id={`client-id-${status.provider}`}
                value={clientId}
                placeholder={
                  status.provider === "google"
                    ? "1234567890-abc.apps.googleusercontent.com"
                    : "1a2b3c4d-5e6f-7890-abcd-ef1234567890"
                }
                onChange={(e) => {
                  setClientId(e.target.value);
                  setError(null);
                }}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor={`client-secret-${status.provider}`}>
                {t("settings.integrations.clientSecretLabel")}
              </Label>
              <Input
                id={`client-secret-${status.provider}`}
                type="password"
                value={clientSecret}
                placeholder={
                  stored?.clientSecretMasked ||
                  (status.provider === "google" ? "GOCSPX-..." : "secret_...")
                }
                onChange={(e) => {
                  setClientSecret(e.target.value);
                  setError(null);
                }}
              />
              {stored?.clientSecretMasked && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.integrations.secretKeptHint")}
                </p>
              )}
            </div>

            {status.needsPickerApiKey && (
              <div className="grid gap-2">
                <Label htmlFor={`picker-key-${status.provider}`}>
                  {t("settings.integrations.pickerKeyLabel")}
                </Label>
                <Input
                  id={`picker-key-${status.provider}`}
                  type="password"
                  value={pickerApiKey}
                  placeholder={stored?.pickerApiKeyMasked || "AIzaSy..."}
                  onChange={(e) => {
                    setPickerApiKey(e.target.value);
                    setError(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.integrations.pickerKeyHint")}
                </p>
              </div>
            )}

            {report && <VerificationReport verification={report} />}

            {error && (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 p-2.5 text-xs text-red-400"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="gap-2 sm:justify-between">
          {stored ? (
            <ConfirmDialog
              destructive
              title={t("confirm.removeCredentials.title", {
                provider: meta.name,
              })}
              description={t("confirm.removeCredentials.desc")}
              confirmLabel={t("common.delete")}
              pending={remove.isPending}
              onConfirm={handleRemove}
            >
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
              >
                <Trash2 className="size-4" />
                {t("settings.integrations.removeCredentials")}
              </Button>
            </ConfirmDialog>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!canSubmit || busy}
              onClick={handleVerify}
            >
              {verify.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {t("settings.integrations.verify")}
            </Button>
            <Button disabled={!canSubmit || busy} onClick={handleSave}>
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {t("settings.integrations.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationsCard() {
  const { t } = useTranslation();
  const { data: providers, isLoading } = useIntegrations();
  const disconnect = useDisconnectIntegration();
  const connect = useConnectIntegration();
  const [connecting, setConnecting] = useState<IntegrationProvider | null>(null);

  const handleConnect = async (provider: IntegrationProvider) => {
    setConnecting(provider);
    try {
      const opened = await connect(provider);
      if (!opened) toast.error(t("settings.integrations.openFailed"));
      else toast.info(t("settings.integrations.browserOpened"));
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = (provider: IntegrationProvider) => {
    disconnect.mutate(provider, {
      onSuccess: () => toast.success(t("settings.integrations.disconnected")),
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Plug className="size-5 text-primary" aria-hidden="true" />
          <CardTitle className="text-base font-semibold">
            {t("settings.integrations.sectionTitle")}
          </CardTitle>
        </div>
        <CardDescription>
          {t("settings.integrations.sectionDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">
            {t("settings.integrations.loading")}
          </p>
        )}
        {(providers ?? []).map((status) => {
          const { provider, configured, connection } = status;
          const meta = PROVIDER_META[provider];
          const Icon = meta.icon;
          return (
            <div
              key={provider}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5"
            >
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{meta.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {!configured
                    ? t("settings.integrations.notConfigured")
                    : connection
                      ? t("settings.integrations.connectedAs", {
                          account: connection.accountLabel,
                        })
                      : t("settings.integrations.notConnected")}
                </p>
              </div>
              <ProviderSetupDialog status={status} />
              {connection ? (
                <ConfirmDialog
                  destructive
                  title={t("confirm.disconnect.title", { provider: meta.name })}
                  description={t("confirm.disconnect.desc")}
                  confirmLabel={t("settings.integrations.disconnect")}
                  pending={disconnect.isPending}
                  onConfirm={() => handleDisconnect(provider)}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disconnect.isPending}
                  >
                    {t("settings.integrations.disconnect")}
                  </Button>
                </ConfirmDialog>
              ) : (
                <Button
                  size="sm"
                  disabled={!configured || connecting === provider}
                  onClick={() => handleConnect(provider)}
                >
                  {connecting === provider ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="size-4" />
                  )}
                  {t("settings.integrations.connect")}
                </Button>
              )}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {t("settings.integrations.browserNote")}
        </p>
      </CardContent>
    </Card>
  );
}

function AccessibilityCard() {
  const { t } = useTranslation();
  const {
    ttsEnabled,
    setTtsEnabled,
    ttsRate,
    setTtsRate,
    highContrast,
    setHighContrast,
  } = useA11y();
  const rates: SpeechRate[] = ["slow", "normal", "fast"];

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Accessibility className="size-5 text-primary" aria-hidden="true" />
          <CardTitle className="text-base font-semibold">
            {t("a11y.settings.sectionTitle")}
          </CardTitle>
        </div>
        <CardDescription>
          {t("a11y.settings.sectionDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="a11y-contrast" className="text-sm font-medium">
              {t("a11y.settings.highContrast")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("a11y.settings.highContrastDescription")}
            </p>
          </div>
          <Switch
            id="a11y-contrast"
            checked={highContrast}
            onCheckedChange={setHighContrast}
          />
        </div>

        <Separator />

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="a11y-tts" className="text-sm font-medium">
              {t("a11y.settings.tts")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("a11y.settings.ttsDescription")}
            </p>
          </div>
          <Switch
            id="a11y-tts"
            checked={ttsEnabled}
            onCheckedChange={setTtsEnabled}
          />
        </div>

        {ttsEnabled && (
          <div className="space-y-2">
            <span
              id="a11y-tts-rate-label"
              className="text-sm font-medium block"
            >
              {t("a11y.settings.ttsRate")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="a11y-tts-rate-label"
              className="inline-flex rounded-md border border-border p-0.5"
            >
              {rates.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={ttsRate === r}
                  onClick={() => setTtsRate(r)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
                    ttsRate === r
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {t(`a11y.settings.ttsRateOptions.${r}`)}
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsContent() {
  const { t } = useTranslation();
  const {
    keys,
    summary,
    loading,
    error,
    refresh,
    addKey,
    toggleKey,
    updateLabel,
    removeKey,
    verifyKey,
  } = useApiKeys();
  const { providers, defaultProvider } = useProviders();
  const [refreshing, setRefreshing] = useState(false);

  const providerNames = useMemo(
    () => new Map(providers.map((p) => [p.id, p.displayName])),
    [providers],
  );

  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {/* Summary cards — TODAY-primary, lifetime as caption */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">
                {summary.totalKeys}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.summary.totalKeys")}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-emerald-400">
                {summary.activeKeys}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.summary.activeKeys")}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-purple-400">
                {summary.totalRequestsToday}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.summary.requestsToday")}
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                {t("settings.summary.lifetimeCaption", {
                  value: summary.totalUsage,
                })}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-blue-400">
                {formatNumber(summary.totalTokensToday)}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.summary.tokensToday")}
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                {t("settings.summary.lifetimeCaption", {
                  value: formatNumber(summary.totalTokens),
                })}
              </p>
            </CardContent>
          </Card>
        </div>

        {summary.datePst && (
          <p className="text-[10px] text-muted-foreground/70 text-center -mt-3">
            {t("settings.summary.resetHint", { date: summary.datePst })}
          </p>
        )}

        {/* Token usage today */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">
              {t("settings.tokenUsage.title")}
            </CardTitle>
            <CardDescription>
              {t("settings.tokenUsage.description", {
                lifetime: formatNumber(summary.totalTokens),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary.totalTokensToday <= 0 ? (
              <p className="text-sm text-muted-foreground/70 text-center py-4">
                {t("settings.tokenUsage.noUsageToday")}
              </p>
            ) : (
              <>
                <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bg-blue-500 transition-all"
                    style={{
                      width: `${(summary.totalInputTokensToday / summary.totalTokensToday) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-violet-500 transition-all"
                    style={{
                      width: `${(summary.totalOutputTokensToday / summary.totalTokensToday) * 100}%`,
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="size-2.5 rounded-full bg-blue-500" />
                    <span className="text-muted-foreground">
                      {t("settings.stats.input")}
                    </span>
                    <span className="font-medium">
                      {formatNumber(summary.totalInputTokensToday)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="size-2.5 rounded-full bg-violet-500" />
                    <span className="text-muted-foreground">
                      {t("settings.stats.output")}
                    </span>
                    <span className="font-medium">
                      {formatNumber(summary.totalOutputTokensToday)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {t("settings.tokenUsage.total")}
                    </span>
                    <span className="font-bold">
                      {formatNumber(summary.totalTokensToday)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Provider selection + per-provider model chains */}
        <ProvidersCard />

        {/* Per-model usage table */}
        <ModelUsageTable models={summary.modelUsage ?? []} />

        {/* Pool history */}
        <PoolHistoryCard />

        <Separator />

        {/* Third-party document sources */}
        <IntegrationsCard />

        <Separator />

        {/* Accessibility settings */}
        <AccessibilityCard />

        <Separator />

        {/* Keys section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="size-5 text-primary" />
              <h3 className="text-lg font-semibold">
                {t("settings.keysHeading")}
              </h3>
              {summary.cooldownKeys > 0 && (
                <Badge
                  variant="outline"
                  className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-xs"
                >
                  {t("settings.cooldownBadge", {
                    count: summary.cooldownKeys,
                  })}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                <RefreshCw
                  className={cn("size-3.5", refreshing && "animate-spin")}
                />
                {t("settings.refreshButton")}
              </Button>
              <AddKeyDialog
                onAdd={addKey}
                providers={providers}
                defaultProvider={defaultProvider}
              />
            </div>
          </div>

          {error && (
            <Card className="border-red-500/30 bg-red-500/5">
              <CardContent className="flex items-center gap-2 p-3 text-sm text-red-400">
                <AlertTriangle className="size-4 shrink-0" />
                {error}
              </CardContent>
            </Card>
          )}

          {loading && keys.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <RefreshCw className="size-5 animate-spin mr-2" />
              {t("settings.loading")}
            </div>
          ) : keys.length === 0 ? (
            <Card className="border-dashed border-2 border-border/50 bg-transparent">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Key className="size-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">
                  {t("settings.emptyState.title")}
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm">
                  {t("settings.emptyState.description")}
                </p>
                <div className="mt-4">
                  <AddKeyDialog
                    onAdd={addKey}
                    providers={providers}
                    defaultProvider={defaultProvider}
                  />
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {keys.map((k) => (
                <KeyCard
                  key={k.id}
                  apiKey={k}
                  providerName={providerNames.get(k.provider)}
                  onToggle={async () => {
                    try {
                      await toggleKey(k.id, k.status);
                    } catch (err) {
                      toast.error(
                        err instanceof Error
                          ? err.message
                          : t("settings.toggleError"),
                      );
                    }
                  }}
                  onDelete={async () => {
                    try {
                      await removeKey(k.id);
                      toast.success(t("settings.deletedKey"));
                    } catch (err) {
                      toast.error(
                        err instanceof Error
                          ? err.message
                          : t("settings.deleteError"),
                      );
                    }
                  }}
                  onRename={async (label) => {
                    try {
                      await updateLabel(k.id, label);
                      toast.success(t("settings.updatedLabel"));
                    } catch (err) {
                      toast.error(
                        err instanceof Error
                          ? err.message
                          : t("settings.renameError"),
                      );
                      throw err;
                    }
                  }}
                  onVerify={async () => (await verifyKey(k.id)).verification}
                />
              ))}
            </div>
          )}
        </div>

        {/* Model Limits Reference */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Gauge className="size-4 text-amber-400" />
              {t("settings.freeTier.title")}
            </CardTitle>
            <CardDescription>
              {t("settings.freeTier.description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                {
                  name: "gemini-2.5-flash",
                  label: "2.5 Flash",
                  rpd: 500,
                  rpm: 15,
                  tpm: "1M",
                  desc: t("settings.freeTier.bestQuality"),
                  color: "border-blue-500/30 bg-blue-500/5",
                },
                {
                  name: "gemini-2.5-flash-lite",
                  label: "2.5 Flash Lite",
                  rpd: 500,
                  rpm: 30,
                  tpm: "1M",
                  desc: t("settings.freeTier.fastest"),
                  color: "border-cyan-500/30 bg-cyan-500/5",
                },
                {
                  name: "gemini-2.0-flash",
                  label: "2.0 Flash",
                  rpd: 1500,
                  rpm: 15,
                  tpm: "4M",
                  desc: t("settings.freeTier.highestQuota"),
                  color: "border-amber-500/30 bg-amber-500/5",
                },
              ].map((m) => (
                <div
                  key={m.name}
                  className={cn("rounded-lg border p-3 space-y-2", m.color)}
                >
                  <div>
                    <p className="text-xs font-semibold">{m.label}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {m.desc}
                    </p>
                  </div>
                  <div className="space-y-1 text-[11px]">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.freeTier.requestsPerDay")}
                      </span>
                      <span className="font-mono font-semibold">{m.rpd}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.freeTier.requestsPerMin")}
                      </span>
                      <span className="font-mono font-semibold">{m.rpm}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.freeTier.tokensPerMin")}
                      </span>
                      <span className="font-mono font-semibold">{m.tpm}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-3">
              {t("settings.freeTier.note")}
            </p>
          </CardContent>
        </Card>

        {/* Info section */}
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardContent className="p-4 text-sm text-blue-300/80 space-y-2">
            <p className="font-medium text-blue-300 flex items-center gap-1.5">
              <ArrowUpDown className="size-4" />
              {t("settings.keyRotation.title")}
            </p>
            <ul className="list-disc list-inside space-y-1 text-xs">
              {(
                t("settings.keyRotation.rules", {
                  returnObjects: true,
                }) as string[]
              ).map((rule, i) => (
                <li key={i}>{rule}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
