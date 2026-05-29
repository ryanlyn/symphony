# Tracker Decoupling - Comprehensive Gap Analysis

Source: 12-dimension adversarial gap-analysis workflow (each finding verified against the code). 80 confirmed-real gaps. `[in-spec]` = the spec/plan specified this and it is missing/incomplete; `[beyond-spec]` = production/usability gap the spec did not cover.

Counts: 30 major, 40 minor, 5 enhancement, 5 nit. 14 in-spec, 66 beyond-spec.

## MAJOR (30)

### beyond-spec-critic

- **Slack issues are unroutable, unassignable, and every instance claims every mention** [beyond-spec, M] - packages/slack-tracker (client.ts) + packages/dispatch routing `packages/slack-tracker/src/client.ts:57 (labels:[]); packages/issue/src/index.ts:24-26 (assignedToWorker=true default); packages/dispatch/src/index.ts:38-43 (routedToThisWorker)`
  - At minimum document Slack as single-worker. Better: parse a '[route:x]' token from mention text into issue.labels so existing route routing works, and/or add a 'claim' reaction the read path filters on so other instances skip already-claimed mentions.
- **Mention filter matches any user mention, not the configured bot (no bot identity)** [beyond-spec, M] - packages/slack-tracker (webTransport.ts) `packages/slack-tracker/src/webTransport.ts:30 (regex /<@[A-Z0-9_]+(\|[^>]*)?>/)`
  - Resolve the bot user id once via auth.test (or accept a configured bot user id in tracker settings) and only treat messages mentioning <@THAT_ID> as issues; reuse the id for the title-strip regex.
- **BoardStore has no concurrency control: non-atomic writes and racing id allocation** [beyond-spec, M] - packages/local-tracker (boardStore.ts) `packages/local-tracker/src/boardStore.ts:45-57 (updateStatus/appendComment read-modify-write), 59-69 (create), 87-92 (nextId), 128-130 (writeFile)`
  - Write to a temp file then fs.rename (atomic), guard create/append with an OS-level lock (proper-lockfile or O_EXCL marker) scoped to the board dir, and retry create on id collision.

### config-secrets

- **tracker.path is never expanded (~ and whole-string $VAR) unlike workspace.root** [beyond-spec, S] - packages/config (parseTracker) + packages/local-tracker (LocalTrackerClient/BoardStore) `ts/packages/config/src/index.ts:475; ts/packages/local-tracker/src/client.ts:16-18; ts/packages/local-tracker/src/boardStore.ts:130`
  - Route tracker.path through the existing expandLocalPath(value, env) helper inside parseTracker (it already supports ~ and whole-string $VAR), or explicitly document that tracker.path is a literal repo-relative/absolute path with no expansion. Mirror workspace.root's behavior, not full shell expansion.
- **No operator documentation for new tracker kinds or required Slack OAuth scopes** [beyond-spec, M] - README.md / docs (operator-facing config & secrets) `ts/README.md:13,72-74 (linear-only example); no coverage in docs/ or WORKFLOW.md`
  - Add a tracker-kinds section to README/docs covering local (path default .symphony/board, on-disk markdown format) and slack (SLACK_BOT_TOKEN, channels as Slack channel IDs, emoji_states overrides) plus an explicit required-bot-scopes list: channels:history/groups:history, reactions:read, reactions:write, chat:write, and an identity scope for the bot user.
- **Slack mention filter matches ANY @-mention, not the bot's; no bot-identity config or auth.test** [in-spec, M] - packages/slack-tracker (SlackWebTransport.listMentions, SlackTrackerClient.toIssue) + config `ts/packages/slack-tracker/src/webTransport.ts:30; ts/packages/slack-tracker/src/client.ts:49`
  - Resolve the bot user id once via auth.test using SLACK_BOT_TOKEN (cache it) or add an optional tracker.bot_user_id config field, and constrain listMentions/title-stripping to that id. Document the scope auth.test requires.

### documentation

- **README documents only kind: linear; no local/slack config or runtime mention** [beyond-spec, M] - ts/README.md `ts/README.md:13,59,72-93`
  - Add a Trackers subsection under Configuration enumerating the kinds (linear/local/slack, plus memory for tests) with minimal YAML for `kind: local` (path, active_states/terminal_states) and `kind: slack` (channels, emoji_states, SLACK_BOT_TOKEN), and make the Linear-specific phrasing ('polls Linear', LINEAR_API_KEY-only prereq) tracker-agnostic.
- **No Slack setup guide (app creation, scopes, bot token, channel IDs, emoji conventions)** [beyond-spec, M] - docs / ts/README.md `n/a (absent); evidence ts/packages/slack-tracker/src/webTransport.ts:26,38,50,58; ts/packages/slack-tracker/src/mapping.ts:5-7,47; ts/packages/config/src/index.ts:416`
  - Add a Slack tracker setup section (README or docs/) covering app creation, required bot scopes, inviting the bot to each watched channel, finding channel IDs for `channels:`, exporting SLACK_BOT_TOKEN, and the default + overridable (emoji_states) emoji->status map. Note mentions become issues and there is no Slack issue-creation tool (spec non-goal, spec:314).
