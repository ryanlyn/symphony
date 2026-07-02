import { useMemo, useRef } from "react";
import { Activity, RefreshCw, AlertOctagon, Coins } from "lucide-react";

import { cn, formatNumber, formatTimestamp } from "../../../lib/utils";
import {
  SectionCard,
  Th,
  EmptyRow,
  IssueLink,
  AgentChip,
  Pill,
} from "../../../shared/components/ui";
import type { OpsState, OpsRunningEntry, OpsRetryEntry, OpsBlockedEntry } from "../api/types";

import { RecentIssues } from "./RecentIssues";

const MAX_SPARK_SAMPLES = 40;
const MAX_ATTEMPT_DOTS = 5;

interface SparkSample {
  generatedAt: string;
  running: number;
  retrying: number;
  blocked: number;
  tokens: number;
}

function Sparkline({ values, className }: { values: number[]; className: string }) {
  if (values.length < 2) return null;
  const width = 72;
  const height = 24;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 3 - ((v - min) / span) * (height - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      className={cn("absolute right-4 bottom-4 h-6 w-[72px]", className)}
      fill="none"
    >
      <polyline
        points={points}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  tint: string;
  spark: number[];
  sparkColor: string;
}

function MetricCard({ label, value, sub, icon, tint, spark, sparkColor }: MetricCardProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-card-2 to-card p-4 transition-colors hover:border-border-strong">
      <div className="flex items-center gap-2.5">
        <span className={cn("grid h-7 w-7 place-items-center rounded-lg", tint)}>{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
          {label}
        </span>
      </div>
      <div className="mt-2.5 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-faint">{sub}</div>
      <Sparkline values={spark} className={sparkColor} />
    </div>
  );
}

function AttemptDots({ attempt }: { attempt: number }) {
  const dots = Array.from({ length: MAX_ATTEMPT_DOTS }, (_, i) => i < attempt);
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      aria-label={`attempt ${attempt}`}
      title={`attempt ${attempt}`}
    >
      {dots.map((on, i) => (
        <span
          key={i}
          className={cn("h-1.5 w-1.5 rounded-[2px]", on ? "bg-accent-amber" : "bg-surface")}
        />
      ))}
      {attempt > MAX_ATTEMPT_DOTS && (
        <span className="ml-1 font-mono text-[11px] text-accent-amber">{attempt}</span>
      )}
    </span>
  );
}

const rowClass = "border-b border-border/60 last:border-b-0 hover:bg-accent/[0.03]";
const cellClass = "px-4 py-2.5 align-middle";

