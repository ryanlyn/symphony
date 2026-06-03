import { useState } from "react";
import { Code, ChevronDown } from "lucide-react";

import type { ToolCallEvent as ToolCallEventType } from "../../api/types";
import { formatTimestamp, formatDuration, cn } from "../../../../lib/utils";

interface ToolCallEventProps {
  event: ToolCallEventType;
}

export function ToolCallEvent({ event }: ToolCallEventProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "border-l-4 rounded-r-md bg-background/50 p-3",
        event.isError ? "border-accent-red" : "border-accent-orange",
      )}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left bg-transparent border-none p-0 cursor-pointer"
        aria-expanded={expanded}
        aria-label={`Toggle ${event.toolName} details`}
        onClick={() => setExpanded(!expanded)}
      >
        <Code
          aria-hidden="true"
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            event.isError ? "text-accent-red" : "text-accent-orange",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
            <span className="font-mono text-sm font-medium">{event.toolName}</span>
            {event.durationMs != null && (
              <span className="text-xs text-muted">{formatDuration(event.durationMs)}</span>
            )}
            {event.isError && (
              <span className="rounded-full bg-accent-red/20 px-1.5 py-0.5 text-xs text-accent-red">
                error
              </span>
            )}
            <ChevronDown
              className={cn(
                "ml-auto h-3 w-3 text-muted transition-transform",
                expanded && "rotate-180",
              )}
            />
          </div>
        </div>
      </button>

      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          expanded ? "mt-2 max-h-[2000px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="space-y-2 pl-6">
          <div>
            <span className="text-xs font-medium text-muted">Input</span>
            <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-background p-2 text-xs font-mono text-foreground/80">
              {JSON.stringify(event.input, null, 2)}
            </pre>
          </div>
          {event.output != null && (
            <div>
              <span className="text-xs font-medium text-muted">Output</span>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-background p-2 text-xs font-mono text-foreground/80">
                {typeof event.output === "string"
                  ? event.output
                  : JSON.stringify(event.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
