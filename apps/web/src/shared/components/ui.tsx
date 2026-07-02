import { ExternalLink } from "lucide-react";

import { cn } from "../../lib/utils";

import { SafeExternalLink } from "./SafeExternalLink";

/** Bordered section container with a colored marker, title, and count badge. */
export function SectionCard({
  title,
  count,
  dotClass,
  children,
}: {
  title: string;
  count: number;
  dotClass: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className={cn("h-2 w-2 rounded-[3px]", dotClass)} />
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        <span className="rounded-full bg-surface px-2 py-px text-[11px] tabular-nums text-muted">
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="bg-surface/40 px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
      {children}
    </th>
  );
}

export function EmptyRow({ label }: { label: string }) {
  return <div className="px-4 py-6 text-center text-sm text-faint">{label}</div>;
}

/** Mono issue identifier linking to its trace, with an optional tracker link. */
export function IssueLink({
  issueId,
  identifier,
  url,
}: {
  issueId: string;
  identifier: string;
  url: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <a
        href={`#/trace/${encodeURIComponent(issueId)}`}
        className="font-mono text-[12.5px] font-medium text-accent hover:underline"
        title="View trace"
      >
        {identifier}
      </a>
      {url && (
        <SafeExternalLink
          href={url}
          omitUnsafe
          className="inline-flex items-center text-faint transition-colors hover:text-foreground"
          title="Open in tracker"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </SafeExternalLink>
      )}
    </div>
  );
}

export function AgentChip({ kind }: { kind: string }) {
  const isClaude = kind.toLowerCase().includes("claude");
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-mono text-[11px]",
        isClaude
          ? "bg-accent-amber/10 text-accent-amber shadow-[inset_0_0_0_1px_rgba(242,163,60,0.25)]"
          : "bg-accent-cyan/10 text-accent-cyan shadow-[inset_0_0_0_1px_rgba(76,192,224,0.25)]",
      )}
    >
      {kind}
    </span>
  );
}

export function Pill({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "teal" | "amber" | "coral";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px]",
        color === "teal" && "bg-accent/10 text-accent",
        color === "amber" && "bg-accent-amber/10 text-accent-amber",
        color === "coral" && "bg-accent-coral/10 text-accent-coral",
      )}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {children}
    </span>
  );
}
