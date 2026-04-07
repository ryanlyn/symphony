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
    git clone --depth 1 https://github.com/ryanlyn/symphony .
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
  command: >
    codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high --model gpt-5.4 app-server
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

- You are independent agent `{{ ensemble.slot_index }}` out of `{{ ensemble.size }}` agents working the same ticket.
- Come up with independent work on the ticket yourself. Do not collaborate with other agents.
- Work only within your own dedicated workspace.
- Your agent identifier is `{{ issue.identifier }} {{ ensemble.slot_index }}`.
- Use that identifier in naming for your branch, PR, and workpad.
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
2. Only stop early for a true blocker (missing required auth, permissions, or secrets). If blocked, record it in your workpad and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: Linear MCP or `linear_graphql` tool is available

The agent should be able to talk to Linear, either via a configured Linear MCP server or injected `linear_graphql` tool. If none are present, stop and ask the user to configure Linear.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Start every task by opening your own tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior or issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat your own persistent Linear workpad comment as the source of truth for your progress.
- Use your own workpad comment for all progress and handoff notes; do not post separate "done" or summary comments.
- Do not use local notes as your primary progress log. Workpads must stay visible, tracked, and persistent on the ticket.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input: mirror it in your workpad and execute it before considering your work complete.
- When meaningful out-of-scope improvements are discovered during execution,
  file a separate Linear issue instead of expanding scope. The follow-up issue
  must include a clear title, description, and acceptance criteria, be placed in
  `Backlog`, be assigned to the same project as the current issue, link the
  current issue as `related`, and use `blockedBy` when the follow-up depends on
  the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers (missing required tools/auth) after exhausting documented fallbacks.

## Independent agent rules

- You are independent. Do not coordinate plans or divide work with other agents.
- Assume duplicated work is acceptable.
- Your dedicated workspace is your own workspace for this ticket run.
- Use naming that includes your agent identifier `{{ issue.identifier }} {{ ensemble.slot_index }}`:
  - branch names should include `{{ issue.identifier }}-{{ ensemble.slot_index }}`
  - PR titles should include `{{ issue.identifier }} {{ ensemble.slot_index }}`
  - your workpad header must include your agent identifier
- Shared side effects exist on the Linear ticket itself:
  - ticket state
  - ticket comments
  - ticket attachments or links
- Before changing the Linear ticket, re-read the latest relevant ticket state and comments.

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
- `In Progress` -> implementation actively underway.
- `Human Review` -> PR is attached and validated; waiting on human approval.
- `Merging` -> approved by human; execute the `symphony-land` skill flow (do not call `gh pr merge` directly).
- `Rework` -> reviewer requested changes; planning + implementation required.
- `Done` -> terminal state; no further action required.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route to the matching flow:
   - `Backlog` -> do not modify issue content/state; stop and wait for human to move it to `Todo`.
   - `Todo` -> optimistically attempt to move to `In Progress`, then ensure your own bootstrap workpad comment exists (create if missing), then start execution flow.
   - `In Progress` -> continue execution flow from your own scratchpad comment.
   - `Human Review` -> wait and poll for decision/review updates.
   - `Merging` -> on entry, open and follow `.codex/skills/symphony-land/SKILL.md`; do not call `gh pr merge` directly.
   - `Rework` -> run rework flow.
   - `Done` -> do nothing and shut down.
4. Check whether a PR already exists for your current branch and whether it is closed.
   - If a branch PR exists and is `CLOSED` or `MERGED`, treat prior branch work as non-reusable for this run.
   - Create a fresh branch from `origin/main` and restart execution flow as a new attempt.
5. For `Todo` tickets, do startup sequencing in this exact order:
   - `update_issue(..., state: "In Progress")`
   - if another agent already moved it, treat that as success and continue
   - find/create your own `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}` bootstrap comment
   - only then begin analysis/planning/implementation work.
6. Add a short comment if state and issue content are inconsistent, then proceed with the safest flow.

## Step 1: Start/continue execution (Todo or In Progress)

1. Find or create your own persistent scratchpad comment for the issue:
   - Search existing comments for a marker header: `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}`.
   - Ignore resolved comments while searching; only active or unresolved comments are eligible to be reused as your live workpad.
   - If found, reuse that comment; do not create a new workpad comment for yourself.
   - If not found, create one workpad comment and use it for all your updates.
   - Persist your own workpad comment ID and only write progress updates to that ID.
