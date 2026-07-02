import { MessageSquare } from "lucide-react";

import type { MessageEvent as MessageEventType } from "../../api/types";
import { formatTimestamp } from "../../../../lib/utils";
import { Markdown } from "../Markdown";

interface MessageEventProps {
  event: MessageEventType;
}

export function MessageEvent({ event }: MessageEventProps) {
  return (
    <div className="border-l-2 border-accent-cyan rounded-r-lg bg-background/50 p-3">
      <div className="flex items-start gap-2">
        <MessageSquare aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" />
        <div className="min-w-0 flex-1">
          <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
          <Markdown className="mt-1 text-sm">{event.text}</Markdown>
        </div>
      </div>
    </div>
  );
}
