import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

type JsonObject = Record<string, unknown>;

type PackageJson = {
  name: string;
  version?: string;
  private?: boolean;
  type?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
};

type WorkspacePackage = {
  name: string;
  relativeDir: string;
  absoluteDir: string;
  packageJson: PackageJson;
};

export type CliReleaseManifest = {
  schemaVersion: 1;
  version: string;
  entrypoint: string;
  dashboardDist: string;
  installCommand: string;
  packages: Array<{ name: string; path: string }>;
  externalDependencies: string[];
  nativeDependencies: string[];
};

export type StageCliReleaseOptions = {
  workspaceRoot?: string;
  outputRoot?: string;
  releaseName?: string;
  version?: string;
  force?: boolean;
  archive?: boolean;
};

export type StagedCliRelease = {
  releaseDir: string;
  archivePath?: string;
  manifest: CliReleaseManifest;
};

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const packageSearchRoots = ["apps", "packages", "extensions", "vendor"];
const releaseEntrypoint = "bin/symphony-ts";
const dashboardDist = "apps/symphony-dashboard/dist";
const nativeDependencyNames = new Set(["better-sqlite3"]);

export async function stageCliRelease(
  options: StageCliReleaseOptions = {},
): Promise<StagedCliRelease> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const allPackages = await readWorkspacePackages(workspaceRoot);
  const cliPackage = allPackages.get("@symphony/cli");
  if (!cliPackage) {
    throw new Error("Cannot stage CLI release: @symphony/cli package was not found.");
  }

  const version = options.version ?? cliPackage.packageJson.version ?? "0.0.0";
  const releaseName = options.releaseName ?? `symphony-ts-v${version}`;
  const outputRoot = path.resolve(
    options.outputRoot ?? path.join(workspaceRoot, "dist", "cli-release"),
  );
  const releaseDir = path.join(outputRoot, releaseName);
  const catalog = await readDefaultCatalog(workspaceRoot);
  const packages = resolvePackageClosure(cliPackage, allPackages);
  const releasePackages = [...packages.values()].sort((left, right) =>
    left.relativeDir.localeCompare(right.relativeDir),
  );

  await assertRequiredBuildOutputs(workspaceRoot, releasePackages);
  await prepareOutputDir(releaseDir, Boolean(options.force));

  for (const workspacePackage of releasePackages) {
    await stageWorkspacePackage(releaseDir, workspacePackage, packages, catalog);
  }

  await copyDirectory(
    path.join(workspaceRoot, dashboardDist),
    path.join(releaseDir, dashboardDist),
  );
  await writeRootPackageJson(releaseDir, version);
  await writeEntrypoint(releaseDir);
  await copyReleaseMetadata(workspaceRoot, releaseDir);

  const manifest = releaseManifest(version, releasePackages, catalog);
  await writeJson(path.join(releaseDir, "RELEASE-MANIFEST.json"), manifest);

  const archivePath = options.archive
    ? await createArchive(outputRoot, releaseName, releaseDir, Boolean(options.force))
    : undefined;

  return archivePath ? { releaseDir, archivePath, manifest } : { releaseDir, manifest };
}

async function readWorkspacePackages(
  workspaceRoot: string,
): Promise<Map<string, WorkspacePackage>> {
  const packages = new Map<string, WorkspacePackage>();

  for (const searchRoot of packageSearchRoots) {
    const absoluteSearchRoot = path.join(workspaceRoot, searchRoot);
    const entries = await fs.readdir(absoluteSearchRoot, { withFileTypes: true }).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const relativeDir = path.posix.join(searchRoot, entry.name);
      const absoluteDir = path.join(workspaceRoot, relativeDir);
      const packagePath = path.join(absoluteDir, "package.json");
      const packageJson = await readJson<PackageJson>(packagePath).catch((error) => {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      });
      if (!packageJson) continue;

      packages.set(packageJson.name, {
        name: packageJson.name,
        relativeDir,
        absoluteDir,
        packageJson,
      });
    }
  }

  return packages;
}

async function readDefaultCatalog(workspaceRoot: string): Promise<Record<string, string>> {
  const workspaceYaml = YAML.parse(
    await fs.readFile(path.join(workspaceRoot, "pnpm-workspace.yaml"), "utf8"),
  ) as { catalog?: Record<string, string> } | null;

  return workspaceYaml?.catalog ?? {};
}

function resolvePackageClosure(
  rootPackage: WorkspacePackage,
  allPackages: Map<string, WorkspacePackage>,
): Map<string, WorkspacePackage> {
  const selected = new Map<string, WorkspacePackage>();
  const pending = [rootPackage];

  for (const workspacePackage of pending) {
    if (selected.has(workspacePackage.name)) continue;

    selected.set(workspacePackage.name, workspacePackage);

    for (const [dependencyName, specifier] of Object.entries(
      workspacePackage.packageJson.dependencies ?? {},
    )) {
      if (!specifier.startsWith("workspace:")) continue;

      const dependency = allPackages.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `${workspacePackage.name} depends on missing workspace package ${dependencyName}.`,
        );
      }
      pending.push(dependency);
    }
  }

  return selected;
}