2. If arriving from `Todo`, do not delay on additional status transitions: the issue should already be `In Progress` before this step begins, whether by your write or another agent's equivalent write.
3. Immediately reconcile your workpad before new edits:
   - Check off items that are already done.
   - Expand or fix the plan so it is comprehensive for your current scope.
   - Ensure `Acceptance Criteria` and `Validation` are current and still make sense for your work.
4. Start work by writing or updating a hierarchical plan in your workpad comment.
5. Ensure your workpad includes a compact environment stamp at the top as a code fence line:
   - Format: `<host>:<abs-workdir>@<short-sha>`
   - Example: `devbox-01:/home/dev-user/code/symphony-workspaces/MT-32/1@7bdde33bc`
   - Do not include metadata already inferable from Linear issue fields (`issue ID`, `status`, `branch`, `PR link`).
6. Add explicit acceptance criteria and TODOs in checklist form in the same comment.
   - If changes are user-facing, include a UI walkthrough acceptance criterion that describes the end-to-end user path to validate.
   - If changes touch app files or app behavior, add explicit app-specific flow checks to `Acceptance Criteria` in the workpad (for example: launch path, changed interaction path, and expected result path).
   - If the ticket description or comment context includes `Validation`, `Test Plan`, or `Testing` sections, copy those requirements into your workpad `Acceptance Criteria` and `Validation` sections as required checkboxes (no optional downgrade).
7. Run a principal-style self-review of the plan and refine it in the comment.
8. Before implementing, capture a concrete reproduction signal and record it in your workpad `Notes` section (command/output, screenshot, or deterministic UI behavior).
9. Run the `symphony-pull` skill to sync with latest `origin/main` before any code edits, then record the pull/sync result in your workpad `Notes`.
   - Include a `pull skill evidence` note with:
     - merge source(s),
     - result (`clean` or `conflicts resolved`),
     - resulting `HEAD` short SHA.
10. Compact context and proceed to execution.

## PR feedback sweep protocol (required)

When your branch has an attached PR, run this protocol before moving to `Human Review`:

1. Identify the PR number from issue links/attachments.
2. Gather feedback from all channels:
   - Top-level PR comments (`gh pr view --comments`).
   - Inline review comments (`gh api repos/<owner>/<repo>/pulls/<pr>/comments`).
   - Review summaries/states (`gh pr view --json reviews`).
3. Treat every actionable reviewer comment (human or bot), including inline review comments, as blocking until one of these is true:
   - code/test/docs updated to address it, or
   - explicit, justified pushback reply is posted on that thread.
4. Update your workpad plan/checklist to include each feedback item and its resolution status.
5. Re-run validation after feedback-driven changes and push updates.
6. Repeat this sweep until there are no outstanding actionable comments.

## Blocked-access escape hatch (required behavior)

Use this only when completion is blocked by missing required tools or missing auth/permissions that cannot be resolved in-session.

- GitHub is **not** a valid blocker by default. Always try fallback strategies first (alternate remote/auth mode, then continue publish/review flow).
- Do not move to `Human Review` for GitHub access/auth until all fallback strategies have been attempted and documented in your workpad.
- If a non-GitHub required tool is missing, or required non-GitHub auth is unavailable, do this exact sequence:
  - finish your current investigation
  - update your own workpad
  - set your own workpad status line to exactly `Status: BLOCKED`
  - add a short blocker brief in your own workpad that includes:
    - what is missing,
    - why it blocks required acceptance/validation,
    - exact human action needed to unblock
  - re-read all ensemble workpads on the ticket
  - if any expected ensemble workpad does not contain either `Status: COMPLETE` or `Status: BLOCKED`, do not move the ticket
  - if all expected ensemble workpads are terminal for this run (`Status: COMPLETE` or `Status: BLOCKED`) and at least one workpad is `Status: BLOCKED`, move the ticket to `Human Review`
- Keep the brief concise and action-oriented; do not add extra top-level comments outside your workpad.
- A workpad is considered still in progress when it does not contain either `Status: COMPLETE` or `Status: BLOCKED`.

## Step 2: Execution phase (Todo -> In Progress -> Human Review)

1. Determine current repo state (`branch`, `git status`, `HEAD`) and verify the kickoff `pull` sync result is already recorded in your workpad before implementation continues.
2. If current issue state is `Todo`, move it to `In Progress`; if another agent already moved it, treat that as success and continue; otherwise leave the current state unchanged.
3. Load your existing workpad comment and treat it as your active execution checklist.
   - Edit it liberally whenever reality changes (scope, risks, validation approach, discovered tasks).
