import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/config/i18n";
import { cn } from "@/lib/utils";
import { useApiKeys, useKeyUsageHistory } from "@/features/api-keys";
import type {
  DailyUsageEntry,
  GeminiApiKey,
  ModelSummary,
  ModelUsageStats,
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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
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
} from "lucide-react";

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

function KeyStatusBadge({ status }: { status: GeminiApiKey["status"] }) {
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

function AddKeyDialog({
  onAdd,
}: {
  onAdd: (key: string, label: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);

  async function handleSubmit() {
    if (!key.trim()) return;
    setAdding(true);
    try {
      await onAdd(key.trim(), label.trim());
      setKey("");
      setLabel("");
      setOpen(false);
      toast.success(t("settings.addKeySuccess"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.addKeyError"),
      );
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            <Label htmlFor="api-key">{t("settings.apiKeyLabel")}</Label>
            <Input
              id="api-key"
              type="password"
              placeholder="AIzaSy..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
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
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">
              {t("settings.addKeyDialog.cancelButton")}
            </Button>
          </DialogClose>
          <Button onClick={handleSubmit} disabled={!key.trim() || adding}>
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
                  {t("settings.modelUsage.headers.requests")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.headers.input")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.headers.output")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.totalTokens")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">
                  {t("settings.modelUsage.headers.todayRpd")}
                </th>
                <th className="pb-2 px-3 font-medium text-right">RPD</th>
                <th className="pb-2 px-3 font-medium text-right">RPM</th>
                <th className="pb-2 pl-3 font-medium text-right">TPM</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const color = modelColors[m.model] || "text-foreground";
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
                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                      {m.requests > 0 ? (
                        <span className="text-foreground">{m.requests}</span>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                      {m.inputTokens > 0 ? (
                        <span className="text-blue-400">
                          {formatNumber(m.inputTokens)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                      {m.outputTokens > 0 ? (
                        <span className="text-violet-400">
                          {formatNumber(m.outputTokens)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-xs font-semibold">
                      {m.totalTokens > 0 ? (
                        formatNumber(m.totalTokens)
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <TodayVsRpdCell
                        requestsToday={m.requestsToday}
                        rpd={m.limits?.rpd ?? 0}
                      />
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {m.limits ? (
                        <span className="text-xs text-muted-foreground">
                          {m.limits.rpd}
                          {t("settings.rateLimit.perDay")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">
                          -
                        </span>
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
  apiKey: GeminiApiKey;
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
  onToggle,
  onDelete,
  onRename,
}: {
  apiKey: GeminiApiKey;
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRename: (label: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(apiKey.label);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
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
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={handleSaveLabel}
                  >
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
              <KeyStatusBadge status={apiKey.status} />
            </div>

            {/* Masked key */}
            <p className="font-mono text-xs text-muted-foreground truncate">
              {apiKey.key}
            </p>

            {/* Stats row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Zap className="size-3 text-blue-400" />
                <strong className="text-foreground">
                  {formatNumber(totalTokens)}
                </strong>{" "}
                {t("settings.stats.tokens")}
              </span>
              <span className="flex items-center gap-1">
                <Activity className="size-3 text-purple-400" />
                <strong className="text-foreground">
                  {apiKey.usageCount}
                </strong>{" "}
                {t("settings.stats.requests")}
              </span>
              {apiKey.errorCount > 0 && (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="size-3 text-red-400" />
                  <strong className="text-red-400">
                    {apiKey.errorCount}
                  </strong>{" "}
                  {t("settings.stats.errors")}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {timeAgo(apiKey.lastUsedAt)}
              </span>
            </div>

            {/* Token breakdown bar */}
            {totalTokens > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>
                    {t("settings.stats.input")}:{" "}
                    {formatNumber(apiKey.totalInputTokens)}
                  </span>
                  <span>
                    {t("settings.stats.output")}:{" "}
                    {formatNumber(apiKey.totalOutputTokens)}
                  </span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bg-blue-500 transition-all"
                    style={{
                      width: `${(apiKey.totalInputTokens / totalTokens) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-violet-500 transition-all"
                    style={{
                      width: `${(apiKey.totalOutputTokens / totalTokens) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

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
                className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                onClick={() => setHistoryOpen(true)}
                aria-label={t("settings.history.buttonLabel")}
              >
                <History className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 className="size-3.5" />
              </Button>
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

// ─── Main Page ───────────────────────────────────────────────────────────────

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
  } = useApiKeys();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {/* Summary cards */}
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
              <div className="text-2xl font-bold text-blue-400">
                {formatNumber(summary.totalTokens)}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.summary.totalTokens")}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/50 bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-purple-400">
                {summary.totalUsage}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.summary.totalRequests")}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Token breakdown */}
        {summary.totalTokens > 0 && (
          <Card className="border-border/50 bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                {t("settings.tokenUsage.title")}
              </CardTitle>
              <CardDescription>
                {t("settings.tokenUsage.description")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-blue-500 transition-all"
                  style={{
                    width: `${(summary.totalInputTokens / summary.totalTokens) * 100}%`,
                  }}
                />
                <div
                  className="bg-violet-500 transition-all"
                  style={{
                    width: `${(summary.totalOutputTokens / summary.totalTokens) * 100}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="size-2.5 rounded-full bg-blue-500" />
                  <span className="text-muted-foreground">
                    {t("settings.stats.input")}
                  </span>
                  <span className="font-medium">
                    {formatNumber(summary.totalInputTokens)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="size-2.5 rounded-full bg-violet-500" />
                  <span className="text-muted-foreground">
                    {t("settings.stats.output")}
                  </span>
                  <span className="font-medium">
                    {formatNumber(summary.totalOutputTokens)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {t("settings.tokenUsage.total")}
                  </span>
                  <span className="font-bold">
                    {formatNumber(summary.totalTokens)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Per-model usage table */}
        <ModelUsageTable models={summary.modelUsage ?? []} />

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
                onAdd={async (key, label) => {
                  await addKey(key, label);
                }}
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
                    onAdd={async (key, label) => {
                      await addKey(key, label);
                    }}
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