- **No Local tracker setup/usage guide (.symphony/board format, BOARD-n ids, status conventions)** [beyond-spec, M] - docs / ts/README.md `n/a (absent); evidence ts/packages/local-tracker/src/client.ts:7; ts/packages/local-tracker/src/boardStore.ts:62,91,136; ts/packages/issue/src/index.ts:55-64`
  - Add a Local tracker section documenting `kind: local` config, default path (.symphony/board), the Markdown-with-frontmatter file format with an example issue file, BOARD-<n> id allocation, and the recognized status-name->type vocabulary so users can hand-author/seed board files.

### error-resilience

- **A thrown fetchCandidateIssues() permanently kills the daemon poll loop** [beyond-spec, S] - packages/runtime + new read clients (slack-tracker, local-tracker) `ts/packages/runtime/src/index.ts:294-298, :334, :356-361; apps/cli/src/main.ts:159-169`
  - Wrap the start() loop body in try/catch so a thrown poll is logged (poll_error already recorded at index.ts:360) but the loop continues to the next interval; OR stop re-throwing from pollOnceUnlocked for the recurring (non-once) case while still rethrowing for once/dryRun callers that need the rejection. Add a runtime test asserting that fetchCandidateIssues throwing on poll N still runs poll N+1.
- **SlackWebTransport has no 429/5xx retry or Retry-After handling (no parity with linear client)** [in-spec, M] - packages/slack-tracker (webTransport) `ts/packages/slack-tracker/src/webTransport.ts:61-97`
  - Add a shared rate-limit-aware fetch wrapper mirroring linear's retryDelayMs: retry 429 and 5xx with bounded exponential backoff honoring Retry-After, applied to both get() and post().
- **SlackWebTransport.parse crashes on non-JSON responses (HTML/empty 5xx bodies); abort/timeout errors lack method context** [beyond-spec, S] - packages/slack-tracker (webTransport) `ts/packages/slack-tracker/src/webTransport.ts:90-97`
  - Wrap response.json() in try/catch; if parsing fails or !response.ok, throw `slack ${method} failed: status ${response.status}` so HTTP status (and rate-limit signal) survive. Annotate timeout/abort errors with the method name.
- **One malformed/unreadable board file aborts the entire candidate fetch** [beyond-spec, S] - packages/local-tracker (BoardStore) `ts/packages/local-tracker/src/boardStore.ts:26-31, :94-121`
  - In list()/getByIds(), wrap each per-file read in try/catch: skip-and-log (or surface as a single degraded issue) so one bad file cannot starve the rest of the board. Add a test with a directory containing one invalid-YAML/missing-status file plus valid files.

### local-completeness

- **Non-atomic file writes can corrupt/truncate board issues on crash** [beyond-spec, S] - packages/local-tracker (BoardStore.write) `packages/local-tracker/src/boardStore.ts:123-132`
  - Write to a sibling temp file (e.g. ${id}.md.tmp) in the same dir, then fs.rename onto the final path (atomic within a filesystem). A crash then leaves either the prior or the new file intact, never a partial one.
- **Concurrent local_create_issue calls collide on the same BOARD-n identifier** [beyond-spec, M] - packages/local-tracker (BoardStore.create/nextId) `packages/local-tracker/src/boardStore.ts:88-92,59-69`
  - Allocate the id by attempting fs.open(filePath, 'wx') (O_EXCL) in a retry loop: on EEXIST bump n and retry, then write into the held descriptor. Collision-safe without a separate lock file.

### parity-crosscutting

- **SlackWebTransport.listMentions has no pagination; mentions past the first 200 messages are silently invisible** [beyond-spec, M] - packages/slack-tracker (SlackWebTransport) `packages/slack-tracker/src/webTransport.ts:23-35`
  - Loop conversations.history on response_metadata.next_cursor until has_more is false, bounded by the already-declared opts.sinceTs, accumulating across pages, mirroring the Linear endCursor loop.
- **Slack transport has no 429/Retry-After backoff that every other tracker read/write path implements** [beyond-spec, M] - packages/slack-tracker (SlackWebTransport) vs packages/linear-tracker + packages/mcp/tools/linear `packages/slack-tracker/src/webTransport.ts:62-100`
  - Add a 429-aware wrapper around get/post: read Retry-After seconds, back off, retry a small bounded number of times, else exponential backoff; inject a sleep/clock for tests as Linear does. Guard response.json() so a non-JSON 429 yields a rate-limit message.
- **Any <@user> mention becomes an issue; the bot identity is never resolved or configurable** [in-spec, M] - packages/slack-tracker (SlackWebTransport) + packages/config `packages/slack-tracker/src/webTransport.ts:29 ; packages/config/src/index.ts:414-420`
  - Add a botUserId tracker setting (config, resolvable via Slack auth.test at startup) and filter mentions to <@${botUserId}> in both SlackWebTransport.listMentions and InMemorySlackTransport; reject slack config that cannot resolve a bot user id.

### runtime-integration

- **Slack issues can never be routed (labels always []), so onlyRoutes / acceptUnrouted=false silently drops every Slack issue** [beyond-spec, M] - packages/slack-tracker + packages/dispatch `packages/slack-tracker/src/client.ts:58; packages/dispatch/src/index.ts:33-43; packages/config/src/index.ts:278-280`
  - Validate/warn in validateDispatchConfig when kind===slack and (acceptUnrouted===false || onlyRoutes is a non-empty list), since Slack cannot carry route labels. Optionally derive a route label from channel or a reaction. At minimum document that Slack requires acceptUnrouted=true and emit a distinct dispatch-skipped reason for 'backend cannot carry labels'.