4. Implement against the hierarchical TODOs and keep your workpad current:
   - Check off completed items.
   - Add newly discovered items in the appropriate section.
   - Keep parent/child structure intact as scope evolves.
   - Update the workpad immediately after each meaningful milestone (for example: reproduction complete, code change landed, validation run, review feedback addressed).
   - Never leave completed work unchecked in the plan.
5. Run validation/tests required for your scope.
   - Mandatory gate: execute all ticket-provided `Validation`/`Test Plan`/`Testing` requirements when present; treat unmet items as incomplete work.
   - Prefer a targeted proof that directly demonstrates the behavior you changed.
   - You may make temporary local proof edits to validate assumptions (for example: tweak a local build input for `make`, or hardcode a UI account / response path) when this increases confidence.
   - Revert every temporary proof edit before commit/push.
   - Document these temporary proof steps and outcomes in your workpad `Validation` or `Notes` sections so reviewers can follow the evidence.
   - If app-touching, run `launch-app` validation and capture/upload media via `github-pr-media` before handoff.
6. Re-check all acceptance criteria and close any gaps.
7. Before every `git commit`, run the `simplify` skill to review changed code for reuse, quality, and efficiency. Then invoke the `symphony-commit` skill to commit and the `symphony-push` skill to push.
8. Attach your PR URL to the issue (prefer attachment; use your workpad comment only if attachment is unavailable).
   - Ensure the GitHub PR has label `symphony` (add it if missing).
9. Merge latest `origin/main` into your branch, resolve conflicts, and rerun checks.
10. Update your workpad comment with final checklist status and validation notes.
   - Mark completed plan/acceptance/validation checklist items as checked.
   - Add final handoff notes (commit + validation summary) in your own workpad comment.
   - Do not include PR URL in the workpad comment; keep PR linkage on the issue via attachment/link fields.
   - Add a short `### Confusions` section at the bottom when any part of task execution was unclear/confusing, with concise bullets.
   - Do not post any additional completion summary comment.
11. Before changing the ticket to a later shared state (`Human Review`, `Done`, or similar), do this exact sequence:
   - finish your work
   - update your own workpad
   - add the exact line `Status: COMPLETE` to your own workpad
   - only after that, re-read all ensemble workpads on the ticket
   - if all expected ensemble workpads are marked `Status: COMPLETE`, then update the ticket state
   - otherwise leave the ticket state unchanged for the next completed agent to update
12. Treat `Todo -> In Progress` as optimistic:
   - first write wins
   - if another agent already made the equivalent transition, continue without treating it as a problem
13. Treat later shared transitions as completion-gated:
   - do not move to `Human Review` for normal completion unless all expected ensemble workpads are marked `Status: COMPLETE`
   - do not move to `Done` unless all expected ensemble workpads are marked `Status: COMPLETE`, and the merge flow is actually complete
14. Treat blocked handoff as terminal-state gated:
   - `Status: BLOCKED` is a terminal per-agent state, just like `Status: COMPLETE`
   - do not move the ticket to `Human Review` for blocking while any expected ensemble workpad lacks both `Status: COMPLETE` and `Status: BLOCKED`
   - move the ticket to `Human Review` for blocking only when all expected ensemble workpads are terminal and at least one of them is `Status: BLOCKED`
   - if all expected ensemble workpads are `Status: COMPLETE`, this is a normal completion handoff, not a blocked handoff
15. Before moving to `Human Review`, poll PR feedback and checks:
   - Read the PR `Manual QA Plan` comment (when present) and use it to sharpen UI/runtime test coverage for the current change.
   - Run the full PR feedback sweep protocol.
   - Confirm PR checks are passing (green) after the latest changes.
   - Confirm every required ticket-provided validation/test-plan item is explicitly marked complete in your workpad.
   - Repeat this check-address-verify loop until no outstanding comments remain and checks are fully passing.
   - Re-open and refresh your workpad before state transition so `Plan`, `Acceptance Criteria`, and `Validation` exactly match completed work.
16. Only then move issue to `Human Review`.
   - Exception: if blocked by missing required non-GitHub tools/auth per the blocked-access escape hatch, move to `Human Review` with the blocker brief and explicit unblock actions.

## Step 3: Human Review and merge handling

