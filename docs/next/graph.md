# Module graph: differences from the Electron scan

`crates/core/src/graph` replaces `packages/plugins/dependencies/main/scan.ts` (TypeScript compiler API) with oxc_parser + oxc_resolver. The page (`apps/next/src/features/graph`) cuts the result to packages, folders or files in `graph.ts`, which replaces `shared/graph.ts`.

## Shape

- One `GraphImport` per import statement (from, to, specifier, kind, external, unresolved, line) instead of deduplicated `[from, to]` index pairs. The page aggregates them per level and keeps them as evidence for "why does A import B".
- Packages carry only `name` and `dir`. Versions and declared dependencies are gone; package edges come from real imports between files plus the externals they import.
- A package without a `name` is called after its folder; only the root one is called `root`.
- Externals (node_modules packages, node builtins, `bun:` style schemes, packages declared in package.json but not installed, `@types/*`-only packages) are reported by package name instead of dropped.
- Imports that resolve to nothing are reported as unresolved, with file and line, instead of dropped.
- Kinds: static, type (`import type`, every specifier `type`, same for `export ... from`), dynamic (`import()` with a literal), require.
- Cycles are computed in Rust over static, dynamic and require imports: one per strongly connected group, as its shortest loop. Type-only imports never make a cycle. The page also groups cycles per level.
- Files that fail to parse are listed in `errors` instead of being skipped silently.

## Resolution

- tsconfig: the nearest `tsconfig.json` to each importing file (oxc_resolver auto discovery, `extends` followed). The old scan read every `tsconfig*.json` at known places (like `tsconfig.web.json`); a `paths` entry that lives only in such a side file is not seen now.
- `package.json` `exports` with conditions `types`, `import`, `require`, `node`, `default`, then `module` / `main`.
- `.js` / `.jsx` / `.mjs` / `.cjs` specifiers try the TS sources first (`./util.js` finds `util.ts`).
- Workspace packages resolve by name to their folder even when node_modules is not linked.
- Targets outside the graph (css, json, assets, `.d.ts`) drop the import, as before.
- `.vue` and `.svelte` files are scanned: every `<script>` block, lines kept.
- Files come from `git ls-files -co --exclude-standard`, so the root must be in a git work tree; symlinked files are skipped.

## Speed

This repo: about 650 files and 2900 imports in about 130 ms (parallel parse, one arena per thread). `scan_this_repo` in `crates/core/src/graph/tests.rs` checks known packages and edges.