- **SlackWebTransport.listMentions has no pagination and ignores the declared sinceTs: candidate discovery and terminal/startup cleanup silently miss anything past the newest 200 channel messages** [beyond-spec, M] - packages/slack-tracker + packages/runtime `packages/slack-tracker/src/webTransport.ts:23-35; packages/slack-tracker/src/client.ts:20,38; packages/slack-tracker/src/transport.ts:9; packages/runtime/src/index.ts:662-679`
  - Implement response_metadata.next_cursor pagination in listMentions and thread sinceTs (oldest=) from the client to bound polling cost over the active window. If pagination is deliberately deferred, document the 200-message ceiling and remove the misleading unused sinceTs from the interface.
- **Local & Slack agents receive branch_name:null and url:null while the prompt + shipped WORKFLOW.md remain git/PR/Linear-centric** [in-spec, L] - packages/prompt + ts/WORKFLOW.md `packages/prompt/src/index.ts:55-56; ts/WORKFLOW.md:149,173,248,280`
  - Per the spec's non-goal, at minimum document the limitation for local/slack adoption; better, provide a tracker-appropriate WORKFLOW.md and/or derive a deterministic branch name from issue.identifier when branchName is null so the agent is not handed a null with no fallback guidance.

### security

- **Path traversal: agent-controlled issueId joined into a filesystem path without validation (LFI + constrained arbitrary write)** [beyond-spec, S] - packages/local-tracker (BoardStore) reached via packages/mcp/src/tools/local.ts `packages/local-tracker/src/boardStore.ts:71-72 (filePath); reached from boardStore.ts:45-57 (updateStatus/appendComment) and packages/mcp/src/tools/local.ts:55-64 (executeLocalTool only requireStr, no shape check)`
  - Validate issueId at the single choke point BoardStore.filePath: reject ids that are not the canonical shape (prefer strict /^BOARD-\d+$/, matching how ids are actually minted), or at minimum reject ids containing '/', '\\', '..', NUL, or that are absolute, AND assert path.resolve(filePath).startsWith(path.resolve(this.dir)+path.sep). Doing it in filePath covers getByIds/updateStatus/appendComment/read uniformly. Optionally also reject early in the MCP layer for a clean error.
- **Information disclosure: updateStatus returns issue content parsed from the attacker-chosen file back to the agent** [beyond-spec, S] - packages/local-tracker/src/boardStore.ts (updateStatus -> read) via local_update_status `packages/local-tracker/src/boardStore.ts:45-50 and 94-109; surfaced to caller at packages/mcp/src/tools/local.ts:56-60 (return { issue })`
  - No separate fix needed beyond the filePath validation/containment guard in the primary finding; included so the fix's acceptance criteria explicitly cover the read-back disclosure path, not just the write path.

### slack-completeness

- **Mention detection matches anyone, not the configured bot user (spec says mention of THE BOT)** [in-spec, M] - packages/slack-tracker (webTransport.ts, inMemoryTransport.ts, client.ts) + config `packages/slack-tracker/src/webTransport.ts:30 ; packages/slack-tracker/src/inMemoryTransport.ts:26 ; packages/slack-tracker/src/client.ts:49`
  - Resolve a bot user id (via Slack auth.test once at startup, or a configured tracker field), thread it through listMentions, build the mention regex from that specific id (e.g. <@U123>), filter to messages mentioning the bot, and strip only the bot's mention when deriving the title. Without this the daemon will dispatch agents on arbitrary human-to-human mentions.
- **Thread replies never surfaced as comments on read (read-back is a no-op)** [in-spec, M] - packages/slack-tracker (transport.ts, webTransport.ts, client.ts) `packages/slack-tracker/src/transport.ts:1 ; packages/slack-tracker/src/webTransport.ts:23 ; packages/slack-tracker/src/client.ts:46`
  - Add a replies/comments array to SlackMessage, call conversations.replies(channel, ts) in SlackWebTransport (and seed in InMemorySlackTransport), and attach on issue.raw/comments. Note spec wording is permissive ('may'), so this is the lower-priority of the two in-spec gaps.
- **conversations.history capped at 200 with no cursor pagination (older open mentions silently dropped)** [beyond-spec, M] - packages/slack-tracker/src/webTransport.ts `packages/slack-tracker/src/webTransport.ts:26`
  - Loop on response_metadata.next_cursor using the cursor param, bounded by an oldest/sinceTs watermark so paging terminates once messages predate the last poll.

### testing-gaps

- **SlackWebTransport getMessage/removeReaction/postReply and the ok:false error path are untested; listMentions has a hard 200-message cap with no pagination** [in-spec, M] - packages/slack-tracker/src/webTransport.ts (test/web-transport.test.ts) `packages/slack-tracker/test/web-transport.test.ts (only listMentions + addReaction URL); webTransport.ts:24 (limit:"200"), :35-46 (getMessage), :54-56 (postReply), :91-94 (ok!==true throw)`
  - Add web-transport tests for getMessage (request shape + ts match + null), removeReaction, postReply (thread_ts body), and an ok:false response asserting the thrown error. Separately decide on pagination (follow next_cursor) or at minimum add a test pinning the 200-message cap as known behavior.