1. When the issue is in `Human Review`, do not code or change ticket content.
2. Poll for updates as needed, including GitHub PR review comments from humans and bots.
3. If review feedback requires changes, move the issue to `Rework` and follow the rework flow.
4. If approved, human moves the issue to `Merging`.
5. When the issue is in `Merging`, assume there is only one merging agent for now.
6. That merging agent should expect the issue, workpads, PRs, and review history to contain feedback about which approach or combination of work should become the final merged result.
7. When the issue is in `Merging`, open and follow `.codex/skills/symphony-land/SKILL.md`, then run the `symphony-land` skill in a loop until the PR is merged. Do not call `gh pr merge` directly.
8. After merge is complete, add `Status: COMPLETE` to your own workpad if not already present, re-read all workpads, and move the issue to `Done` only if all expected workpads are marked `Status: COMPLETE`.

## Step 4: Rework handling

1. Treat `Rework` as a full approach reset, not incremental patching.
2. Re-read the full issue body and all human comments; explicitly identify what will be done differently this attempt.
3. Close the existing PR tied to your branch.
4. Remove your existing `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}` comment from the issue.
5. Create a fresh branch from `origin/main`.
6. Start over from the normal kickoff flow:
   - If current issue state is `Todo`, move it to `In Progress`; otherwise keep the current state.
   - Create a new bootstrap `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}` comment.
   - Build a fresh plan/checklist and execute end-to-end.

## Completion bar before Human Review

- Step 1/2 checklist is fully complete and accurately reflected in your single workpad comment.
- Your workpad contains the exact line `Status: COMPLETE` before any attempt to move the ticket to a later shared state.
- Acceptance criteria and required ticket-provided validation items are complete.
- Validation/tests are green for the latest commit.
- PR feedback sweep is complete and no actionable comments remain.
- PR checks are green, branch is pushed, and PR is linked on the issue.
- Required PR metadata is present (`symphony` label).
- If app-touching, runtime validation/media requirements from `App runtime validation (required)` are complete.
- All expected ensemble workpads are marked `Status: COMPLETE` before moving the ticket to `Human Review`.

## Completion bar before blocked Human Review

- Your workpad contains the exact line `Status: BLOCKED` before any attempt to move the ticket due to blocking.
- Your blocker brief is present in your own workpad and clearly explains:
  - what is missing,
  - why it blocks required acceptance/validation,
  - exact human action needed to unblock.
- All expected ensemble workpads are terminal for this run:
  - `Status: COMPLETE`, or
  - `Status: BLOCKED`
- At least one expected ensemble workpad is `Status: BLOCKED`.
- No expected ensemble workpad remains without a terminal status marker.

## Guardrails

- If the branch PR is already closed/merged, do not reuse that branch or prior implementation state for continuation.
- For closed/merged branch PRs, create a new branch from `origin/main` and restart from reproduction/planning as if starting fresh.
- If issue state is `Backlog`, do not modify it; wait for human to move to `Todo`.
- Do not edit the issue body/description for planning or progress tracking.
- Use exactly one persistent workpad comment per independent agent:
  `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}`
- Your workpad is separate, persistent, and isolated from other agents' workpads.
- Do not edit another agent's workpad.
- Your workpad has no explicit in-progress marker.
- A workpad is considered in progress by default until it contains one terminal marker:
  - `Status: COMPLETE`
  - `Status: BLOCKED`
- If comment editing is unavailable in-session, use the update script. Only report blocked if both MCP editing and script-based editing are unavailable.
- Temporary proof edits are allowed only for local verification and must be reverted before commit.
- If out-of-scope improvements are found, create a separate Backlog issue rather
  than expanding current scope, and include a clear
  title/description/acceptance criteria, same-project assignment, a `related`
  link to the current issue, and `blockedBy` when the follow-up depends on the
  current issue.
- Do not move to `Human Review` unless the `Completion bar before Human Review` is satisfied.
- In `Human Review`, do not make changes; wait and poll.
- If state is terminal (`Done`), do nothing and shut down.
- Keep issue text concise, specific, and reviewer-oriented.
- If blocked and no workpad exists yet, add one blocker comment describing blocker, impact, and next unblock action.

## Workpad template

Use this exact structure for your own persistent workpad comment and keep it updated in place throughout execution:

````md
## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````

When your work is complete, change the status line to exactly:

```md
Status: COMPLETE
```

Do that before any attempt to move the ticket to a later shared state.

When your work is blocked by missing required tools, auth, permissions, or secrets, change the status line to exactly:

```md
Status: BLOCKED
```

Do that before any attempt to move the ticket to `Human Review` because of blocking.
