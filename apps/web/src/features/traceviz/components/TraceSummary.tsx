import type { ReactNode } from "react";
import {
  Clock,
  RotateCcw,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wrench,
  AlertTriangle,
} from "lucide-react";

import type { Stats } from "../api/types";
import { formatDuration, formatNumber, cn } from "../../../lib/utils";

interface TraceSummaryProps {
  stats: Stats;
}

interface StatCardProps {
  label: string;
  value: string;
  icon: ReactNode;
  tint: string;
}

function StatCard({ label, value, icon, tint }: StatCardProps) {
  return (
    <div className="rounded-2xl border border-border bg-gradient-to-b from-card-2 to-card p-4">
      <div className="flex items-center gap-2.5">
        <span className={cn("grid h-7 w-7 place-items-center rounded-lg", tint)} aria-hidden="true">
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
          {label}
        </span>
      </div>
      <div className="mt-2.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
    </div>
  );
}

export function TraceSummary({ stats }: TraceSummaryProps) {
  const totalToolCalls = stats.toolBreakdown.reduce((sum, v) => sum + v.count, 0);
  const totalErrors = stats.toolBreakdown.reduce((sum, v) => sum + v.errorCount, 0);

  const cards: StatCardProps[] = [
    {
      label: "Duration",
      value: formatDuration(stats.durationMs),
      icon: <Clock className="h-4 w-4" />,
      tint: "bg-accent-cyan/10 text-accent-cyan",
    },
    {
      label: "Turns",
      value: stats.totalTurns.toString(),
      icon: <RotateCcw className="h-4 w-4" />,
      tint: "bg-accent/10 text-accent",
    },
    {
      label: "Input tokens",
      value: formatNumber(stats.tokenUsage.inputTokens),
      icon: <ArrowDownToLine className="h-4 w-4" />,
      tint: "bg-accent/10 text-accent",
    },
    {
      label: "Output tokens",
      value: formatNumber(stats.tokenUsage.outputTokens),
      icon: <ArrowUpFromLine className="h-4 w-4" />,
      tint: "bg-accent-amber/10 text-accent-amber",
    },
    {
      label: "Tool calls",
      value: totalToolCalls.toString(),
      icon: <Wrench className="h-4 w-4" />,
      tint: "bg-surface text-muted",
    },
    {
      label: "Errors",
      value: totalErrors.toString(),
      icon: <AlertTriangle className="h-4 w-4" />,
      tint: totalErrors > 0 ? "bg-accent-coral/10 text-accent-coral" : "bg-surface text-faint",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <StatCard key={card.label} {...card} />
      ))}
    </div>
  );
}