### usability-e2e

- **Shipped WORKFLOW.md prose is Linear-only and is the literal agent prompt for local/slack runs, with a 'stop if Linear not configured' prerequisite** [beyond-spec, M] - ts/WORKFLOW.md (consumed by packages/workflow + packages/prompt) `ts/WORKFLOW.md:57,90-92,101-102,116`
  - Make the prose tracker-agnostic or ship per-kind workflow bodies. At minimum replace the hard-coded 'linear_graphql is a prerequisite / stop if Linear not configured' (lines 90-92) with kind-neutral guidance that points the agent at whatever tools tools/list advertises, and document the board emoji/thread status model. Worth reconsidering the spec's 'fixtures only' non-goal since the shipped workflow is what users actually run.
- **Local/slack workflow files that select the new kinds are test-only one-liners and become the entire agent prompt** [in-spec, M] - ts/test/fixtures/workflow-local.md, ts/test/fixtures/workflow-slack.md `ts/test/fixtures/workflow-local.md, ts/test/fixtures/workflow-slack.md`
  - Promote to documented, runnable starter workflows with real per-kind bodies covering the status lifecycle and tool usage (local_update_status/local_comment/local_create_issue; slack_update_status/slack_comment), or ship example workflows under a docs/examples path the docs point to. Even without full prose, the fixtures should not be the only kind=local/slack template a user can find.
- **No Slack app onboarding: required scopes, app manifest, and channel-membership requirement are undocumented** [beyond-spec, S] - packages/slack-tracker (webTransport) + missing docs `ts/packages/slack-tracker/src/webTransport.ts:23-59, ts/packages/config/src/index.ts:414-422`
  - Add a short Slack setup doc or app manifest listing required scopes (channels:history, reactions:read, reactions:write, chat:write, app_mentions:read), the need to invite the bot to each channel, and how to obtain channel IDs for tracker.channels. Optionally map common Slack errors (not_in_channel/missing_scope) to a clearer hint at config/poll time.

## MINOR (40)

### beyond-spec-critic

- **local_create_issue cannot set labels, so agents cannot create a routable local issue** [beyond-spec, S] - packages/local-tracker (boardStore.ts) + mcp/src/tools/local.ts `packages/local-tracker/src/boardStore.ts:59-69 (create hardcodes labels:[]); packages/mcp/src/tools/local.ts:67-74 (local_create_issue spec has no labels arg)`
  - Add an optional labels arg to local_create_issue and BoardStore.create so agent-created board issues can carry route labels.
- **No human-visible 'close the loop' on agent completion (no auto closing reply/comment)** [beyond-spec, M] - packages/runtime + local/slack tools `packages/runtime/src/index.ts:577-585 (terminal transition only does workspace cleanup); grep of packages/runtime/src for executeTool/updateStatus/postReply/appendComment returned NONE`
  - Consider a workflow step or a runtime hook that posts a closing thread reply/board comment with outcome + PR link on terminal-state transition, so the loop closes regardless of agent discretion. Beyond-spec enhancement.
- **Polling ignores opts.sinceTs and caps conversations.history at 200, dropping mentions** [beyond-spec, M] - packages/slack-tracker (webTransport.ts) `packages/slack-tracker/src/webTransport.ts:23-35 (listMentions ignores opts, limit:200, no pagination); transport.ts:9 declares opts.sinceTs`
  - Honor opts.sinceTs as oldest= and paginate conversations.history via response_metadata.next_cursor; document poll latency. Optionally add fs.watch for local.
- **No assignment/ownership model in local or slack issues** [beyond-spec, M] - packages/local-tracker, packages/slack-tracker `packages/local-tracker/src/boardStore.ts:read() omits assignee (no assignee_id in normalizeIssue input); packages/slack-tracker/src/client.ts toIssue omits assignee`
  - Allow an optional 'assignee' in local frontmatter and a Slack convention (emoji or mention token) mapped to assigneeId so existing assignment-based opt-out works.
- **No startup observability of active tracker kind, resolved board dir, or watched channels** [beyond-spec, S] - apps/cli/src/daemon.ts (createTrackerClient) + runtime startup `apps/cli/src/daemon.ts:34-44 (createTrackerClient logs nothing); packages/local-tracker/src/client.ts:16-18 (dir resolved vs process.cwd()); grep of runtime/src/index.ts for tracker.kind/path/channels returned NONE`
  - Emit one startup log event with tracker.kind plus the resolved absolute board dir (local) or watched channels + endpoint (slack). Also make the tool and read-client resolve the same absolute path to avoid cwd divergence.
- **demo/seed-issues.ts is Linear-only; no seeding path for the service-free trackers** [beyond-spec, S] - demo/seed-issues.ts `ts/demo/seed-issues.ts:1-10 (requires LINEAR_API_KEY+LINEAR_PROJECT_SLUG, imports LinearClient)`
  - Add a local-board mode that writes a few .symphony/board/BOARD-*.md fixtures via BoardStore.create so the no-service path is demoable end-to-end.

### config-secrets

- **cloneSettings shares tracker.channels and tracker.emojiStates by reference** [beyond-spec, S] - packages/config (cloneSettings) `ts/packages/config/src/index.ts:826`
  - In cloneSettings, copy channels as [...settings.tracker.channels] and emojiStates as a shallow object spread (guarding undefined), matching how dispatch and worker.sshHosts are already cloned.
