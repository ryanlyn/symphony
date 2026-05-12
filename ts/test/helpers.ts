import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function writeExecutable(filePath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source);
  await fs.chmod(filePath, 0o755);
}

export async function initGitRepo(dir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync("git", ["-C", dir, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Symphony Test"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(dir, "README.md"), "test\n");
  await execFileAsync("git", ["-C", dir, "add", "README.md"]);
  await execFileAsync("git", ["-C", dir, "commit", "-m", "initial"]);
}

export const sampleIssue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Test issue",
  description: "Ship it",
  state: "Todo",
  labels: ["Symphony:Backend"],
  blockers: [],
};
