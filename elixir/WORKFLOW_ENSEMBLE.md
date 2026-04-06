---
tracker:
  kind: linear
  project_slug: "symphony-414bf2e49ff2"
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: ~/dev/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/openai/symphony .
    if command -v mise >/dev/null 2>&1; then
      cd elixir && mise trust && mise exec -- mix deps.get
    fi
  before_remove: |
    cd elixir && mise exec -- mix workspace.before_remove
agent:
  kind: claude
  max_concurrent_agents: 10
  max_turns: 20
  ensemble_size: 3
codex:
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high --config service_tier=fast --model gpt-5.4 app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
    networkAccess: true
claude:
  command: claude
  model: claude-opus-4-6[1m]
  permission_mode: bypassPermissions
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  strict_mcp_config: true
  mcp_server_python: python3
---

You are working on a Linear ticket `{{ issue.identifier }}`

{% if ensemble.enabled %}
Ensemble context:

- You are slot `{{ ensemble.slot_index }}` of `{{ ensemble.size }}` concurrent agents working the same ticket.
- Shared side effects can race. Symphony will not coordinate them for you.
- Use unique slot-scoped names for branches, local notes, temporary files, screenshots, and any draft artifacts.
- Before any shared mutation, re-fetch the latest state and decide again.
{% endif %}

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions or secrets.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth, permissions, or secrets). If blocked, leave a concise durable note in the tracker and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".
4. Work only in the provided repository copy. Do not touch any other path.

## Linear access

The agent should be able to talk to Linear, either via a configured Linear MCP server or injected `linear_graphql` tool. If neither is present, stop and ask the operator to configure Linear.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Spend extra effort up front on planning, reproduction, and verification design before implementation.
- Reproduce first: confirm the current behavior or issue signal before changing code so the fix target is explicit.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Keep ticket metadata current when doing so is still useful after a fresh re-read.
- Move state only when the matching quality bar is met.
- Treat equivalent already-done outcomes as success instead of as failures.

## Ensemble operating rules

- The orchestrator only dispatches slots. It does not coordinate your side effects.
- Re-fetch before every shared mutation:
  - Linear issue state changes
  - shared issue comments
  - PR creation, PR body edits, PR label edits, and PR state changes
  - branch pushes to any non-unique branch name
- If the desired mutation already happened and is materially equivalent, treat that as success and continue.
- Prefer unique slot-scoped branch names such as `slot-{{ ensemble.slot_index }}-<topic>` when `ensemble.enabled` is true.
- Prefer local workspace notes over shared tracker comments while work is still volatile.
- If you update a shared comment, re-read the latest version first and preserve useful newer content instead of overwriting blindly.
- Avoid deleting or force-rewriting another slot's visible artifacts unless they are clearly obsolete and your replacement is better after a fresh re-read.
- When in doubt, choose the action that is safe, additive, and easy for another slot or a human to understand.

## Related skills

- `symphony-linear`: interact with Linear.
- `symphony-commit`: produce clean, logical commits during implementation.
- `simplify`: review changed code for reuse, quality, and efficiency before committing.
- `symphony-push`: keep remote branch current and publish updates.
- `symphony-pull`: keep branch updated with latest `origin/main` before handoff.
- `symphony-land`: when ticket reaches `Merging`, explicitly open and follow `.codex/skills/symphony-land/SKILL.md`, which includes the `land` loop.

## Status map

- `Backlog` -> out of scope for this workflow; do not modify.
- `Todo` -> queued; transition to `In Progress` before active work if that still reflects the latest issue state after a re-read.
- `In Progress` -> implementation actively underway.
- `Human Review` -> PR is attached and validated; waiting on human approval.
- `Merging` -> approved by human; execute the `symphony-land` skill flow. Do not call `gh pr merge` directly.
- `Rework` -> reviewer requested changes; planning and implementation required.
- `Done` -> terminal state; no further action required.

## Execution flow

1. Fetch the issue by explicit ticket ID and read its current state, comments, labels, attachments, and linked PR state.
2. Route to the matching flow for the latest observed state.
3. Determine the current repo state (`branch`, `git status`, `HEAD`) and capture a concrete reproduction signal before implementation.
4. Run the `symphony-pull` skill before code edits unless the workspace is already clearly based on the latest `origin/main`.
5. Implement against the current understanding of the ticket and keep durable tracker updates concise and revalidated.
6. Run validation that directly proves the changed behavior.
7. Before every `git commit`, run the `simplify` skill. Then use `symphony-commit` to commit and `symphony-push` to push.
8. Before any shared mutation near handoff, re-fetch issue and PR state again and confirm the action is still needed.
9. Only move to `Human Review` when the latest observed state, code, validation, and PR feedback all support it.

## Shared-resource race handling

- If another slot already created a PR, reuse it if that is clearly the best path after re-reading it.
- If another slot already posted the essential comment or state transition you intended, do not duplicate it unless your update adds new durable information.
- If two valid paths exist, prefer the one that minimizes destructive edits to shared resources.
- If you encounter conflicting concurrent work, document the conflict clearly in the most appropriate shared place and continue with the safest recoverable path.

## Human Review and merge handling

1. When the issue is in `Human Review`, do not code or change ticket content unless the latest review feedback clearly requires rework.
2. Poll for updates as needed, including GitHub PR review comments from humans and bots.
3. If review feedback requires changes, move the issue to `Rework` if needed and follow the rework flow.
4. If approved, human moves the issue to `Merging`.
5. When the issue is in `Merging`, open and follow `.codex/skills/symphony-land/SKILL.md`, then run the `symphony-land` skill in a loop until the PR is merged. Do not call `gh pr merge` directly.
6. After merge is complete, move the issue to `Done` if that transition is still needed after a fresh re-read.