async function assertRequiredBuildOutputs(
  workspaceRoot: string,
  packages: WorkspacePackage[],
): Promise<void> {
  const missing: string[] = [];

  for (const workspacePackage of packages) {
    const distDir = path.join(workspacePackage.absoluteDir, "dist");
    if (!(await pathExists(distDir))) {
      missing.push(path.posix.join(workspacePackage.relativeDir, "dist"));
    }

    if (workspacePackage.name === "@symphony/cli") {
      await requireFile(path.join(workspacePackage.absoluteDir, "dist", "bin", "cli.js"), missing);
      await requireFile(path.join(workspacePackage.absoluteDir, "bin", "symphony-ts.js"), missing);
    }

    if (workspacePackage.name === "@agentclientprotocol/claude-agent-acp") {
      await requireFile(path.join(workspacePackage.absoluteDir, "dist", "bundle.js"), missing);
    }
  }

  if (!(await pathExists(path.join(workspaceRoot, dashboardDist)))) {
    missing.push(dashboardDist);
  }

  if (missing.length > 0) {
    throw new Error(
      [
        "Cannot stage CLI release because required build outputs are missing:",
        ...missing.map((entry) => `- ${entry}`),
        "Run `mise run build` from ts/ before staging the release.",
      ].join("\n"),
    );
  }
}

async function requireFile(filePath: string, missing: string[]): Promise<void> {
  if (await pathExists(filePath)) return;
  missing.push(pathRelativeToCwd(filePath));
}

async function prepareOutputDir(releaseDir: string, force: boolean): Promise<void> {
  if (await pathExists(releaseDir)) {
    if (!force) {
      throw new Error(
        `Release directory already exists: ${releaseDir}. Pass --force to replace it.`,
      );
    }
    await fs.rm(releaseDir, { recursive: true, force: true });
  }

  await fs.mkdir(releaseDir, { recursive: true });
}

async function stageWorkspacePackage(
  releaseDir: string,
  workspacePackage: WorkspacePackage,
  selectedPackages: Map<string, WorkspacePackage>,
  catalog: Record<string, string>,
): Promise<void> {
  const targetDir = path.join(releaseDir, workspacePackage.relativeDir);
  await fs.mkdir(targetDir, { recursive: true });
  await copyDirectory(
    path.join(workspacePackage.absoluteDir, "dist"),
    path.join(targetDir, "dist"),
  );

  if (workspacePackage.name === "@symphony/cli") {
    await copyDirectory(
      path.join(workspacePackage.absoluteDir, "bin"),
      path.join(targetDir, "bin"),
    );
    await makeExecutable(path.join(targetDir, "bin", "symphony-ts.js"));
  }

  await writeJson(
    path.join(targetDir, "package.json"),
    releasePackageJson(workspacePackage, selectedPackages, catalog),
  );
}

function releasePackageJson(
  workspacePackage: WorkspacePackage,
  selectedPackages: Map<string, WorkspacePackage>,
  catalog: Record<string, string>,
): PackageJson {
  const source = workspacePackage.packageJson;
  const releasePackage = withoutUndefined({
    name: source.name,
    version: source.version,
    private: true,
    type: source.type,
    main: source.main,
    types: source.types,
    exports: source.exports,
    bin: source.bin,
  }) as PackageJson;
  const dependencies = rewriteDependencies(
    source.dependencies ?? {},
    workspacePackage,
    selectedPackages,
    catalog,
  );

  if (Object.keys(dependencies).length > 0) {
    releasePackage.dependencies = dependencies;
  }

  return releasePackage;
}

