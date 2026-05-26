import { test } from "vitest";
import { issueMcpToken, revokeMcpToken, validMcpToken } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

test("issueMcpToken — returns a unique, non-empty cryptographically strong string", () => {
  const token = issueMcpToken();
  assert.ok(token.length > 0);
  assert.equal(typeof token, "string");

  const second = issueMcpToken();
  assert.notEqual(token, second);

  // base64url: no +, /, or = characters
  assert.notMatch(token, /[+/=]/);

  revokeMcpToken(token);
  revokeMcpToken(second);
});

test("validMcpToken — returns true for actively issued tokens", () => {
  const token = issueMcpToken();
  assert.equal(validMcpToken(token), true);

  revokeMcpToken(token);
});

test("validMcpToken — returns false for random/fake tokens", () => {
  assert.equal(validMcpToken("not-a-real-token"), false);
  assert.equal(validMcpToken(""), false);
  assert.equal(validMcpToken(null), false);
  assert.equal(validMcpToken(undefined), false);
});

test("revokeMcpToken — revoking a token causes validMcpToken to return false", () => {
  const token = issueMcpToken();
  assert.equal(validMcpToken(token), true);

  revokeMcpToken(token);
  assert.equal(validMcpToken(token), false);
});

test("revokeMcpToken — calling revoke twice or with invalid inputs is a safe no-op", () => {
  const token = issueMcpToken();
  revokeMcpToken(token);
  revokeMcpToken(token);
  revokeMcpToken(null);
  revokeMcpToken(undefined);
  revokeMcpToken("nonexistent-token");
  assert.equal(validMcpToken(token), false);
});
