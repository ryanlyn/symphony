import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export interface SshRunOptions {
  timeoutMs?: number | undefined;
  stderrToStdout?: boolean | undefined;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface SshTarget {
  destination: string;
  port: string | null;
}

export async function runSsh(
  host: string,
  command: string,
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(`invalid_ssh_timeout: ${timeoutMs}`);

  return new Promise<SshRunResult>((resolve, reject) => {
    const child = spawn("ssh", sshArgs(host, command), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`ssh_timeout: ${host} ${timeoutMs}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (options.stderrToStdout) stdout += text;
      else stderr += text;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? "ssh_not_found" : error.message));
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status: status ?? 0 });
    });
  });
}

export function startSshProcess(host: string, command: string): ChildProcessWithoutNullStreams {
  return spawn("ssh", sshArgs(host, command), { stdio: ["pipe", "pipe", "pipe"] });
}

export function startReverseTunnel(
  host: string,
  remotePort: number,
  localHost: string,
  localPort: number,
): ChildProcessWithoutNullStreams {
  return spawn("ssh", reverseTunnelArgs(host, remotePort, localHost, localPort), {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function writeRemoteFile(
  host: string,
  remotePath: string,
  contents: string,
  options: SshRunOptions & { mode?: number | string | undefined } = {},
): Promise<void> {
  const command = [
    `mkdir -p ${shellEscape(path.posix.dirname(remotePath))}`,
    `printf '%s' ${shellEscape(contents)} > ${shellEscape(remotePath)}`,
    chmodCommand(options.mode, remotePath),
  ].join("\n");
  const result = await runSsh(host, command, { ...options, stderrToStdout: true });
  if (result.status !== 0)
    throw new Error(`remote_write_failed: ${result.status} ${result.stdout}`);
}

export function sshArgs(host: string, command: string): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(),
    "-T",
    ...(target.port ? ["-p", target.port] : []),
    target.destination,
    remoteShellCommand(command),
  ];
}

export function reverseTunnelArgs(
  host: string,
  remotePort: number,
  localHost: string,
  localPort: number,
): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(),
    "-T",
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    ...(target.port ? ["-p", target.port] : []),
    "-R",
    `${remotePort}:${localHost}:${localPort}`,
    target.destination,
  ];
}

export function remoteShellCommand(command: string): string {
  return `bash -lc ${shellEscape(command)}`;
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function parseSshTarget(target: string): SshTarget {
  const trimmed = target.trim();
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (!match) return { destination: trimmed, port: null };
  const destination = match[1] ?? "";
  const port = match[2] ?? "";
  if (validPortDestination(destination)) return { destination, port };
  return { destination: trimmed, port: null };
}

function sshConfigArgs(): string[] {
  const configPath = process.env.SYMPHONY_SSH_CONFIG;
  return configPath ? ["-F", configPath] : [];
}

function validPortDestination(destination: string): boolean {
  return destination !== "" && (!destination.includes(":") || bracketedHost(destination));
}

function bracketedHost(destination: string): boolean {
  return destination.includes("[") && destination.includes("]");
}

function chmodCommand(mode: number | string | undefined, remotePath: string): string {
  if (typeof mode === "number" && Number.isInteger(mode))
    return `chmod ${mode.toString(8)} ${shellEscape(remotePath)}`;
  if (typeof mode === "string" && mode.trim() !== "")
    return `chmod ${mode} ${shellEscape(remotePath)}`;
  return "true";
}