- **tracker.channels validated only as non-empty, not as Slack channel IDs** [beyond-spec, S] - packages/config (validateDispatchConfig) `ts/packages/config/src/index.ts:418-420`
  - Validate or at least warn that each channel matches a Slack ID shape (e.g. /^[CGD][A-Z0-9]+$/) and reject leading '#'; at minimum improve the error to state 'channels must be Slack channel IDs (e.g. C0123...)'.
- **emoji_states accepts collisions, empty keys, and empty state values without validation** [beyond-spec, S] - packages/config (parseEmojiStates) / packages/slack-tracker (emojiForState) `ts/packages/config/src/index.ts:487-499; ts/packages/slack-tracker/src/mapping.ts:51-57`
  - In parseEmojiStates reject empty emoji keys and empty/blank state values; warn on many-to-one collisions; document that emoji_states must be a 1:1 emoji->state map for status round-tripping.

### documentation

- **No CHANGELOG entry for the two new trackers / tracker decoupling** [beyond-spec, S] - CHANGELOG.md `CHANGELOG.md:1-3 (newest section 2026-05-27)`
  - Add a dated section (e.g. 2026-05-29) describing the pluggable tracker abstraction and the new local (.symphony/board) and Slack backends, the new config keys, and the SLACK_BOT_TOKEN env var.
- **No migration notes from the Linear tracker to local/slack (config keys + MCP tool/server name changes + WORKFLOW.md adaptation)** [beyond-spec, S] - docs / CHANGELOG.md / ts/WORKFLOW.md `ts/WORKFLOW.md:90-116; ts/packages/mcp/src/agentEndpoint.ts:8`
  - Add a short 'Switching trackers' note covering the changed config keys per kind, the per-kind MCP server names (symphony_local/symphony_slack) and write tool names (local_*/slack_*), and that WORKFLOW.md prompt text referencing Linear/linear_graphql/symphony-linear must be adapted for the chosen backend.
