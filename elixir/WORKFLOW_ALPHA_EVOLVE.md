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
Independent population-member context:

- You are one population member in a 0-indexed ensemble slot: `{{ ensemble.slot_index }}` out of `{{ ensemble.size }}`.
- Work only in your own dedicated workspace.
- Treat the default `ensemble_size: 3` as the starting population size. Issue labels such as `ensemble:1` or `ensemble:5` may shrink or widen the population without orchestration changes.
- Use branch, PR, and workpad naming that includes `{{ issue.identifier }} {{ ensemble.slot_index }}` so parallel candidates remain separable.
- During `In Progress`, preserve diversity. Do not copy another active slot's plan or edit another slot's workpad.
{% endif %}

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Reuse already validated ideas when they still fit, but keep the candidate ledger honest about what changed this attempt.
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

## AlphaEvolve posture

- Treat the ticket as a search problem, not a single-shot implementation task.
- Maintain a small population of materially different candidate approaches before converging.
  - When `ensemble.enabled`, the population is the active set of ensemble slots plus each slot's local candidate ledger.
  - When `ensemble.enabled` is false, the population is the local candidate ledger only.
- Use a rich context package before generating mutations:
  - ticket body and comments,
  - nearby code and docs,
  - previous attempt evidence,
  - validation feedback,
  - prior winning or near-winning candidate notes.
- Use staged evaluation rather than one big test pass:
  - cheap filters first,
  - targeted behavioral proof second,
  - broader or more expensive checks only for promising candidates.
- Optimize multiple metrics at once:
  - correctness,
  - ticket fit,
  - validation strength,
  - blast radius,
  - maintainability,
  - performance or latency when relevant.
- Preserve diversity long enough to matter. Keep at least one candidate that differs on a major axis such as architecture, algorithm, data flow, or integration strategy until evidence clearly favors convergence.
- Use the workpad, validation artifacts, and PRs as the searchable archive of candidate ideas. Record why variants were promoted, rejected, or merged into the leader.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Start every task by opening the tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning, candidate generation, and verification design before implementation.
- Reproduce first: always confirm the current behavior or issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat a persistent Linear workpad comment as the source of truth for progress.
- Use the workpad comment for all progress and handoff notes. Do not post separate "done" or summary comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input: mirror it in the workpad and execute it before considering the work complete.
- When meaningful out-of-scope improvements are discovered during execution, file a separate Linear issue instead of expanding scope. The follow-up issue must include a clear title, description, and acceptance criteria, be placed in `Backlog`, be assigned to the same project as the current issue, link the current issue as `related`, and use `blockedBy` when the follow-up depends on the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers after exhausting documented fallbacks.

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
  - If a PR is already attached, treat it as a feedback or rework loop and run the full PR feedback sweep before new feature work.
- `In Progress` -> candidate generation, evaluation, and implementation are underway.
- `Agent Review` -> stop doing new feature work and perform autonomous comparative review of the evolved candidates with a bias toward selecting and merging the best one.
- `Human Review` -> exception-only path for ambiguous selection, explicit risk acceptance, or external blockers that cannot be resolved autonomously.
- `Merging` -> a winning candidate has been selected; execute the `symphony-land` skill flow.
- `Rework` -> the selected candidate needs another implementation pass.
- `Done` -> terminal state; no further action required.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route to the matching flow:
   - `Backlog` -> do not modify issue content or state; stop and wait for a human to move it to `Todo`.
   - `Todo` -> immediately move to `In Progress`, then ensure the bootstrap workpad exists, then start execution.
   - `In Progress` -> continue execution from the current workpad.
   - `Agent Review` -> run the autonomous review protocol.
   - `Human Review` -> wait and poll for decision or review updates.
   - `Merging` -> on entry, open and follow `.codex/skills/symphony-land/SKILL.md`; do not call `gh pr merge` directly.
   - `Rework` -> run rework flow.
   - `Done` -> do nothing and shut down.
4. Check whether a PR already exists for the current branch and whether it is closed.
   - If a branch PR exists and is `CLOSED` or `MERGED`, treat prior branch work as non-reusable for this run.
   - Create a fresh branch from `origin/main` and restart execution flow as a new attempt.
5. For `Todo` tickets, do startup sequencing in this exact order:
   - `update_issue(..., state: "In Progress")`
   - find or create the live workpad comment
   - only then begin analysis, planning, and implementation work
6. Add a short comment if state and issue content are inconsistent, then proceed with the safest flow.

## Step 1: Start or continue execution (Todo or In Progress)

