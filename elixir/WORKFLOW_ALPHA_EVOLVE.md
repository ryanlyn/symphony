---
tracker:
  kind: linear
  project_slug: "symphony-414bf2e49ff2"
  active_states:
    - Todo
    - In Progress
    - Agent Review
    - Human Review
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
    git clone --depth 1 https://github.com/ryanlyn/symphony .
    if command -v mise >/dev/null 2>&1; then
      cd elixir && mise trust && mise exec -- mix deps.get
    fi
  before_remove: |
    cd elixir && mise exec -- mix workspace.before_remove
agent:
  kind: codex
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
Independent agent context:

- You are agent slot `{{ ensemble.slot_index }}` of `{{ ensemble.size }}` working this ticket independently.
- Work only in your own workspace. Do not read or edit another slot's workpad.
- Use naming that includes `{{ issue.identifier }}-{{ ensemble.slot_index }}` for branches, PRs, and your workpad header.
{% endif %}

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }}. Resume from current workspace state.
- Do not repeat completed work unless needed for new changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions, auth, or secrets.
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
2. Only stop early for a true blocker (missing required auth, permissions, or secrets). If blocked, record it in the workpad and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: Linear MCP or `linear_graphql` tool is available

The agent should be able to talk to Linear, either via a configured Linear MCP server or injected `linear_graphql` tool. If none are present, stop and ask the user to configure Linear.

## Search strategy

Treat the ticket as a search problem, not a single-shot task.

1. Before implementing, sketch 2-3 materially different approaches in the workpad `Approaches` section. For each, note: hypothesis, expected correctness, blast radius, and validation cost.
2. Pick the highest-scoring approach. Implement it.
3. Validate in stages: compile/lint first, then targeted behavioral proof, then broader suite. Stop early if a stage fails.
4. If the chosen approach fails validation or stalls, switch to the next approach rather than patching indefinitely. Record why in the workpad.
5. When validation passes, record the winning approach and why alternatives were dropped.

{% if ensemble.enabled %}
Each ensemble slot works independently. Diversity comes from independent exploration, not coordination. Do not divide work or share plans with other slots during `In Progress`.
{% endif %}

## Default posture

- Determine the ticket's current status, then follow the matching flow.
- Open the tracking workpad and bring it up to date before new implementation work.
- Reproduce first: confirm the current behavior or issue signal before changing code.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Use the workpad comment as the single source of truth for progress. Do not post separate summary comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input.
- When out-of-scope improvements are discovered, file a separate Backlog issue rather than expanding scope.
- Move status only when the matching quality bar is met.
- Operate autonomously unless blocked by missing requirements, secrets, or permissions.

## Related skills

- `symphony-linear`: interact with Linear.
- `symphony-commit`: produce clean, logical commits during implementation.
- `simplify`: review changed code for reuse, quality, and efficiency before committing.
- `symphony-push`: keep remote branch current and publish updates.
- `symphony-pull`: keep branch updated with latest `origin/main` before handoff.
- `symphony-land`: when ticket reaches `Merging`, explicitly open and follow `.codex/skills/symphony-land/SKILL.md`, which includes the `land` loop.

## Status map

- `Backlog` -> out of scope for this workflow; do not modify.
- `Todo` -> queued; immediately transition to `In Progress` before active work.
  - If a PR is already attached, run the full PR feedback sweep before new feature work.
- `In Progress` -> implementation actively underway.
- `Agent Review` -> stop feature work; review and select the best candidate with a bias toward merging.
- `Human Review` -> exception-only path for ambiguous selection, risk acceptance, or external blockers.
- `Merging` -> execute the `symphony-land` skill flow (do not call `gh pr merge` directly).
- `Rework` -> the selected candidate needs another implementation pass.
- `Done` -> terminal state; no further action required.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route to the matching flow:
   - `Backlog` -> do not modify; stop.
   - `Todo` -> move to `In Progress`, create workpad, start execution.
   - `In Progress` -> continue execution from current workpad.
   - `Agent Review` -> run review protocol.
   - `Human Review` -> wait and poll.
   - `Merging` -> open and follow `.codex/skills/symphony-land/SKILL.md`.
   - `Rework` -> run rework flow.
   - `Done` -> shut down.