- **Demo only seeds Linear; DEMO_WORKFLOW.md hard-coded to kind: linear; no service-free demo path** [beyond-spec, M] - ts/demo `ts/demo/README.md:1-12; ts/demo/seed-issues.ts; ts/demo/DEMO_WORKFLOW.md`
  - Add a local-tracker demo variant: a DEMO_WORKFLOW with kind: local plus a few prewritten .symphony/board/*.md files (or a tiny board seed), and document it in demo/README.md so the demo runs with no external tracker. Note the local path needs no token, unlike the current LINEAR_API_KEY/LINEAR_PROJECT_SLUG prereqs.
- **User-facing WORKFLOW.md prompt/examples for local and slack exist only as test fixtures** [in-spec, S] - ts/test/fixtures `ts/test/fixtures/workflow-local.md, ts/test/fixtures/workflow-slack.md`
  - Promote sanitized copies of the local/slack fixtures into user-facing docs (README config examples or example WORKFLOW files) with prompt bodies appropriate to each tracker, rather than leaving them as test-only fixtures.
- **Snake_case YAML keys (emoji_states/active_states/terminal_states) and free-form state-matching semantics undocumented** [beyond-spec, S] - ts/README.md / docs `ts/packages/config/src/index.ts:178-181; ts/packages/local-tracker/src/boardStore.ts:39-41; ts/packages/slack-tracker/src/mapping.ts:33-47`
  - Document the snake_case YAML keys and explain that for local/slack the active_states/terminal_states names must match the on-disk status / emoji-derived state names (case-insensitive), listing the default state vocabulary (Todo/In Progress/Done/Cancelled and, for local frontmatter, Backlog/Triage).

### error-resilience

- **BoardStore writes are non-atomic and unlocked; a crash mid-write can truncate an issue file and concurrent writers can collide on BOARD-<n>** [beyond-spec, M] - packages/local-tracker (BoardStore) `ts/packages/local-tracker/src/boardStore.ts:45-69, :88-92, :123-132`
  - Write to a temp file in the same dir and fs.rename into place for atomic replacement; for nextId, use O_EXCL create or a simple lockfile to avoid duplicate identifiers under concurrent writes.
- **Slack read path: no pagination (silently drops older mentions) and no per-channel error isolation (one bad channel blinds all)** [beyond-spec, M] - packages/slack-tracker (webTransport listMentions) `ts/packages/slack-tracker/src/webTransport.ts:23-35, :90-96`
  - Isolate per-channel failures in listMentions (try/catch per channel, log+skip the bad channel) and follow response_metadata.next_cursor pagination so high-traffic channels do not silently drop mentions.

### local-completeness

- **tracker.path does not expand ~ or $VARS (inconsistent with workspace.root)** [beyond-spec, S] - packages/config (parseTracker) `packages/config/src/index.ts:475`
  - Run tracker.path through expandLocalPath(value, env) inside parseTracker so ~ and $VARS resolve consistently with workspace.root.
- **Read client and MCP write tools resolve the board dir against process.cwd() independently of workspace.root** [beyond-spec, M] - packages/local-tracker (LocalTrackerClient) + packages/mcp (tools/local.ts storeFor) `packages/local-tracker/src/client.ts:14-18; packages/mcp/src/tools/local.ts:89-93`
  - Resolve a relative tracker.path against a stable, shared base (e.g. settings.workspace.root or the config-file dir) in both LocalTrackerClient and storeFor, or document that tracker.path must be absolute for the local backend.
- **No seeding/bootstrap path or empty-board signal for local issues** [beyond-spec, M] - demo/ + packages/local-tracker (first-run lifecycle) `ts/demo/seed-issues.ts:6,10; packages/local-tracker/src/boardStore.ts:75-86`
  - Add a local seed/bootstrap helper (small CLI or extend seed-issues.ts to honor kind=local by writing BOARD-n.md) and document the expected board layout + a sample first issue.
- **No guidance on whether .symphony/board is gitignored or committed** [beyond-spec, S] - packages/local-tracker + repo .gitignore + docs `packages/local-tracker/src/client.ts:7`
  - Add a package README documenting the intended lifecycle (committed shared backlog vs gitignored scratch) and either recommend a .gitignore entry or state committed-by-default so churn is expected.

### observability-ui

- **TUI status dashboard shows a hard-coded fake Linear project URL for local and slack trackers** [beyond-spec, S] - packages/tui (+ apps/cli projectUrlForSettings) `ts/packages/tui/src/index.tsx:135 (hard-coded fallback) and ts/apps/cli/src/main.ts:214-218 (projectUrlForSettings)`
  - Gate the Project line on a defined URL the same way the Dashboard line is gated (index.tsx:137), and drop the hard-coded linear.app fallback so the line is simply omitted when projectUrl is undefined. Optionally have projectUrlForSettings() switch on tracker.kind to return a meaningful label for local (board dir / tracker.path) and slack (channel list), or relabel the line per kind.
- **Long Slack issue identifiers overflow the fixed-width TUI columns and break table alignment** [beyond-spec, S] - packages/tui `ts/packages/tui/src/index.tsx:195 (running row padEnd(8)), :215 (retry row), :229 (dispatch block); :171-174 fixed-width header; identifier source ts/packages/slack-tracker/src/client.ts:53`
  - Apply the existing truncate() (index.tsx:436) to run.issueIdentifier before padEnd(8) in formatRunningRow, and to identifiers in the retry/dispatch rows for consistent width; or widen the ID column and recompute the header pad width. Alternatively shorten the Slack identifier scheme in slack-tracker/src/client.ts:53 to a presentation-friendly form.

### parity-crosscutting

- **demo/seed-issues.ts is Linear-only; the no-external-service local tracker has no demo seeding on-ramp** [beyond-spec, S] - ts/demo/seed-issues.ts `ts/demo/seed-issues.ts:10,49-99`
  - Add a kind switch in seed-issues.ts or a sibling demo/seed-board.ts that instantiates BoardStore from tracker.path and calls create() per demo task; document in demo README.
- **createTrackerClient is an if-chain, not an exhaustive switch over TrackerKind (and validateDispatchConfig is too) - defeats the spec's compile-time-safety intent** [in-spec, S] - apps/cli/src/daemon.ts + packages/config/src/index.ts `apps/cli/src/daemon.ts:36-43 ; packages/config/src/index.ts:405-414`
  - Convert both createTrackerClient and the tracker branch of validateDispatchConfig to switch(kind) with a default that calls assertNever(kind), matching mcp/src/tools.ts. Prioritize the daemon (composition root, most likely to be forgotten).
- **Local board create() allocates BOARD-<n> by directory scan with no atomicity; concurrent creates can clobber** [beyond-spec, S] - packages/local-tracker (BoardStore.create/nextId/write) `packages/local-tracker/src/boardStore.ts:59-70,84-88,131-138`
  - Write with flag:"wx" and on EEXIST re-derive the next n and retry; optionally guard create() with an in-process mutex.
- **slack_update_status fails (no-op) when no emoji maps to the requested status; constraint only surfaces at agent-call time** [in-spec, S] - packages/mcp/tools/slack.ts vs local/linear status updates `packages/mcp/src/tools/slack.ts:54-58 ; packages/slack-tracker/src/mapping.ts:60-66`
  - At slack config validation, cross-check that every terminal_state (and active transition target) has a reverse emoji in the resolved map and warn/error early; and/or list the allowed status vocabulary in the slack_update_status tool description so tools/list teaches the agent.
- **Slack startup workspace cleanup relies on fetchIssuesByStates, which is window-bounded - terminal issues past 200 messages leak workspaces (compounds the pagination gap)** [beyond-spec, M] - packages/slack-tracker (client.fetchIssuesByStates) + runtime cleanup `packages/slack-tracker/src/client.ts:36-40 ; packages/runtime/src/index.ts:665-677`
  - Fix as part of pagination (gap #1): once listMentions pages fully (bounded by sinceTs), fetchIssuesByStates and the cleanup path both become correct. Track explicitly so the cleanup implication is not lost.

### runtime-integration

- **ensemble:<n> is structurally impossible on Slack issues (no label channel), inconsistent with Local** [beyond-spec, S] - packages/issue + packages/slack-tracker + packages/dispatch `packages/issue/src/index.ts:66-74; packages/slack-tracker/src/client.ts:58; packages/dispatch/src/index.ts:87,101`
  - Document that Slack ensembles only follow the global agent.ensembleSize, or map a configured emoji/keyword to an ensemble size. Low priority relative to the routing/pagination gaps.
- **Slack dispatch ordering collapses to identifier lexical order because both priority and createdAt are null** [beyond-spec, S] - packages/dispatch + packages/slack-tracker `packages/dispatch/src/index.ts:121-135; packages/slack-tracker/src/client.ts:51-60`
  - Map the Slack message ts into created_at in toIssue (e.g. new Date(Number(ts)*1000).toISOString()) so FIFO ordering is explicit and robust. Optionally map a reaction to priority. Low effort, removes the lexical-ordering fragility.
- **reconcileTrackedIssues 'missing' branch leaks the on-disk workspace for a deleted / out-of-window Slack mention** [beyond-spec, M] - packages/runtime + packages/slack-tracker `packages/runtime/src/index.ts:591-598 vs 579-585; packages/slack-tracker/src/webTransport.ts:37-47`
  - Consider calling removeIssueWorkspaces on the 'missing' branch (optionally after a grace period to tolerate transient invisibility), and make Slack getMessage distinguish 'not found' from 'out of window' so a paged-out active mention is not mistaken for a deletion.

### security

- **Board directory path from config is not tilde-expanded or canonicalized; symlink/relative-cwd ambiguity; resolution logic duplicated** [beyond-spec, S] - packages/local-tracker/src/client.ts and packages/mcp/src/tools/local.ts (storeFor) `packages/local-tracker/src/client.ts:16-18; packages/mcp/src/tools/local.ts:89-93`
  - Expand a leading '~' to os.homedir(); centralize dir resolution in one helper used by both LocalTrackerClient and the MCP storeFor; and when adding the containment guard from the primary finding, compare against fs.realpathSync of the board dir so symlinked boards are handled consistently.

### slack-completeness

- **opts.sinceTs is a dead parameter: no incremental polling, full history re-derived every loop** [beyond-spec, M] - packages/slack-tracker (transport.ts, webTransport.ts, client.ts, inMemoryTransport.ts) `packages/slack-tracker/src/transport.ts:9 ; packages/slack-tracker/src/webTransport.ts:23 ; packages/slack-tracker/src/client.ts:20`
  - Thread runtime.lastPollAt through fetchCandidateIssues into listMentions opts.sinceTs and pass it as the Slack 'oldest' param. Pairs naturally with the pagination fix as the paging terminator.
- **No rate-limit / 429 / transient-error handling; one error aborts the whole poll** [beyond-spec, M] - packages/slack-tracker/src/webTransport.ts `packages/slack-tracker/src/webTransport.ts:90 ; packages/slack-tracker/src/webTransport.ts:25`
  - Detect 429 (HTTP status and 'ratelimited' error) and honor Retry-After; add bounded backoff/retry for 5xx and timeouts; wrap per-channel iteration so one channel failure does not abort the rest.
- **Edited/deleted/tombstoned messages and bot self-authored messages not handled** [beyond-spec, M] - packages/slack-tracker (webTransport.ts mapping) `packages/slack-tracker/src/webTransport.ts:100 ; packages/slack-tracker/src/webTransport.ts:5`
  - Skip messages with bot_id / self-authored subtypes; treat message_deleted/tombstone as dropping the issue; optionally retain reaction.users to distinguish bot- vs human-added emoji. Coordinate the self-message part with the bot-id resolution from gap #1.

### testing-gaps

- **No integration test drives a real Local/Slack client through the runtime poll -> dispatch loop** [beyond-spec, M] - packages/runtime (test) + local-tracker/slack-tracker clients `packages/runtime/test/runtime.test.ts:31-32 (all 22 client stubs are inline)`
  - Add one runtime integration test: build a LocalTrackerClient over a seeded temp board (and a SlackTrackerClient over InMemorySlackTransport), pass as the runtime client, run pollOnce({dryRun:true}), and assert candidates/eligible counts match the active-state issue exactly as the linear path does.
- **No transport-level test that the MCP/HTTP server exposes local_*/slack_* tools via tools/list and runs them via tools/call** [beyond-spec, M] - packages/server (http-server.test.ts) + packages/mcp/src/server.ts, agentEndpoint.ts `packages/server/test/http-server.test.ts:231 (asserts only linear_graphql)`
  - Parameterize an http-server (or mcp/server) test for kind=local and kind=slack: assert tools/list returns the expected per-kind names and one tools/call succeeds over JSON-RPC.
