import { useState } from "react";
import { Brain, ChevronDown } from "lucide-react";

import type { ThoughtEvent as ThoughtEventType } from "../../api/types";
import { formatTimestamp, cn } from "../../../../lib/utils";
import { Markdown } from "../Markdown";

interface ThoughtEventProps {
  event: ThoughtEventType;
}

export function ThoughtEvent({ event }: ThoughtEventProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = event.text.length > 200;

  return (
    <div className="border-l-4 border-accent-purple rounded-r-md bg-background/50 p-3">
      {isLong ? (
        <button
          type="button"
          className="flex w-full items-start gap-2 text-left bg-transparent border-none p-0 cursor-pointer"
          aria-expanded={expanded}
          aria-label="Toggle thought details"
          onClick={() => setExpanded(!expanded)}
        >
          <Brain aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
              <ChevronDown
                className={cn("h-3 w-3 text-muted transition-transform", expanded && "rotate-180")}
              />
            </div>
            <div className={cn("mt-1", !expanded && "line-clamp-3")}>
              <Markdown className="text-sm italic text-foreground/80">{event.text}</Markdown>
            </div>
          </div>
        </button>
      ) : (
        <div className="flex items-start gap-2">
          <Brain aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
            </div>
            <div className="mt-1">
              <Markdown className="text-sm italic text-foreground/80">{event.text}</Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