1. Find or create the live workpad comment for this run:
{% if ensemble.enabled %}
   - Use one persistent workpad per slot with the marker header `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}`.
   - Ignore resolved comments while searching; only active or unresolved comments are eligible to be reused.
   - If found, reuse that comment. If not found, create one and use it for all updates.
{% else %}
   - Use a single persistent workpad comment with the marker header `## Codex Workpad`.
   - Ignore resolved comments while searching; only active or unresolved comments are eligible to be reused.
   - If found, reuse that comment. If not found, create one and use it for all updates.
{% endif %}
2. Immediately reconcile the workpad before new edits:
   - Check off items that are already done.
   - Expand or fix the plan so it is comprehensive for the current scope.
   - Ensure `Acceptance Criteria`, `Candidate Ledger`, and `Validation` still match the ticket.
3. Ensure the workpad includes a compact environment stamp at the top as a code fence line:
   - Format: `<host>:<abs-workdir>@<short-sha>`
   - Do not include metadata already inferable from Linear issue fields such as issue ID, status, branch, or PR link.
4. Write or update a hierarchical plan in the workpad.
5. Before implementation, add or refresh a candidate ledger:
   - Create at least two concrete candidate strategies.
   - Keep one candidate materially different from the current leader until evidence clearly favors convergence.
   - Score each candidate on likely correctness, expected payoff, validation cost, blast radius, and reversibility.
   - Explicitly name the current leader and the reason it is ahead.
6. Capture a concrete reproduction signal and record it in the workpad `Notes` section.
7. Run the `symphony-pull` skill to sync with latest `origin/main` before any code edits, then record the pull result in `Notes`.
   - Include a `pull skill evidence` note with merge source, result (`clean` or `conflicts resolved`), and resulting `HEAD` short SHA.
8. Compact context and proceed to execution.

## PR feedback sweep protocol (required)

When a ticket has an attached PR, run this protocol before moving to `Agent Review`:

1. Identify the PR number from issue links or attachments.
2. Gather feedback from all channels:
   - top-level PR comments (`gh pr view --comments`),
   - inline review comments (`gh api repos/<owner>/<repo>/pulls/<pr>/comments`),
   - review summaries and states (`gh pr view --json reviews`)
3. Treat every actionable reviewer comment, human or bot, as blocking until one of these is true:
   - code, docs, or tests were updated to address it, or
   - an explicit, justified pushback reply was posted on that thread
4. Update the workpad plan or checklist to include each feedback item and its resolution status.
5. Re-run validation after feedback-driven changes and push updates.
6. Repeat the sweep until no actionable comments remain.

## Blocked-access escape hatch (required behavior)

Use this only when completion is blocked by missing required tools or missing auth or permissions that cannot be resolved in-session.

- GitHub is not a valid blocker by default. Always try fallback strategies first.
- Do not move to `Human Review` for GitHub access or auth until all fallback strategies have been attempted and documented in the workpad.
- If a non-GitHub required tool is missing, or required non-GitHub auth is unavailable:
  - finish the current investigation,
  - update the workpad,
  - set the workpad status line to exactly `Status: BLOCKED`,
  - add a short blocker brief that includes what is missing, why it blocks validation or acceptance, and the exact human action needed to unblock
{% if ensemble.enabled %}
  - re-read all expected ensemble workpads,
  - if any expected workpad lacks either `Status: COMPLETE` or `Status: BLOCKED`, do not move the ticket,
  - if all expected workpads are terminal for this run and at least one is `Status: BLOCKED`, move the ticket to `Human Review`
{% else %}
  - move the ticket to `Human Review`
{% endif %}
- Keep the blocker brief concise and action-oriented. Do not add extra top-level comments outside the workpad.

## Step 2: Execution phase (Todo -> In Progress -> Agent Review)

1. Determine current repo state (`branch`, `git status`, `HEAD`) and verify the kickoff pull result is already recorded in the workpad.
2. If current issue state is `Todo`, move it to `In Progress`; otherwise leave the current state unchanged.
3. Treat the workpad as the active execution checklist.
4. Implement against the current leader in the candidate ledger while keeping the archive honest:
   - Check off completed work immediately.
   - Add newly discovered tasks in the correct section.
   - Log candidate promotions, rejections, and merges in the candidate ledger.
   - If the leader stalls, promote the strongest backup candidate rather than forcing a weak path.
{% if ensemble.enabled %}
   - During `In Progress`, stay independent from other active slots to preserve diversity.
{% endif %}
5. Run validation using an evaluation cascade:
   - cheap static or render checks first,
   - targeted behavioral tests or proofs second,
   - broader or more expensive suites only for candidates that survive earlier stages