- **BoardStore create()/updateStatus/appendComment are read-then-write with no locking; no concurrency test** [beyond-spec, M] - packages/local-tracker/src/boardStore.ts (test/board-store.test.ts) `packages/local-tracker/src/boardStore.ts:58-69 (create -> nextId then write), :88-91 (nextId readdir+max), :45-50/52-56 (updateStatus/appendComment parse-then-write)`
  - Add a Promise.all concurrency test asserting unique ids / no lost updates; if it fails, make id allocation atomic (exclusive 'wx' open with retry) before relying on the board under any concurrency.
- **slack_update_status transport-failure (partial swap) and multi-stale-emoji cleanup are untested** [beyond-spec, S] - packages/mcp/src/tools/slack.ts (slack-tools.test.ts) `packages/mcp/test/slack-tools.test.ts (happy swap + no-op + missing-emoji only); packages/mcp/src/tools/slack.ts:57-65`
  - Add a test where the transport throws on add/remove (assert success:false with a clear error) and one with multiple stale status emojis (assert all stale removed, only target remains).

### usability-e2e

- **defaultPromptTemplate and continuationPrompt hard-code 'Linear issue', injected verbatim on local/slack continuation turns** [beyond-spec, S] - packages/workflow (defaultPromptTemplate) + packages/prompt (continuationPrompt) `ts/packages/workflow/src/index.ts:9, ts/packages/prompt/src/index.ts:38`
  - Parameterize both strings by tracker kind or use a neutral 'issue'/'task' noun. continuationPrompt could accept the kind (or just say 'the issue is still in an active state' generically).
