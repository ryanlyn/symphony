import type { RuntimeRetryEntry } from "@symphony/runtime-events";

export class RetryScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  sync(retry: RuntimeRetryEntry | undefined, onDue: (retry: RuntimeRetryEntry) => void): void {
    if (!retry) return;
    this.clear(retry.issueId);
    const dueTime = new Date(retry.dueAt).getTime();
    // Fix: add 1ms buffer to timer delay to account for Node.js setTimeout jitter.
    // setTimeout may fire up to 1ms early, which can cause the eligibility check
    // (dueAt > now) to fail if pollOnce runs in the same millisecond the timer fires.
    // Invariant: the timer must not fire before dueAt to ensure the retry is eligible.
    const delayMs = Math.max(0, dueTime - Date.now()) + 1;
    const timer = setTimeout(() => {
      this.timers.delete(retry.issueId);
      onDue(retry);
    }, delayMs);
    // Note: intentionally NOT calling timer.unref() — unref'd timers are unreliable in certain
    // vitest/fork test environments. The timer is cleared on stop() so it will not keep processes
    // alive indefinitely.
    this.timers.set(retry.issueId, timer);
  }

  clear(issueId: string): void {
    const timer = this.timers.get(issueId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(issueId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
