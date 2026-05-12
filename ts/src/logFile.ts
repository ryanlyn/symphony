import { rmSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import pino, { type Logger } from "pino";

const require = createRequire(import.meta.url);
const buildPinoRoll = require("pino-roll") as (options: PinoRollOptions) => Promise<RollStream>;

export interface LogFileOptions {
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  now?: (() => Date) | undefined;
}

interface PinoRollOptions {
  file: string;
  size?: string | undefined;
  limit?: { count: number } | undefined;
  mkdir: boolean;
  sync: boolean;
}

interface RollStream {
  file: string;
  reopen(file: string): void;
  write(line: string): boolean;
}

export function defaultLogFile(root = process.cwd()): string {
  return path.join(root, "log", "symphony.log");
}

const loggers = new Map<string, Promise<Logger>>();

export async function configureLogFile(
  logFile: string,
  options: LogFileOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await prepareRollBase(logFile);
    const loggerPromise = createLogger(logFile, maxBytes, maxFiles, options.now ?? (() => new Date()));
    loggers.set(logFile, loggerPromise);
    const logger = await loggerPromise;
    logger.info({ event: "symphony_ts_started" });
  } catch (error) {
    loggers.delete(logFile);
    process.stderr.write(`warning: log_file_unavailable ${logFile}: ${errorMessage(error)}\n`);
  }
}

export async function appendLogEvent(
  logFile: string,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    const logger = await loggerForLogFile(logFile);
    logger.info(event);
  } catch (error) {
    process.stderr.write(`warning: log_file_unavailable ${logFile}: ${errorMessage(error)}\n`);
  }
}

async function loggerForLogFile(logFile: string): Promise<Logger> {
  let loggerPromise = loggers.get(logFile);
  if (!loggerPromise) {
    loggerPromise = createDefaultLogger(logFile);
    loggers.set(logFile, loggerPromise);
  }
  try {
    return await loggerPromise;
  } catch (error) {
    loggers.delete(logFile);
    throw error;
  }
}

async function createDefaultLogger(logFile: string): Promise<Logger> {
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await prepareRollBase(logFile);
  return createLogger(logFile, undefined, undefined, () => new Date());
}

async function createLogger(
  logFile: string,
  maxBytes: number | undefined,
  maxFiles: number | undefined,
  now: () => Date,
): Promise<Logger> {
  const rollStream = await buildPinoRoll({
    file: logFile,
    ...(maxBytes !== undefined && maxBytes > 0 ? { size: `${maxBytes}b` } : {}),
    ...(maxFiles !== undefined && maxFiles > 0
      ? { limit: { count: maxFiles } }
      : {}),
    mkdir: true,
    sync: true,
  });
  await pointStableLogPathAtCurrentFile(logFile, rollStream.file);
  const reopen = rollStream.reopen.bind(rollStream);
  rollStream.reopen = (file: string) => {
    reopen(file);
    pointStableLogPathAtCurrentFileSync(logFile, file);
  };
  return pino(
    {
      base: null,
      timestamp: false,
    },
    {
      write: (line: string) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        delete event.level;
        event.at ??= now().toISOString();
        rollStream.write(`${JSON.stringify(event)}\n`);
      },
    },
  );
}

async function prepareRollBase(logFile: string): Promise<void> {
  const existing = await lstatOrNull(logFile);
  if (!existing) return;
  if (existing.isSymbolicLink()) {
    await fs.unlink(logFile);
    return;
  }
  const nextPath = await nextRollFilePath(logFile);
  await fs.rename(logFile, nextPath);
}

async function pointStableLogPathAtCurrentFile(logFile: string, currentFile: string): Promise<void> {
  await fs.rm(logFile, { force: true });
  await fs.symlink(path.basename(currentFile), logFile);
}

function pointStableLogPathAtCurrentFileSync(logFile: string, currentFile: string): void {
  rmSync(logFile, { force: true });
  symlinkSync(path.basename(currentFile), logFile);
}

async function nextRollFilePath(logFile: string): Promise<string> {
  const directory = path.dirname(logFile);
  const baseName = path.basename(logFile);
  const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedBaseName}\\.(\\d+)$`);
  const numbers = (await fs.readdir(directory))
    .map((entry) => pattern.exec(entry)?.[1])
    .filter((entry): entry is string => entry !== undefined)
    .map((entry) => Number(entry));
  return `${logFile}.${Math.max(0, ...numbers) + 1}`;
}

async function lstatOrNull(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