- **No onboarding path to create the first local-board issue, so a fresh kind=local run has nothing to dispatch** [beyond-spec, S] - demo/seed-issues.ts + docs `demo/seed-issues.ts:1-9`
  - Provide a local-board seeding helper (or a 'board new' style command) and/or document the .symphony/board file format so a user can do an end-to-end local run without reverse-engineering BoardStore's on-disk shape.

## NIT (5)

### beyond-spec-critic

- **mcpConfigContents still hardcodes serverName='symphony_linear' default and is never called with a kind** [in-spec, S] - packages/mcp (agentEndpoint.ts) `packages/mcp/src/agentEndpoint.ts:74-76 (serverName='symphony_linear' default)`
  - Either delete the unused helper or change its signature to take a TrackerKind and call trackerMcpServerName(kind). Confirm no callers first.
- **Agents must infer per-kind tool names/issueId formats; main WORKFLOW.md unchanged** [beyond-spec, S] - packages/mcp tool specs + WORKFLOW guidance `packages/mcp/src/tools/slack.ts:50-52 (issueId '<channel>:<ts>' enforced only at execution time); spec 'WORKFLOW.md handling' section (fixtures only, no main edit)`
  - Optionally enrich slack tool descriptions with a concrete issueId example, or inject a tiny per-kind preamble at runtime. Beyond-spec polish.

### config-secrets

- **endpoint default stays the Linear GraphQL URL for kind: local (and memory)** [beyond-spec, S] - packages/config (defaultSettings / parseTracker) `ts/packages/config/src/index.ts:273,468,474`
  - Set endpointDefault to '' (or omit) for kinds that do not use it (local/memory), or document that endpoint is ignored for non-linear/non-slack kinds.

### slack-completeness

- **Single-workspace assumption; issue id has no team/workspace component** [beyond-spec, S] - packages/slack-tracker (webTransport.ts, client.ts) ; packages/domain TrackerSettings `packages/slack-tracker/src/webTransport.ts:19 ; packages/slack-tracker/src/client.ts:52`
  - Document the single-workspace assumption in the slack-tracker README/config docs, or include a team id in the issue id/identifier. Optionally validate channel ids resolve within the configured token's workspace.

### testing-gaps

- **trackerMcpServerName not asserted for 'local' and 'slack' kinds** [in-spec, S] - packages/mcp (server-name.test.ts) + agentEndpoint.ts `packages/mcp/test/server-name.test.ts:7-11`
  - Add two one-line asserts (symphony_local, symphony_slack) to lock the spec's symphony_${kind} contract for the new kinds.

## ENHANCEMENT (5)

### beyond-spec-critic

- **GitHub Issues adapter from the inspiration was never built** [beyond-spec, L] - packages/* (no github-tracker package) `n/a (only linear, memory, local, slack packages exist)`
  - Add @symphony/github-tracker (issues as issues, labels as routes/status, comments as comments) as the next adapter to validate the abstraction. Out of this spec's scope.

### local-completeness

- **Every poll re-reads and re-parses every issue file (no mtime cache)** [beyond-spec, M] - packages/local-tracker (BoardStore.byStatus/list) `packages/local-tracker/src/boardStore.ts:40-43`
  - Optional: add an mtime-based cache (stat each file, reparse only on mtime change) or short-circuit list() when the directory mtime is unchanged; keep behavior identical.
- **Local issues never carry branchName, priority, or labels written by agents (by-design YAGNI)** [in-spec, M] - packages/local-tracker + packages/mcp tools/local.ts `packages/local-tracker/src/boardStore.ts:94-108; packages/mcp/src/tools/local.ts:8`
  - If branch suggestion matters for the git workflow, derive a deterministic branchName from identifier/title in read(); else leave as-is per the spec's stated YAGNI.

### runtime-integration

- **validateDispatchConfig does no Slack-vs-dispatch sanity check (missed mitigation tying gaps #1/#3 together)** [beyond-spec, S] - packages/config `packages/config/src/index.ts:403-441`
  - Add a startup warning (or hard error for acceptUnrouted===false with onlyRoutes constraints) in the slack branch of validateDispatchConfig noting that Slack issues cannot carry route/ensemble labels, so dispatch must rely on acceptUnrouted and the global ensemble default.

### testing-gaps

- **No opt-in live Slack Web API smoke test** [beyond-spec, S] - packages/slack-tracker (test) `n/a (no skipIf/SLACK_LIVE anywhere)`
  - Optional: add test.skipIf(!process.env.SLACK_LIVE_TOKEN) smoke test (list mentions, react, reply in a throwaway channel), kept out of CI by default.
