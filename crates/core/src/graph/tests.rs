use super::*;
use std::time::Instant;

fn write(root: &Path, path: &str, text: &str) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let status = Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir.path())
        .status()
        .unwrap();
    assert!(status.success());
    dir
}

fn edges(graph: &ModuleGraph) -> Vec<String> {
    let mut edges: Vec<String> = graph
        .imports
        .iter()
        .filter_map(|import| Some(format!("{} > {}", import.from, import.to.as_ref()?)))
        .collect();
    edges.sort();
    edges.dedup();
    edges
}

fn find<'g>(graph: &'g ModuleGraph, from: &str, specifier: &str) -> &'g GraphImport {
    graph
        .imports
        .iter()
        .find(|import| import.from == from && import.specifier == specifier)
        .unwrap_or_else(|| panic!("no import of {specifier} in {from}"))
}

/// Port of the Electron dependencies plugin's scan.test.ts
#[test]
fn scan_reads_packages_and_resolves_relative_extensionless_and_tsconfig_alias_imports() {
    let dir = repo();
    let root = dir.path();
    write(
        root,
        "package.json",
        r#"{"name":"repo","workspaces":["apps/*","packages/*"]}"#,
    );
    write(
        root,
        "apps/web/package.json",
        r#"{"name":"web","version":"1.0.0","dependencies":{"ui":"workspace:*","react":"^19"}}"#,
    );
    write(
        root,
        "packages/ui/package.json",
        r#"{"name":"ui","devDependencies":{"typescript":"6"}}"#,
    );
    write(
        root,
        "tsconfig.json",
        r#"{"compilerOptions":{"moduleResolution":"bundler","module":"esnext","paths":{"@ui/*":["./packages/ui/src/*"]}}}"#,
    );
    write(
        root,
        "apps/web/src/main.tsx",
        "import { Button } from '@ui/button'\nimport { util } from './util.js'\nimport React from 'react'\n",
    );
    write(
        root,
        "apps/web/src/util.ts",
        "export const util = 1\nexport * from '../lib'\n",
    );
    write(root, "apps/web/lib/index.ts", "export {}\n");
    write(
        root,
        "packages/ui/src/button.tsx",
        "export const Button = 1\n",
    );
    write(root, "node_modules/react/index.js", "");

    let graph = scan(root).unwrap();
    let mut names: Vec<&str> = graph
        .packages
        .iter()
        .map(|package| package.name.as_str())
        .collect();
    names.sort();
    assert_eq!(names, ["repo", "ui", "web"]);
    assert_eq!(
        edges(&graph),
        [
            "apps/web/src/main.tsx > apps/web/src/util.ts",
            "apps/web/src/main.tsx > packages/ui/src/button.tsx",
            "apps/web/src/util.ts > apps/web/lib/index.ts",
        ]
    );
    let react = find(&graph, "apps/web/src/main.tsx", "react");
    assert_eq!(
        (react.external.as_deref(), react.unresolved, react.line),
        (Some("react"), false, 3)
    );
    let file = |path: &str| graph.files.iter().find(|file| file.path == path).unwrap();
    assert_eq!(
        file("packages/ui/src/button.tsx").package.as_deref(),
        Some("ui")
    );
    assert_eq!(
        file("apps/web/lib/index.ts").package.as_deref(),
        Some("web")
    );
}

#[test]
fn scan_tells_import_kinds_externals_unresolved_and_parse_errors_apart() {
    let dir = repo();
    let root = dir.path();
    write(
        root,
        "package.json",
        r#"{"name":"app","dependencies":{"lodash":"4"},"devDependencies":{"@types/mdast":"4"}}"#,
    );
    write(
        root,
        "src/a.ts",
        [
            "import type { B } from './b'",
            "import { type C } from './c'",
            "export { d } from './d'",
            "export type { E } from './e'",
            "const f = await import('./f')",
            "const g = require(`./g`)",
            "import fs from 'node:fs'",
            "import path from 'path'",
            "import { pick } from 'lodash/pick'",
            "import ghost from '@app/ghost'",
            "import missing from './missing'",
            "import './styles.css'",
            "import types from './types'",
            "import type { Root } from 'mdast'",
            "import { test } from 'bun:test'",
        ]
        .join("\n")
        .as_str(),
    );
    for name in ["b", "c", "d", "e", "f"] {
        write(root, &format!("src/{name}.ts"), "export {}\n");
    }
    write(root, "src/g.cjs", "module.exports = {}\n");
    write(root, "src/styles.css", "a {}\n");
    write(root, "src/types.d.ts", "export {}\n");
    write(root, "src/broken.ts", "import { from './a'\nconst = 1\n");

    let graph = scan(root).unwrap();
    let kind = |specifier: &str| find(&graph, "src/a.ts", specifier).kind;
    assert_eq!(kind("./b"), ImportKind::Type);
    assert_eq!(kind("./c"), ImportKind::Type);
    assert_eq!(kind("./d"), ImportKind::Static);
    assert_eq!(kind("./e"), ImportKind::Type);
    assert_eq!(kind("./f"), ImportKind::Dynamic);
    assert_eq!(kind("./g"), ImportKind::Require);
    assert_eq!(
        find(&graph, "src/a.ts", "./g").to.as_deref(),
        Some("src/g.cjs")
    );
    assert_eq!(find(&graph, "src/a.ts", "./f").line, 5);

    let external = |specifier: &str| find(&graph, "src/a.ts", specifier).external.clone();
    assert_eq!(external("node:fs").as_deref(), Some("node:fs"));
    assert_eq!(external("path").as_deref(), Some("path"));
    // Declared in package.json but not installed
    assert_eq!(external("lodash/pick").as_deref(), Some("lodash"));
    assert_eq!(external("mdast").as_deref(), Some("mdast"));
    assert_eq!(external("bun:test").as_deref(), Some("bun:test"));

    for specifier in ["@app/ghost", "./missing"] {
        let import = find(&graph, "src/a.ts", specifier);
        assert!(import.unresolved && import.to.is_none() && import.external.is_none());
    }
    // Styles and declarations are not modules of the graph
    assert!(
        graph
            .imports
            .iter()
            .all(|import| import.specifier != "./styles.css" && import.specifier != "./types")
    );
    assert!(graph.files.iter().all(|file| file.path != "src/types.d.ts"));

    assert_eq!(graph.errors.len(), 1);
    assert_eq!(graph.errors[0].0, "src/broken.ts");
}

