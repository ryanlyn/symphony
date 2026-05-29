---
tracker:
  kind: local
  path: .symphony/board
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  dispatch:
    accept_unrouted: true
    only_routes: null
    route_label_prefix: "Symphony:"
polling:
  interval_ms: 5000
workspace:
  root: ~/dev/symphony-workspaces
worker:
  ssh_timeout_ms: 60000
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
codex:
  command: >
    codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high --model gpt-5.4 app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - /Users/ryan/dev/symphony-workspaces
    networkAccess: true
claude:
  command: claude
  model: claude-opus-4-6[1m]
  permission_mode: dontAsk
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  strict_mcp_config: true
---

You are working on a local board issue `{{ issue.identifier }}`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the issue is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
  {% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record it in the issue via `local_comment` and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Tracker: local Markdown board

This workflow is backed by a **local board**, not Linear. There is **no Linear and no `linear_graphql` tool**. Issues live as Markdown files on disk under the board directory configured in `tracker.path` (default `.symphony/board/`).

- Each issue is a Markdown file named `BOARD-<n>.md` (for example `.symphony/board/BOARD-7.md`).
- The issue's status, title, and metadata live in the file's YAML frontmatter (for example `status: Todo`).
- The Markdown body below the frontmatter is the issue description.
- Comments are appended to the issue file by the `local_comment` tool; treat the most recent comment block as the live workpad/progress log.

Active statuses (`Todo`, `In Progress`) mean the issue is yours to work. Terminal statuses (`Done`, `Cancelled`) mean it is finished and you must not reopen it.

## Available tools

You have exactly three board write tools. Use them via their tool names:

- `local_update_status` - move an issue to a new status. Args: `issueId`, `status`. Example: set `BOARD-7` to `In Progress` before you start, then to `Done` when complete.
- `local_comment` - append a progress note / comment to an issue. Args: `issueId`, `body`. Use this as your single running workpad.
- `local_create_issue` - create a new board issue for genuinely out-of-scope follow-up work. Args: `title`, optional `body`, optional `status`.

There is **no `linear_graphql`** tool and no Linear MCP server. Do not attempt to call Linear. Do not stop because "Linear is not configured" - this workflow never uses Linear.

## Default posture

- Start by reading the issue's current status, then follow the matching flow for that status.
- Keep a single running workpad by appending updates with `local_comment`; do not scatter many short comments.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: confirm the current behavior/issue signal before changing code so the fix target is explicit.
- Move status only when the matching quality bar is met (use `local_update_status`).
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- When meaningful out-of-scope improvements are discovered, file a separate board issue with `local_create_issue` (clear title, description, acceptance criteria) instead of expanding scope.

## Related skills

- `symphony-commit`: produce clean, logical commits during implementation.
- `simplify`: review changed code for reuse, quality, and efficiency before committing.
- `symphony-push`: keep remote branch current and open/update the pull request.
- `symphony-pull`: keep branch updated with latest `origin/main` before handoff.
- `symphony-land`: when the work is approved, follow the `land` loop to merge the PR.

## Status map

- `Todo` -> queued; immediately transition to `In Progress` with `local_update_status` before active work.
- `In Progress` -> implementation actively underway.
- `Done` -> terminal; no further action required.
- `Cancelled` -> terminal; do not reopen or modify.

## Step 0: Determine current status and route

1. Read the issue file (`BOARD-<n>.md`) and its frontmatter `status`.
2. Route to the matching flow:
   - `Todo` -> call `local_update_status(issueId, "In Progress")`, then start the execution flow.
   - `In Progress` -> continue the execution flow from the latest workpad comment.
   - `Done` / `Cancelled` -> do nothing and shut down.
3. If a PR already exists for the current branch and it is `CLOSED` or `MERGED`, treat prior branch work as non-reusable. Create a fresh branch from `origin/main` and restart the execution flow.

## Step 1: Start / continue execution

1. Establish a single running workpad: append a `local_comment` with a hierarchical plan and acceptance criteria in checklist form. Reuse and update it on each milestone rather than posting new comments.
2. If arriving from `Todo`, ensure the issue is already `In Progress` (you moved it in Step 0).
3. Add a compact environment stamp at the top of the workpad as a code fence line: `<host>:<abs-workdir>@<short-sha>`.
4. Capture a concrete reproduction signal and record it in the workpad before implementing.
5. Run the `symphony-pull` skill to sync with latest `origin/main` before code edits, and record the result in the workpad.

## Step 2: Implement and validate

1. Implement against the plan, checking off completed items in the workpad via `local_comment` updates.
2. Run validation/tests/proof-of-work for the scope. Prefer a targeted proof that demonstrates the behavior you changed.
3. Re-check all acceptance criteria and close any gaps.
4. Before every `git commit`, run the `simplify` skill, then the `symphony-commit` skill to commit and `symphony-push` to push and open/update the PR.
5. Update the workpad with the final checklist status and validation notes via `local_comment`.

## Step 3: Complete

1. When implementation is complete, validated, and the PR is open and green, move the issue to `Done` with `local_update_status(issueId, "Done")`.
2. If the work is abandoned for a legitimate reason, move it to `Cancelled` and record why in the workpad.

## Completion bar before Done

- Plan/acceptance/validation checklist is complete and reflected in the workpad.
- Validation/tests are green for the latest commit.
- PR is pushed, linked in the workpad, and checks are green.

## Guardrails

- Never call Linear or `linear_graphql`; this board is local-only.
- If the branch PR is already closed/merged, create a new branch from `origin/main` and restart from reproduction/planning.
- Do not modify terminal (`Done`/`Cancelled`) issues.
- Use `local_comment` as the single running workpad; do not edit the issue description for progress tracking.
- If out-of-scope improvements are found, create a separate board issue with `local_create_issue` rather than expanding current scope.
- If blocked by missing required tools/auth, append one blocker comment via `local_comment` describing the blocker, its impact, and the next unblock action.

## Workpad template

Use this structure for the running workpad comment and keep it updated in place:

````md
## Symphony Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>
````
