import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { buildPrompt } from "../src/index.js";
import type { Issue } from "../src/index.js";

interface PromptParityFixture {
  name: string;
  template: string;
  issue: Issue;
  options: {
    attempt?: number | null;
    slotIndex?: number;
    ensembleSize?: number;
  };
  expected: string;
}

test("shared prompt fixtures render with Liquid exactly like Elixir Solid", async () => {
  const fixtures = JSON.parse(
    await fs.readFile(new URL("./fixtures/prompt-parity.json", import.meta.url), "utf8"),
  ) as PromptParityFixture[];

  for (const fixture of fixtures) {
    const prompt = await buildPrompt(fixture.template, fixture.issue, fixture.options);
    assert.equal(prompt, fixture.expected, fixture.name);
  }
});