#[test]
fn scan_reads_vue_and_svelte_scripts_on_their_lines() {
    let dir = repo();
    let root = dir.path();
    write(root, "src/util.ts", "export const util = 1\n");
    write(
        root,
        "src/App.vue",
        "<template><div /></template>\n\n<script setup lang=\"ts\">\nimport type { X } from './util'\nimport { util } from './util'\n</script>\n",
    );
    write(
        root,
        "src/Card.svelte",
        "<script>\n  import App from './App.vue'\n</script>\n<p>hi</p>\n",
    );
    let graph = scan(root).unwrap();
    let util = graph
        .imports
        .iter()
        .find(|import| import.from == "src/App.vue" && import.kind == ImportKind::Static)
        .unwrap();
    assert_eq!((util.to.as_deref(), util.line), (Some("src/util.ts"), 5));
    let app = find(&graph, "src/Card.svelte", "./App.vue");
    assert_eq!((app.to.as_deref(), app.line), (Some("src/App.vue"), 2));
}

#[test]
fn scan_finds_cycles_but_not_through_type_imports() {
    let dir = repo();
    let root = dir.path();
    write(root, "a.ts", "import './b'\n");
    write(root, "b.ts", "import './c'\n");
    write(root, "c.ts", "import './a'\nimport type { D } from './d'\n");
    write(root, "d.ts", "import type { C } from './c'\n");
    write(root, "e.ts", "const f = () => import('./f')\n");
    write(root, "f.ts", "import './e'\n");
    let graph = scan(root).unwrap();
    assert_eq!(
        graph
            .cycles
            .iter()
            .map(|cycle| cycle.iter().map(String::as_str).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        [vec!["a.ts", "b.ts", "c.ts"], vec!["e.ts", "f.ts"]]
    );
}

#[test]
fn scan_refuses_a_folder_outside_git() {
    let dir = tempfile::tempdir().unwrap();
    assert!(scan(dir.path()).is_err());
    assert!(scan(&dir.path().join("missing")).is_err());
}

#[test]
fn package_name_keeps_the_scope() {
    assert_eq!(package_name("@scope/name/sub/path"), "@scope/name");
    assert_eq!(package_name("@scope/name"), "@scope/name");
    assert_eq!(package_name("name/sub"), "name");
    assert_eq!(package_name("node:fs"), "node:fs");
}

/// The graph of this repo; what differs from the old scan is in docs/next/graph.md
#[test]
fn scan_this_repo() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let started = Instant::now();
    let graph = scan(&root).unwrap();
    let took = started.elapsed();
    eprintln!(
        "{} files, {} imports, {} cycles, {} errors in {took:?}",
        graph.files.len(),
        graph.imports.len(),
        graph.cycles.len(),
        graph.errors.len()
    );
    let package = |name: &str| graph.packages.iter().find(|package| package.name == name);
    assert_eq!(
        package("treeix-desktop").map(|p| p.dir.as_str()),
        Some("apps/desktop")
    );
    assert!(package("treeix-monorepo").is_some_and(|p| p.dir.is_empty()));

    let edges = edges(&graph);
    for edge in [
        "apps/desktop/src/main.tsx > apps/desktop/src/shell/Shell.tsx",
        "apps/desktop/src/main.tsx > apps/desktop/src/autorun.ts",
        "apps/desktop/src/features/plans/index.tsx > apps/desktop/src/lib/icons.tsx",
    ] {
        assert!(edges.iter().any(|found| found == edge), "missing {edge}");
    }
    let react = find(&graph, "apps/desktop/src/main.tsx", "react-dom/client");
    assert_eq!(react.external.as_deref(), Some("react-dom"));
    assert!(graph.errors.is_empty(), "{:?}", graph.errors);
    // A few may point at files not written yet; hundreds would mean tsconfig paths or workspaces broke
    let unresolved: Vec<_> = graph
        .imports
        .iter()
        .filter(|import| import.unresolved)
        .collect();
    assert!(unresolved.len() < 5, "{unresolved:?}");
    assert!(took.as_secs() < 10);
}