4. If a branch PR exists and is `CLOSED` or `MERGED`, create a fresh branch from `origin/main` and restart.
5. For `Todo` tickets, sequence: move to `In Progress` -> find/create workpad -> begin work.

## Step 1: Start or continue execution (Todo or In Progress)

1. Find or create the live workpad comment:
{% if ensemble.enabled %}
   - Marker header: `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}`.
{% else %}
   - Marker header: `## Codex Workpad`.
{% endif %}
   - Ignore resolved comments. Reuse an existing active workpad if found; create one if not.
2. Reconcile the workpad: check off completed items, expand the plan, verify acceptance criteria match the ticket.
3. Add a compact environment stamp: `<host>:<abs-workdir>@<short-sha>`.
4. Write or update the hierarchical plan.
5. Write or update the `Approaches` section per the search strategy above.
6. Capture a reproduction signal and record it in `Notes`.
7. Run the `symphony-pull` skill and record the result in `Notes`.

## PR feedback sweep protocol (required)

When a ticket has an attached PR, run this before moving to `Agent Review`:

1. Gather feedback: top-level PR comments, inline review comments, review summaries.
2. Treat every actionable comment as blocking until addressed in code or pushed back with justification.
3. Update the workpad with each feedback item and its resolution.
4. Re-run validation after feedback-driven changes.
5. Repeat until no actionable comments remain.

## Blocked-access escape hatch

Use only when blocked by missing required tools, auth, or permissions that cannot be resolved in-session.

- GitHub access is not a valid blocker. Try fallback strategies first.
- If truly blocked:
  - Update the workpad, set status to `Status: BLOCKED`.
  - Add a blocker brief: what is missing, why it blocks, exact human action needed.
{% if ensemble.enabled %}
  - Re-read all ensemble workpads. Move the ticket only when all workpads are terminal (`COMPLETE` or `BLOCKED`) and at least one is `BLOCKED`.
{% else %}
  - Move the ticket to `Human Review`.
{% endif %}

## Step 2: Execution phase (In Progress -> Agent Review)

1. Verify repo state and that the pull result is recorded in the workpad.
2. If state is `Todo`, move to `In Progress`.
3. Implement the chosen approach from the `Approaches` section.
   - Check off completed work immediately.
   - If the approach stalls, switch to the next one per search strategy.
{% if ensemble.enabled %}
   - Stay independent from other slots during `In Progress`.
{% endif %}
4. Validate in stages:
   - Stage 1: compile, lint, type-check (cheap, fast).
   - Stage 2: targeted test or behavioral proof for the specific change.
   - Stage 3: broader test suite, only if stages 1-2 pass.
5. Re-check acceptance criteria.
6. Before every commit, run the `simplify` skill. Then `symphony-commit` and `symphony-push`.
7. Attach PR to the issue. Ensure the PR has label `symphony`.
8. Update the workpad with final status.
9. Before moving to a later state:
   - Add `Status: COMPLETE` or `Status: BLOCKED` to your workpad.
{% if ensemble.enabled %}
   - Re-read all ensemble workpads.
   - Move to `Agent Review` only when all workpads are `Status: COMPLETE`.
   - Move to `Human Review` only when all workpads are terminal and at least one is `BLOCKED`.
   - Otherwise leave the ticket state unchanged.
{% else %}
   - Move to `Agent Review` if complete, `Human Review` if blocked.
{% endif %}
10. Before moving to `Agent Review`:
    - Run the full PR feedback sweep.
    - Confirm PR checks are green.
    - Confirm all required validation items are marked complete in the workpad.

## Step 3: Agent Review

1. Do not do new feature work.
{% if ensemble.enabled %}
2. Read all ensemble workpads and PRs. Compare the candidates on:
{% else %}
2. Review the implementation on:
{% endif %}
   - correctness and ticket fit,
   - validation quality and proof strength,
   - blast radius and maintainability,
   - performance where relevant.