function RunningTable({ sessions }: { sessions: OpsRunningEntry[] }) {
  return (
    <SectionCard title="Running sessions" count={sessions.length} dotClass="bg-accent">
      {sessions.length === 0 ? (
        <EmptyRow label="No active sessions" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Issue</Th>
                <Th>Agent</Th>
                <Th>Worker</Th>
                <Th>Turns</Th>
                <Th>Tokens</Th>
                <Th>Session</Th>
                <Th>Last event</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.issue_id} className={rowClass}>
                  <td className={cellClass}>
                    <IssueLink
                      issueId={s.issue_id}
                      identifier={s.issue_identifier}
                      url={s.issue_url}
                    />
                  </td>
                  <td className={cellClass}>
                    <AgentChip kind={s.agent_kind} />
                  </td>
                  <td className={cn(cellClass, "text-muted")}>{s.worker_host ?? "local"}</td>
                  <td className={cn(cellClass, "font-mono text-[12.5px] tabular-nums")}>
                    {s.turn_count}
                  </td>
                  <td className={cn(cellClass, "font-mono text-[12.5px] tabular-nums")}>
                    {formatNumber(s.tokens.total_tokens)}
                  </td>
                  <td className={cn(cellClass, "font-mono text-[12.5px] text-faint")}>
                    {s.session_id ?? "n/a"}
                  </td>
                  <td className={cellClass}>
                    {s.last_event ? (
                      <Pill color="teal">{s.last_event}</Pill>
                    ) : (
                      <span className="text-faint">n/a</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function RetryTable({ entries }: { entries: OpsRetryEntry[] }) {
  return (
    <SectionCard title="Retry queue" count={entries.length} dotClass="bg-accent-amber">
      {entries.length === 0 ? (
        <EmptyRow label="No pending retries" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Issue</Th>
                <Th>Attempt</Th>
                <Th>Due</Th>
                <Th>Worker</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.issue_id} className={rowClass}>
                  <td className={cellClass}>
                    <IssueLink
                      issueId={e.issue_id}
                      identifier={e.issue_identifier}
                      url={e.issue_url}
                    />
                  </td>
                  <td className={cellClass}>
                    <AttemptDots attempt={e.attempt} />
                  </td>
                  <td className={cellClass}>
                    <Pill color="amber">
                      <span className="font-mono tabular-nums">{formatTimestamp(e.due_at)}</span>
                    </Pill>
                  </td>
                  <td className={cn(cellClass, "text-muted")}>{e.worker_host ?? "local"}</td>
                  <td className={cn(cellClass, "text-[12.5px] text-muted")}>{e.error ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function BlockedTable({ entries }: { entries: OpsBlockedEntry[] }) {
  return (
    <SectionCard title="Blocked issues" count={entries.length} dotClass="bg-accent-coral">
      {entries.length === 0 ? (
        <EmptyRow label="No blocked issues" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Issue</Th>
                <Th>Reason</Th>
                <Th>Worker</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.issue_id} className={rowClass}>
                  <td className={cellClass}>
                    <IssueLink
                      issueId={e.issue_id}
                      identifier={e.issue_identifier}
                      url={e.issue_url}
                    />
                  </td>
                  <td className={cellClass}>
                    <Pill color="coral">{e.label}</Pill>
                  </td>
                  <td className={cn(cellClass, "text-muted")}>{e.worker_host ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function workerCount(sessions: OpsRunningEntry[]): number {
  return new Set(sessions.map((s) => s.worker_host ?? "local")).size;
}

function nextDue(entries: OpsRetryEntry[]): string | null {
  if (entries.length === 0) return null;
  const soonest = entries.reduce((min, e) => (e.due_at < min.due_at ? e : min));
  return formatTimestamp(soonest.due_at);
}

function topBlockedReason(state: OpsState | null): string | null {
  const byReason = Object.entries(state?.blocked_by_reason ?? {});
  if (byReason.length === 0) return null;
  byReason.sort((a, b) => b[1] - a[1]);
  return byReason[0][0].replaceAll("_", " ");
}

interface OpsOverviewProps {
  state: OpsState | null;
  connected: boolean;
}

export function OpsOverview({ state }: OpsOverviewProps) {
  const running = state?.running ?? [];
  const retrying = state?.retrying ?? [];
  const blocked = state?.blocked ?? [];
  const counts = state?.counts ?? { running: 0, retrying: 0, blocked: 0 };
  const usageTotals = state?.usage_totals ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  // Rolling client-side history of stream samples backing the KPI sparklines.
  const historyRef = useRef<SparkSample[]>([]);
  const history = useMemo(() => {
    const samples = historyRef.current;
    if (state && samples[samples.length - 1]?.generatedAt !== state.generated_at) {
      samples.push({
        generatedAt: state.generated_at,
        running: state.counts.running,
        retrying: state.counts.retrying,
        blocked: state.counts.blocked,
        tokens: state.usage_totals.total_tokens,
      });
      if (samples.length > MAX_SPARK_SAMPLES) samples.splice(0, samples.length - MAX_SPARK_SAMPLES);
    }
    return [...samples];
  }, [state]);

  const workers = workerCount(running);
  const due = nextDue(retrying);
  const blockedReason = topBlockedReason(state);

  const metrics: MetricCardProps[] = [
    {
      label: "Running",
      value: counts.running.toString(),
      sub: counts.running > 0 ? `across ${workers} worker${workers === 1 ? "" : "s"}` : "all quiet",
      icon: <Activity className="h-4 w-4" />,
      tint: "bg-accent/10 text-accent",
      spark: history.map((s) => s.running),
      sparkColor: "text-accent",
    },
    {
      label: "Retrying",
      value: counts.retrying.toString(),
      sub: due ? `next due ${due}` : "queue empty",
      icon: <RefreshCw className="h-4 w-4" />,
      tint: "bg-accent-amber/10 text-accent-amber",
      spark: history.map((s) => s.retrying),
      sparkColor: "text-accent-amber",
    },
    {
      label: "Blocked",
      value: counts.blocked.toString(),
      sub: blockedReason ?? "nothing held",
      icon: <AlertOctagon className="h-4 w-4" />,
      tint: "bg-accent-coral/10 text-accent-coral",
      spark: history.map((s) => s.blocked),
      sparkColor: "text-accent-coral",
    },
    {
      label: "Total tokens",
      value: formatNumber(usageTotals.total_tokens),
      sub: `${formatNumber(usageTotals.input_tokens)} in · ${formatNumber(usageTotals.output_tokens)} out`,
      icon: <Coins className="h-4 w-4" />,
      tint: "bg-accent-cyan/10 text-accent-cyan",
      spark: history.map((s) => s.tokens),
      sparkColor: "text-accent-cyan",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard key={m.label} {...m} />
        ))}
      </div>

      <RunningTable sessions={running} />
      <RetryTable entries={retrying} />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <BlockedTable entries={blocked} />
        <RecentIssues />
      </div>
    </div>
  );
}
