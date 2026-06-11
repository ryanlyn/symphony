import { test } from "vitest";
import { assert } from "@symphony/test-utils";

test("assert.equal accepts an optional assertion message", () => {
  assert.equal("matching", "matching");
  assert.equal("matching", "matching", "fixture-name");
});