3. Severity rubric:
   - `P0` -> catastrophic merge blocker (data loss, security, repo-breaking).
   - `P1` -> serious merge blocker (wrong problem, missing proof, regressions, failing checks).
   - `P2` -> should not block merging.
   - `P3` -> optional polish.
4. If no `P0`/`P1` findings and checks are green{% if ensemble.enabled %} on the best candidate{% endif %}, move to `Merging`.
5. If the direction is clear but needs autonomous fixes, move to `Rework` with a concise blocker summary.
6. If selection is ambiguous or risk acceptance is needed, move to `Human Review` with an escalation brief.
7. File separate Backlog issues for meaningful `P2`/`P3` findings rather than expanding scope.

## Step 4: Human Review

1. Do not code or change ticket content.
2. Poll for updates and PR review comments.
3. If feedback requires changes, move to `Rework`.
4. If approved, move or wait for the issue to move to `Merging`.

## Step 5: Merging

1. Open and follow `.codex/skills/symphony-land/SKILL.md`. Do not call `gh pr merge` directly.
{% if ensemble.enabled %}
2. Close superseded candidate PRs after the winning PR is merged.
{% endif %}
3. After merge, move to `Done`.

## Step 6: Rework

1. Treat as a full reset, not incremental patching.
2. Re-read the issue and all review feedback. Identify what must change.
3. Close the existing PR. Remove the workpad comment.
4. Create a fresh branch from `origin/main`.
5. Start the normal kickoff flow with a new workpad.

## Completion bar before Agent Review

- Workpad checklist is complete and accurate.
- Acceptance criteria and ticket-provided validation items are complete.
- Validation is green for the latest commit.
- PR feedback sweep is complete with no actionable comments.
- PR checks are green, branch is pushed, PR is linked on the issue with label `symphony`.
- The `Approaches` section records the chosen approach and why alternatives were dropped.
{% if ensemble.enabled %}
- All ensemble workpads are `Status: COMPLETE`.
{% endif %}

## Completion bar before blocked Human Review

- Workpad contains `Status: BLOCKED` with a blocker brief.
{% if ensemble.enabled %}
- All ensemble workpads are terminal (`COMPLETE` or `BLOCKED`), at least one `BLOCKED`.
{% endif %}

## Guardrails

- If the branch PR is closed or merged, do not reuse it; create a fresh branch.
- If issue state is `Backlog`, do not modify it.
- Do not edit the issue body for planning or progress.
{% if ensemble.enabled %}
- One workpad per slot: `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}`. Do not edit another slot's workpad.
- A workpad is in progress until it contains `Status: COMPLETE` or `Status: BLOCKED`.
{% else %}
- One workpad per issue: `## Codex Workpad`.
{% endif %}
- Temporary proof edits must be reverted before commit.
- Do not move to `Agent Review` unless the completion bar is satisfied.
- In `Agent Review`, no new feature work. In `Human Review`, no changes.
- If terminal (`Done`), shut down.

## Workpad template

````md
## Codex Workpad{% if ensemble.enabled %} - {{ issue.identifier }} {{ ensemble.slot_index }}{% endif %}

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task

### Approaches

| Approach | Hypothesis | Correctness | Blast radius | Validation cost | Status |
|----------|-----------|-------------|--------------|-----------------|--------|
| A        |           |             |              |                 |        |
| B        |           |             |              |                 |        |

Chosen: (name) because (reason). Dropped: (names) because (reasons).

### Acceptance Criteria

- [ ] Criterion 1

### Validation

- [ ] stage 1: compile/lint `<command>`
- [ ] stage 2: targeted test `<command>`
- [ ] stage 3: broader suite `<command>`

### Notes

- <progress note with timestamp>

### Confusions

- <only when something was confusing>

### Agent Reviews

- <review notes with timestamps>
````

When complete: `Status: COMPLETE`
When blocked: `Status: BLOCKED`