6. Re-check acceptance criteria and close any gaps.
7. Before every `git commit`, run the `simplify` skill. Then invoke `symphony-commit` to commit and `symphony-push` to push.
8. Attach the PR URL to the issue and ensure the PR has label `symphony`.
9. Update the workpad with final checklist status and validation notes.
10. Before moving to a later shared state:
   - finish your work,
   - update your workpad,
   - add the exact line `Status: COMPLETE` when the slot is done or `Status: BLOCKED` when truly blocked
{% if ensemble.enabled %}
   - only after that, re-read all expected ensemble workpads
   - if all expected workpads are `Status: COMPLETE`, move the ticket to `Agent Review`
   - if all expected workpads are terminal and at least one is `Status: BLOCKED`, move the ticket to `Human Review`
   - otherwise leave the ticket state unchanged for the next slot to finish
{% else %}
   - if complete, move the ticket to `Agent Review`
   - if blocked, move the ticket to `Human Review`
{% endif %}
11. Before moving to `Agent Review`, poll PR feedback and checks:
   - read the PR `Manual QA Plan` comment when present,
   - run the full PR feedback sweep,
   - confirm PR checks are green,
   - confirm every required ticket-provided validation item is explicitly marked complete in the workpad,
   - refresh the workpad so `Plan`, `Candidate Ledger`, `Acceptance Criteria`, and `Validation` match reality exactly

## Step 3: Agent Review

1. When the issue is in `Agent Review`, do not do new feature work.
2. Review the evolved candidates holistically with a bias toward selecting the strongest mergeable result.
3. Use the combined workpads, PRs, validation notes, and review threads as the evolutionary archive.
4. Evaluate candidates across:
   - correctness and ticket fit,
   - validation quality,
   - blast radius,
   - maintainability,
   - observability,
   - performance where relevant,
   - whether diversity surfaced a clearly superior approach
5. Severity rubric:
   - `P0` -> catastrophic merge blocker
   - `P1` -> serious merge blocker, including insufficient or invalid proof
   - `P2` -> should not block merging
   - `P3` -> optional polish
6. If one candidate is clearly best, all required checks are green on that candidate, and no unresolved `P0` or `P1` findings remain, move the issue to `Merging`.
7. If the winning direction is clear but needs autonomous fixes, move the issue to `Rework`.
   - Add a concise blocker summary to the workpad that names the selected candidate, the root concern, and what must be different on the next attempt.
8. If selection is ambiguous, a hybrid of multiple candidates is required, or risk acceptance is needed, move the issue to `Human Review`.
   - Add a concise escalation brief to the workpad that states the ambiguity or risk and the exact decision needed.
9. Meaningful `P2` or `P3` findings should not block merging. When future work is warranted, create a separate Backlog issue rather than expanding scope.

## Step 4: Human Review

1. When the issue is in `Human Review`, do not code or change ticket content.
2. `Human Review` is exception-only and is reserved for ambiguous selection, explicit risk acceptance, or blockers that cannot be resolved autonomously.
3. Poll for updates as needed, including PR review comments from humans and bots.
4. If review feedback requires changes, move the issue to `Rework` and follow the rework flow.
5. If approved, move or wait for the issue to move to `Merging` depending on repo policy.

## Step 5: Merging

1. When the issue is in `Merging`, open and follow `.codex/skills/symphony-land/SKILL.md`, then run the `symphony-land` skill in a loop until the winning PR is merged. Do not call `gh pr merge` directly.
2. Close superseded candidate PRs after the winning result is safely merged or otherwise rendered obsolete.
3. After merge is complete, move the issue to `Done`.

## Step 6: Rework handling

1. Treat `Rework` as a full approach reset, not incremental patching.
2. Re-read the full issue body and all review feedback. Explicitly identify what will be done differently this attempt.
3. Close the existing PR tied to the selected branch when it is no longer the right candidate.
4. Remove the existing workpad comment for the reworked attempt.
5. Create a fresh branch from `origin/main`.
6. Start over from the normal kickoff flow:
   - if current issue state is `Todo`, move it to `In Progress`; otherwise keep the current state,
   - create a new bootstrap workpad comment,
   - rebuild the plan, candidate ledger, acceptance criteria, and validation checklist

## Completion bar before Agent Review

- The Step 1 and Step 2 checklist is fully complete and accurately reflected in the workpad.
- Acceptance criteria and required ticket-provided validation items are complete.
- Validation and tests are green for the latest commit.
- PR feedback sweep is complete and no actionable comments remain.
- PR checks are green, branch is pushed, and PR is linked on the issue.
- Required PR metadata is present (`symphony` label).
- The candidate ledger clearly identifies the winning local candidate and why it beat the alternatives.
{% if ensemble.enabled %}
- All expected ensemble workpads are marked `Status: COMPLETE` before moving the ticket to `Agent Review`.
{% endif %}

