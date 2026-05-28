# Async Robustness Audit

Infractions ranked by importance.

**Relevant config context:**
- `tsconfig.base.json`: `strict: true` (enables `useUnknownInCatchVariables`), `target: "ES2023"`
- `eslint.config.js`: `recommendedTypeChecked` (includes `no-floating-promises`, `no-misused-promises`),
  `return-await: "in-try-catch"`, `promise-function-async`
- **Test files have `disableTypeChecked`** — type-aware rules like `no-floating-promises` do NOT run in tests


## 2. Fire-and-forget promises (void) without error handling (MEDIUM-HIGH)

These pass lint because `no-floating-promises` accepts the `void` operator as explicit intent.
The lint is working as designed — the question is whether silent failure is acceptable.

| File | Line | Pattern |
|------|------|---------|
| `packages/runtime/src/index.ts` | 742 | `void this.appendLogEvent(…)` — if logging fails, error vanishes silently |
| `packages/codex/src/executor.ts` | 315 | `void match(parsed.data)…` — entire message dispatch is fire-and-forget |
| `packages/codex/src/executor.ts` | 342 | `void this.handleDynamicToolCall(session, message)` — tool call errors vanish |
| `packages/agent-runner/src/index.ts` | 222 | `void session.stop()` — stop failure is invisible |
| `packages/acp/src/index.ts` | 155 | `void session.connection.cancel(…)` — cancel failure is invisible |

The `void` satisfies the linter but most of these can fail in ways that should at minimum be logged.
No lint will catch this — it's an architectural decision about error visibility.

## 3. `.catch(() => null/undefined/"")` — errors swallowed silently (MEDIUM)

In production code this would be flagged by `no-floating-promises`, but these are all in test files
where `disableTypeChecked` means no type-aware lint runs.

| File | Line | Pattern |
|------|------|---------|
| `test/live-ssh.test.ts` | 90 | `.catch(() => null)` |
| `test/live-ssh.test.ts` | 165, 483 | `.catch(() => undefined)` |
| `test/live-ssh.test.ts` | 262, 277 | `.catch(() => "")` |
| `test/live-ssh.test.ts` | 469 | `.catch(() => null)` |
| `packages/server/src/index.ts` | 297 | `.catch(() => stream.abort())` — at least acts, but hides the error |

In tests this is arguably acceptable for cleanup, but line 90 silences a worker setup failure
that could mask real test breakage.

## 4. Promise.race for timeouts instead of AbortSignal.timeout (MEDIUM)

No lint catches this. `AbortSignal.timeout` is available at ES2023 target but is a runtime API
(Node 17.3+), not a language feature — TS won't suggest it.

| File | Line | Issue |
|------|------|-------|
| `packages/child-process/src/index.ts` | 10 | `Promise.race([promise, new Promise(reject => setTimeout(…))])` — classic timeout pattern that doesn't cancel the underlying work |
| `packages/server/test/http-server.test.ts` | 369 | `Promise.race([…, setTimeout reject])` |
| `packages/agent-runner/src/index.ts` | 227 | `Promise.race([executor.runTurn(…), abortPromise])` — this one actually has an AbortController, so it's better, but the "loser" still runs |

The `child-process/withTimeout` is the most concerning — the underlying promise continues running after the timeout rejects.

## 5. Mutable state shared across awaits (LOW-MEDIUM)

No lint catches this. `no-floating-promises` ensures the promises are acknowledged but doesn't
reason about shared mutable state.

| File | Line | Issue |
|------|------|-------|
| `packages/runtime/src/index.ts` | 722-724 | `this.pollInProgress` guard + `this.pollOnce().catch(…)` — two callers (line 724, 793) fire `pollOnce()` without awaiting, relying on the `pollInProgress` flag to coalesce. If the flag is stale, double-poll is possible. |