function rewriteDependencies(
  dependencies: Record<string, string>,
  owner: WorkspacePackage,
  selectedPackages: Map<string, WorkspacePackage>,
  catalog: Record<string, string>,
): Record<string, string> {
  const rewritten: Record<string, string> = {};

  for (const [dependencyName, specifier] of Object.entries(dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (specifier.startsWith("workspace:")) {
      const dependency = selectedPackages.get(dependencyName);
      if (!dependency) {
        throw new Error(`${owner.name} has unstaged workspace dependency ${dependencyName}.`);
      }

      rewritten[dependencyName] = fileSpecifierBetween(owner.relativeDir, dependency.relativeDir);
      continue;
    }

    rewritten[dependencyName] = resolveCatalogSpecifier(dependencyName, specifier, catalog);
  }

  return rewritten;
}

function resolveCatalogSpecifier(
  dependencyName: string,
  specifier: string,
  catalog: Record<string, string>,
): string {
  if (specifier === "catalog:") {
    const catalogSpecifier = catalog[dependencyName];
    if (!catalogSpecifier) {
      throw new Error(`No default catalog entry exists for dependency ${dependencyName}.`);
    }
    return catalogSpecifier;
  }

  if (specifier.startsWith("catalog:")) {
    throw new Error(
      `Named catalog specifiers are not supported in the CLI release yet: ${specifier}`,
    );
  }

  return specifier;
}

function fileSpecifierBetween(fromRelativeDir: string, toRelativeDir: string): string {
  const relative = path.posix.relative(fromRelativeDir, toRelativeDir);
  return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
}

async function writeRootPackageJson(releaseDir: string, version: string): Promise<void> {
  await writeJson(path.join(releaseDir, "package.json"), {
    name: "symphony-ts-release",
    version,
    private: true,
    type: "module",
    bin: {
      "symphony-ts": `./${releaseEntrypoint}`,
    },
    scripts: {
      start: "node ./node_modules/@symphony/cli/dist/bin/cli.js",
    },
    dependencies: {
      "@symphony/cli": "file:apps/cli",
    },
    engines: {
      node: ">=24",
    },
  });
}

async function writeEntrypoint(releaseDir: string): Promise<void> {
  const entrypointPath = path.join(releaseDir, releaseEntrypoint);
  await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
  await fs.writeFile(
    entrypointPath,
    `#!/usr/bin/env node

const cliUrl = new URL("../node_modules/@symphony/cli/dist/bin/cli.js", import.meta.url);

try {
  await import(cliUrl.href);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    console.error("symphony-ts release dependencies are not installed. Run npm install --omit=dev in the release directory.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
`,
  );
  await makeExecutable(entrypointPath);
}

async function copyReleaseMetadata(workspaceRoot: string, releaseDir: string): Promise<void> {
  await copyOptionalFile(path.join(workspaceRoot, "README.md"), path.join(releaseDir, "README.md"));
  await copyOptionalFile(
    path.join(workspaceRoot, "..", "LICENSE"),
    path.join(releaseDir, "LICENSE"),
  );
  await copyOptionalFile(path.join(workspaceRoot, "..", "NOTICE"), path.join(releaseDir, "NOTICE"));
}

function releaseManifest(
  version: string,
  packages: WorkspacePackage[],
  catalog: Record<string, string>,
): CliReleaseManifest {
  const externalDependencies = new Set<string>();

  for (const workspacePackage of packages) {
    for (const [dependencyName, specifier] of Object.entries(
      workspacePackage.packageJson.dependencies ?? {},
    )) {
      if (specifier.startsWith("workspace:")) continue;
      externalDependencies.add(dependencyName);
      resolveCatalogSpecifier(dependencyName, specifier, catalog);
    }
  }

  const nativeDependencies = [...externalDependencies]
    .filter((dependencyName) => nativeDependencyNames.has(dependencyName))
    .sort();

  return {
    schemaVersion: 1,
    version,
    entrypoint: releaseEntrypoint,
    dashboardDist,
    installCommand: "npm install --omit=dev",
    packages: packages.map((workspacePackage) => ({
      name: workspacePackage.name,
      path: workspacePackage.relativeDir,
    })),
    externalDependencies: [...externalDependencies].sort(),
    nativeDependencies,
  };
}

async function createArchive(
  outputRoot: string,
  releaseName: string,
  releaseDir: string,
  force: boolean,
): Promise<string> {
  const archivePath = `${releaseDir}.tar.gz`;
  if ((await pathExists(archivePath)) && !force) {
    throw new Error(`Release archive already exists: ${archivePath}. Pass --force to replace it.`);
  }

  if (force) {
    await fs.rm(archivePath, { force: true });
  }

  await execFileAsync("tar", ["-czf", archivePath, "-C", outputRoot, releaseName]);
  return archivePath;
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await fs.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    filter: (sourcePath) => !sourcePath.endsWith(".tsbuildinfo"),
  });
}

async function copyOptionalFile(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) return;
  await fs.copyFile(source, target);
}

async function makeExecutable(filePath: string): Promise<void> {
  await fs.chmod(
    filePath,
    constants.S_IRWXU |
      constants.S_IRGRP |
      constants.S_IXGRP |
      constants.S_IROTH |
      constants.S_IXOTH,
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function pathRelativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join(path.posix.sep);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/stage-cli-release.ts [options]

Options:
  --out-dir <path>   Directory that receives the staged release
  --name <name>      Release directory name
  --version <value>  Release package version
  --tarball          Also create a .tar.gz archive next to the release directory
  --force            Replace an existing release directory or archive
  --help             Show this help
`);
}

function parseArgs(args: string[]): StageCliReleaseOptions & { help?: boolean } {
  const options: StageCliReleaseOptions & { help?: boolean } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--out-dir":
        options.outputRoot = requiredValue(args, ++index, arg);
        break;
      case "--name":
        options.releaseName = requiredValue(args, ++index, arg);
        break;
      case "--version":
        options.version = requiredValue(args, ++index, arg);
        break;
      case "--tarball":
        options.archive = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = await stageCliRelease(options);
  console.log(`Staged Symphony CLI release at ${result.releaseDir}`);
  if (result.archivePath) {
    console.log(`Created archive at ${result.archivePath}`);
  }
  console.log(`Packages: ${result.manifest.packages.length}`);
  console.log(`Next step: ${result.manifest.installCommand}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
