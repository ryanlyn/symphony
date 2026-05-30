import { test } from "vitest";
import fc from "fast-check";
import { resumeStateMatches } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import type { ResumeState } from "@symphony/resume-state";



// --- Arbitraries ---

/** Non-blank string arbitrary (at least one non-whitespace character). */
const nonBlankString = fc
  .string({ minLength: 1, maxLength: 50, unit: "grapheme" })
  .filter((s) => s.trim() !== "");

/** Arbitrary for AgentKind (non-blank string). */
const agentKindArb = fc.oneof(
  fc.constantFrom("claude", "codex", "custom-agent"),
  nonBlankString,
);

/** Arbitrary for a non-blank resumeId. */
const resumeIdArb = nonBlankString;

/** Arbitrary for a nullable string field (either a non-blank string or null/undefined). */
const _nullableStringArb = fc.oneof(
  nonBlankString,
  fc.constant(null),
  fc.constant(undefined),
);

/** Arbitrary that produces a valid workspace path (non-blank). */
const workspacePathArb = nonBlankString;

/** Arbitrary that produces a valid workerHost or null. */
const workerHostArb = fc.oneof(nonBlankString, fc.constant(null), fc.constant(undefined));

/** Arbitrary for a minimal valid Issue. */
function issueArb(): fc.Arbitrary<Issue> {
  return fc.record({
    id: nonBlankString,
    identifier: nonBlankString,
    title: fc.string(),
    state: nonBlankString,
    labels: fc.constant([] as string[]),
    blockers: fc.constant([] as Issue["blockers"]),
  });
}

/** Arbitrary for a ResumeState that fully matches a given input configuration. */
function matchingStateAndInput(): fc.Arbitrary<{
  state: ResumeState;
  input: { agentKind: string; issue: Issue; workspacePath: string; workerHost?: string | null };
}> {
  return fc
    .record({
      agentKind: agentKindArb,
      resumeId: resumeIdArb,
      issue: issueArb(),
      workspacePath: workspacePathArb,
      workerHost: workerHostArb,
    })
    .map(({ agentKind, resumeId, issue, workspacePath, workerHost }) => ({
      state: {
        agentKind,
        resumeId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueState: issue.state,
        workspacePath,
        workerHost: workerHost ?? null,
      } as ResumeState,
      input: {
        agentKind,
        issue,
        workspacePath,
        workerHost: workerHost ?? null,
      },
    }));
}

// --- Invariant 1: Reuse SHALL occur only when agent kind, issue identity, workspace, and host all match ---

test("invariant-1: resumeStateMatches returns true only when agentKind, issue identity, workspace, and host all match", () => {
  fc.assert(
    fc.property(matchingStateAndInput(), ({ state, input }) => {
      // When all fields align, the result is true
      const result = resumeStateMatches(state, input);
      assert.equal(result, true);
    }),
  );
});

test("invariant-1a: resumeStateMatches returns false when agentKind differs", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      agentKindArb,
      ({ state, input }, differentAgentKind) => {
        // Skip when the "different" value happens to be the same
        fc.pre(differentAgentKind !== state.agentKind);
        const mismatchedState: ResumeState = { ...state, agentKind: differentAgentKind };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1b: resumeStateMatches returns false when issue id differs", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      nonBlankString,
      ({ state, input }, differentIssueId) => {
        fc.pre(differentIssueId !== input.issue.id);
        const mismatchedState: ResumeState = { ...state, issueId: differentIssueId };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1c: resumeStateMatches returns false when issue identifier differs", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      nonBlankString,
      ({ state, input }, differentIdentifier) => {
        fc.pre(differentIdentifier !== input.issue.identifier);
        const mismatchedState: ResumeState = { ...state, issueIdentifier: differentIdentifier };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1d: resumeStateMatches returns false when workspace path differs", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      nonBlankString,
      ({ state, input }, differentWorkspace) => {
        fc.pre(differentWorkspace !== input.workspacePath);
        const mismatchedState: ResumeState = { ...state, workspacePath: differentWorkspace };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1e: resumeStateMatches returns false when workerHost differs", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      nonBlankString,
      ({ state, input }, differentHost) => {
        // Ensure input expects a specific host and state stores a different one
        fc.pre(differentHost !== (input.workerHost ?? ""));
        const mismatchedInput = { ...input, workerHost: differentHost };
        // The state has the original workerHost; the input now wants something different
        const result = resumeStateMatches(state, mismatchedInput);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1f: resumeStateMatches returns false when issue state differs", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      nonBlankString,
      ({ state, input }, differentIssueState) => {
        fc.pre(differentIssueState !== input.issue.state);
        const mismatchedState: ResumeState = { ...state, issueState: differentIssueState };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1g: resumeStateMatches returns false when resumeId is blank", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      fc.constantFrom("", "   ", "\t", "\n"),
      ({ state, input }, blankResumeId) => {
        const mismatchedState: ResumeState = { ...state, resumeId: blankResumeId };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1h: resumeStateMatches requires workerHost null in state when input workerHost is null", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput().map(({ state, input }) => ({
        state: { ...state, workerHost: null } as ResumeState,
        input: { ...input, workerHost: null },
      })),
      ({ state, input }) => {
        // When both are null/undefined, it matches
        const result = resumeStateMatches(state, input);
        assert.equal(result, true);
      },
    ),
  );
});

test("invariant-1i: resumeStateMatches returns false when stored fields are blank/null but input has values", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      ({ state, input }) => {
        // Blank out the stored issueId -- the function requires stored strings to be non-blank
        const mismatchedState: ResumeState = { ...state, issueId: "" };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});

test("invariant-1j: resumeStateMatches returns false when stored workspacePath is null but input has a value", () => {
  fc.assert(
    fc.property(
      matchingStateAndInput(),
      ({ state, input }) => {
        const mismatchedState: ResumeState = { ...state, workspacePath: null };
        const result = resumeStateMatches(mismatchedState, input);
        assert.equal(result, false);
      },
    ),
  );
});
