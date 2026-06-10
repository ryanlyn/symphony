import fs from "node:fs/promises";
import path from "node:path";

import { shellEscape } from "@symphony/ssh";

/**
 * Reusable "fake SSH transport" shim for the always-on test layer.
 *
 * Adapted from `ts/test/workspace-prompt-resume.test.ts`'s `installEvalSsh`, this
 * writes an executable `ssh` shim into `<root>/bin`, prepends that directory to
 * `process.env.PATH`, and returns a teardown that restores `PATH`. Production
 * code that spawns `ssh` (via `@symphony/ssh`'s `runSsh`) then runs entirely
 * locally with ZERO daemon: the shim intercepts the canonical `$HOME` probe and
 * otherwise `export HOME=<remoteHome>; eval "$last_arg"`, executing the remote
 * command in a temp home. Every invocation is appended to `trace` so a test can
 * assert the exact argv (e.g. the `-p <port>` and `printf ready` the static-ssh
 * probe sends, and that NO workspace/hook command was ever sent).
 *
 * The shim lives under `src/test-support/` (not `test/`) so it compiles to
 * `dist/` and can be shared by the static-ssh provider test and any live/e2e
 * test that wants the same eval-ssh transport.
 */
export interface EvalSshHandle {
  /** The canonical (realpath-resolved) remote home the shim exports as `$HOME`. */
  remoteHome: string;
  /** The trace file every `ssh` invocation is appended to (one `ARGV:` line each). */
  trace: string;
  /** Reads the accumulated trace text (every `ssh` argv seen so far). */
  readTrace(): Promise<string>;
  /** Restores `process.env.PATH` to its pre-install value. */
  restore(): Promise<void>;
}

/**
 * Installs the eval-ssh shim under `root` and prepends its `bin` dir to `PATH`.
 * Always-on (no real daemon). Returns a handle exposing the canonical remote
 * home, the trace path/reader, and a `restore()` that reverts `PATH`.
 */
export async function installEvalSsh(root: string): Promise<EvalSshHandle> {
  const bin = path.join(root, "bin");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");

  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(remoteHome, { recursive: true });
  const canonicalRemoteHome = await fs.realpath(remoteHome);

  const sshShim = path.join(bin, "ssh");
  await fs.writeFile(
    sshShim,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
case "$last_arg" in
  *'printf "%s\\n" "$HOME"'*)
    printf '%s\\n' ${shellEscape(canonicalRemoteHome)}
    exit 0
    ;;
esac
export HOME=${shellEscape(canonicalRemoteHome)}
eval "$last_arg"
`,
  );
  await fs.chmod(sshShim, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  await fs.writeFile(trace, "");

  return {
    remoteHome: canonicalRemoteHome,
    trace,
    async readTrace(): Promise<string> {
      return fs.readFile(trace, "utf8");
    },
    async restore(): Promise<void> {
      // Restoring PATH is synchronous; the Promise return keeps the teardown
      // awaitable so callers can `await evalSsh.restore()` symmetrically.
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      return Promise.resolve();
    },
  };
}