## Completion bar before blocked Human Review

- The workpad contains the exact line `Status: BLOCKED`.
- The blocker brief explains what is missing, why it blocks required validation or acceptance, and the exact human action needed.
{% if ensemble.enabled %}
- All expected ensemble workpads are terminal for this run:
  - `Status: COMPLETE`, or
  - `Status: BLOCKED`
- At least one expected ensemble workpad is `Status: BLOCKED`.
{% endif %}

## Guardrails

- If the branch PR is already closed or merged, do not reuse that branch or prior implementation state for continuation.
- If issue state is `Backlog`, do not modify it; wait for it to move to `Todo`.
- Do not edit the issue body or description for planning or progress tracking.
{% if ensemble.enabled %}
- Use exactly one persistent workpad comment per slot:
  `## Codex Workpad - {{ issue.identifier }} {{ ensemble.slot_index }}`
- Do not edit another slot's workpad.
- A slot workpad is considered in progress by default until it contains one terminal marker:
  - `Status: COMPLETE`
  - `Status: BLOCKED`
{% else %}
- Use exactly one persistent workpad comment:
  `## Codex Workpad`
{% endif %}
- If comment editing is unavailable in-session, use the update script. Only report blocked if both MCP editing and script-based editing are unavailable.
- Temporary proof edits are allowed only for local verification and must be reverted before commit.
- Do not move to `Agent Review` unless the completion bar is satisfied.
- In `Agent Review`, do not do new feature work.
- In `Human Review`, do not make changes.
- If the state is terminal (`Done`), do nothing and shut down.

## Workpad template

Use this exact structure for the persistent workpad comment and keep it updated in place throughout execution:

````md
## Codex Workpad{% if ensemble.enabled %} - {{ issue.identifier }} {{ ensemble.slot_index }}{% endif %}

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\. Parent task

### Candidate Ledger

- [ ] Candidate A - hypothesis, expected gain, cost, current score, decision
- [ ] Candidate B - hypothesis, expected gain, cost, current score, decision

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation and Proof of Work

- [ ] stage 1: cheap check `<command>`
- [ ] stage 2: targeted check `<command>`
- [ ] stage 3: broader check `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>

### Agent Reviews

- <review notes with timestamps>
````

When work is complete, change the status line to exactly:

```md
Status: COMPLETE
```

When truly blocked, change the status line to exactly:

```md
Status: BLOCKED
```

## AlphaEvolve mapping and tradeoffs

- This workflow approximates AlphaEvolve using existing Symphony capabilities rather than new orchestrator mechanics.
- Population:
  - AlphaEvolve uses an evolutionary population and program database.
  - Symphony maps this to ensemble slots plus the local candidate ledger.
- Rich prompts:
  - AlphaEvolve samples prompts from prior strong programs and feedback.
  - Symphony maps this to ticket context, codebase context, prior attempt notes, PR feedback, and candidate-ledger history.
- Evaluators:
  - AlphaEvolve depends on automated evaluators and often uses evaluation cascades.
  - Symphony maps this to staged validation gates, targeted tests, and proof-of-work artifacts.
- Selection:
  - AlphaEvolve keeps multiple metrics and balances exploration with exploitation.
  - Symphony maps this to multi-metric candidate scoring, diversity guardrails, and comparative review in `Agent Review`.
- Throughput:
  - AlphaEvolve runs an asynchronous pipeline optimized for throughput.
  - Symphony approximates throughput with ensemble fan-out and issue-label overrides such as `ensemble:5`, but it does not provide a built-in shared evaluator cluster or centralized prompt sampler.
- Diversity:
  - AlphaEvolve uses an evolutionary database inspired by MAP-Elites and island models.
  - Symphony approximates this with isolated per-slot work, explicit candidate ledgers, and later archive comparison, which is weaker but requires no orchestrator changes.
- Limitation:
  - AlphaEvolve is best suited to problems with strong automated evaluation signals.
  - If a ticket cannot be meaningfully evaluated by tests, benchmarks, snapshots, or deterministic runtime proofs, this workflow loses much of its advantage.

## References

- Google DeepMind blog, "AlphaEvolve: A Gemini-powered coding agent for designing advanced algorithms" (May 14, 2025): https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
- Novikov et al., "AlphaEvolve: A coding agent for scientific and algorithmic discovery" (June 16, 2025): https://arxiv.org/abs/2506.13131
