# CLI Distribution

## Recommended Lane

Ship the CLI as a GitHub release artifact built from the monorepo, not as public npm split
packages.

The release input is a source-free tree staged by `pnpm release:stage`. It preserves the built
workspace layout that runtime code already expects, including:

- `apps/cli/dist` and the `symphony-ts` bin wrapper
- transitive built `packages/*`, `extensions/*`, and vendored ACP bridge packages used by the CLI
- `apps/symphony-dashboard/dist`, which the observability server resolves relative to built
  package code
- sanitized package manifests with `workspace:*` dependencies rewritten to local `file:` specs and
  `catalog:` dependencies rewritten to concrete versions

This keeps package names private and avoids publishing churn while the workspace boundaries and CLI
name are still settling.

## Build And Stage

Run from `ts/`:

```sh
mise run build
pnpm release:stage -- --force --tarball
```

The default output is:

```text
dist/cli-release/symphony-ts-v<version>/
dist/cli-release/symphony-ts-v<version>.tar.gz
```

The staged tree intentionally excludes source, tests, `.tsbuildinfo`, logs, and dashboard source.
It is not a registry package and should remain `private`.

## Release Asset Shape

The staging script proves the package graph and file selection. A one-command installer still needs
the release job to choose one of these final artifact shapes:

- Platform-specific runtime tree: run `npm install --omit=dev` inside the staged directory, verify
  `./bin/symphony-ts --help`, then archive that installed tree as a GitHub release asset. This is
  the best fit for `mise use github:ryanlyn/symphony` or `ubi:ryanlyn/symphony` because those
  backends download release assets and put executables on `PATH`.
- Installable npm tarball: pack the staged tree and install it with npm or npx from a URL. This can
  work without registry publishing, but it still uses npm install semantics, runs dependency
  install scripts, and exposes the generated package metadata. Keep it secondary until verified in
  CI.

`better-sqlite3` is a native dependency through `@symphony/server`, so installed runtime archives
are Node ABI and platform sensitive. Build and verify them under the same Node line declared in
`ts/mise.toml`.

## Why Not Direct npm Yet

`@symphony/cli` is private and its raw npm pack surface is a development package shape: it includes
the wrapper, sources, tests, and TypeScript config rather than a runnable CLI artifact. Publishing it
directly would also force public package naming decisions for internal workspace boundaries.

`npx` over git is worth revisiting after the staged tree is proven installable from a tarball URL.
For now, use it only as a compatibility experiment, not as the primary lane.

## Open Decisions

- Asset naming for GitHub release autodetection, including OS, architecture, and Node ABI labels.
- Whether the release asset should require a system Node 24 or carry a runtime wrapper.
- Whether the release job should extend `stage-cli-release.ts` with an `--install` mode or keep
  dependency installation in CI shell steps.
- Whether `pnpm deploy` can replace part of the staging script after it is validated against the
  workspace catalog and vendored bridge requirements.
