//! The module graph page: every JS/TS file a place's git tracks, parsed with oxc_parser and resolved with
//! oxc_resolver (tsconfig paths, package exports, workspaces). Grouping by package or folder and "why does A
//! import B" happen in the webview. Owner: G7

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, ExportAllDeclaration, ExportFromDeclaration, Expression,
    ImportDeclaration, ImportDeclarationSpecifier, ImportExpression, ImportOrExportKind,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_resolver::{AliasValue, ResolveError, ResolveOptions, Resolver, TsconfigDiscovery};
use oxc_span::SourceType;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Component, Path};
use std::process::{Command, Stdio};

/// How a file pulls in another
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportKind {
    /// `import` / `export ... from`
    Static,
    /// `import type`, `export type`, or every specifier `type`
    Type,
    /// `import()`
    Dynamic,
    /// `require()`
    Require,
}

/// A workspace package: a folder with a package.json
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphPackage {
    pub name: String,
    /// Relative to the root, `""` for the root package
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphFile {
    /// Relative to the root, `/`-separated
    pub path: String,
    /// Name of the innermost package holding it
    pub package: Option<String>,
}

/// One import statement
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphImport {
    /// File that imports
    pub from: String,
    /// Resolved file in the graph; None for packages outside the root and for unresolved imports
    pub to: Option<String>,
    /// As written, like `./util` or `react`
    pub specifier: String,
    pub kind: ImportKind,
    /// A package outside the root (node_modules, a Node builtin), by name
    pub external: Option<String>,
    /// Neither a file in the graph nor a package: shown under Unresolved
    pub unresolved: bool,
    /// 1-based
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleGraph {
    pub root: String,
    pub packages: Vec<GraphPackage>,
    pub files: Vec<GraphFile>,
    pub imports: Vec<GraphImport>,
    /// File cycles over every import but type-only ones, one per strongly connected group, in import order
    /// without repeating the first file
    pub cycles: Vec<Vec<String>>,
    /// Files that failed to parse, with the error, so the page can say what is missing
    pub errors: Vec<(String, String)>,
}

const SOURCE_EXTENSIONS: [&str; 10] = [
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte",
];
const DEPENDENCY_FIELDS: [&str; 4] = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

/// Scans the git-tracked (and untracked, not ignored) `.js .jsx .ts .tsx .mjs .cjs .mts .cts .vue .svelte`
/// files under `root`; `.d.ts` files are declarations, not modules, and stay out
pub fn scan(root: &Path) -> Result<ModuleGraph, String> {
    if !root.is_absolute() {
        return Err(format!("{} is not an absolute path", root.display()));
    }
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let listed = git_files(&root)?;
    let (packages, declared) = read_packages(&root, &listed);
    let files: Vec<String> = listed
        .into_iter()
        .filter(|path| is_source(path) && is_regular_file(&root.join(path)))
        .collect();
    let index: HashSet<&str> = files.iter().map(String::as_str).collect();
    let resolver = resolver(&root, &packages);

    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let chunk = files.len().div_ceil(threads).max(1);
    let scanned: Vec<Scanned> = std::thread::scope(|scope| {
        let workers: Vec<_> = files
            .chunks(chunk)
            .map(|paths| {
                let (root, resolver, index, declared) = (&root, &resolver, &index, &declared);
                scope.spawn(move || {
                    let mut allocator = Allocator::default();
                    paths
                        .iter()
                        .map(|path| {
                            allocator.reset();
                            let file = root.join(path);
                            let text = std::fs::read_to_string(&file).unwrap_or_default();
                            let (raw, error) = imports_of(&allocator, path, &text);
                            let imports = raw
                                .into_iter()
                                .filter_map(|raw| {
                                    resolve(resolver, root, &file, path, raw, index, declared)
                                })
                                .collect();
                            (imports, error.map(|e| (path.clone(), e)))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    });

    let mut imports = Vec::new();
    let mut errors = Vec::new();
    for (found, error) in scanned {
        imports.extend(found);
        errors.extend(error);
    }
    let cycles = cycles(&files, &imports);
    let files = files
        .into_iter()
        .map(|path| GraphFile {
            package: package_of(&packages, &path),
            path,
        })
        .collect();
    Ok(ModuleGraph {
        root: root.to_string_lossy().into_owned(),
        packages,
        files,
        imports,
        cycles,
        errors,
    })
}

fn git_files(root: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "-co", "--exclude-standard"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    let mut files: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

fn is_source(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let declaration = [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|suffix| name.ends_with(suffix));
    !declaration
        && name
            .rsplit_once('.')
            .is_some_and(|(_, extension)| SOURCE_EXTENSIONS.contains(&extension))
}

/// Tracked symlinks may point anywhere; only plain files inside the root are read
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// The workspace packages, and every dependency any package.json declares
fn read_packages(root: &Path, listed: &[String]) -> (Vec<GraphPackage>, HashSet<String>) {
    let mut packages = Vec::new();
    let mut declared = HashSet::new();
    for manifest in listed
        .iter()
        .filter(|path| *path == "package.json" || path.ends_with("/package.json"))
    {
        let Ok(text) = std::fs::read_to_string(root.join(manifest)) else {
            continue;
        };
        let Ok(serde_json::Value::Object(json)) = serde_json::from_str(&text) else {
            continue;
        };
        let dir = manifest
            .strip_suffix("package.json")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_owned();
        let name = match json.get("name").and_then(|name| name.as_str()) {
            Some(name) if !name.is_empty() => name.to_owned(),
            _ if dir.is_empty() => "root".to_owned(),
            _ => dir.clone(),
        };
        for field in DEPENDENCY_FIELDS {
            if let Some(serde_json::Value::Object(deps)) = json.get(field) {
                declared.extend(deps.keys().cloned());
            }
        }
        packages.push(GraphPackage { name, dir });
    }
    (packages, declared)
}

fn package_of(packages: &[GraphPackage], path: &str) -> Option<String> {
    packages
        .iter()
        .filter(|package| {
            package.dir.is_empty()
                || path
                    .strip_prefix(&package.dir)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
        .max_by_key(|package| package.dir.len())
        .map(|package| package.name.clone())
}

/// TypeScript-style resolution: the nearest tsconfig's paths, `.js` written for `.ts`, package exports; a workspace
/// package that is not linked into node_modules falls back to its folder
fn resolver(root: &Path, packages: &[GraphPackage]) -> Resolver {
    let strings = |items: &[&str]| items.iter().map(|item| (*item).to_owned()).collect();
    let alias = |from: &str, to: &[&str]| (from.to_owned(), strings(to));
    let fallback = packages
        .iter()
        .filter(|package| !package.dir.is_empty())
        .map(|package| {
            let dir = root.join(&package.dir).to_string_lossy().into_owned();
            (package.name.clone(), vec![AliasValue::Path(dir)])
        })
        .collect();
    Resolver::new(ResolveOptions {
        // The nearest tsconfig.json of each importing file, with its references
        tsconfig: Some(TsconfigDiscovery::Auto),
        extensions: strings(&[
            ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
            ".json", ".d.ts",
        ]),
        extension_alias: vec![
            alias(".js", &[".ts", ".tsx", ".js", ".jsx"]),
            alias(".jsx", &[".tsx", ".jsx"]),
            alias(".mjs", &[".mts", ".mjs"]),
            alias(".cjs", &[".cts", ".cjs"]),
        ],
        condition_names: strings(&["types", "import", "require", "node", "default"]),
        main_fields: strings(&["module", "main"]),
        builtin_modules: true,
        fallback,
        ..ResolveOptions::default()
    })
}

/// An import before resolution; `offset` is a byte offset into the file
struct RawImport {
    specifier: String,
    kind: ImportKind,
    line: u32,
}

/// The imports of one file, and its first parse error
/// One file's resolved imports and its parse error, if any
type Scanned = (Vec<GraphImport>, Option<(String, String)>);

fn imports_of(allocator: &Allocator, path: &str, text: &str) -> (Vec<RawImport>, Option<String>) {
    let lines = LineIndex::new(text);
    let mut imports = Vec::new();
    let mut error = None;
    for (offset, source, source_type) in scripts(path, text) {
        let parsed = Parser::new(allocator, source, source_type).parse();
        if error.is_none()
            && let Some(first) = parsed.diagnostics.first()
        {
            error = Some(first.to_string());
        }
        let mut collector = Collector::default();
        collector.visit_program(&parsed.program);
        imports.extend(
            collector
                .found
                .into_iter()
                .map(|(specifier, kind, at)| RawImport {
                    specifier,
                    kind,
                    line: lines.line(offset + at as usize),
                }),
        );
    }
    (imports, error)
}

/// The script parts of a file with their offset: the whole file, or each `<script>` of a .vue or .svelte file
fn scripts<'t>(path: &str, text: &'t str) -> Vec<(usize, &'t str, SourceType)> {
    if !(path.ends_with(".vue") || path.ends_with(".svelte")) {
        let source_type = SourceType::from_path(path).unwrap_or_default();
        return vec![(0, text, source_type)];
    }
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(open) = text[from..].find("<script").map(|at| from + at) {
        let Some(tag_end) = text[open..].find('>').map(|at| open + at) else {
            break;
        };
        let attributes = &text[open..tag_end];
        let Some(close) = text[tag_end..].find("</script>").map(|at| tag_end + at) else {
            break;
        };
        let typescript = ["lang=\"ts\"", "lang='ts'", "lang=\"tsx\"", "lang='tsx'"]
            .iter()
            .any(|lang| attributes.contains(lang));
        let source_type = if typescript {
            SourceType::tsx()
        } else {
            SourceType::jsx()
        };
        found.push((tag_end + 1, &text[tag_end + 1..close], source_type));
        from = close;
    }
    found
}

struct LineIndex(Vec<usize>);

impl LineIndex {
    fn new(text: &str) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(at, _)| at + 1))
            .collect();
        Self(starts)
    }

    /// 1-based line of a byte offset
    fn line(&self, offset: usize) -> u32 {
        u32::try_from(self.0.partition_point(|start| *start <= offset)).unwrap_or(u32::MAX)
    }
}

/// Collects every import, re-export, `import()` and `require()` with a literal specifier
#[derive(Default)]
struct Collector {
    /// Specifier, kind, offset in the parsed source
    found: Vec<(String, ImportKind, u32)>,
}

impl Collector {
    fn push(&mut self, specifier: &str, kind: ImportKind, at: u32) {
        self.found.push((specifier.to_owned(), kind, at));
    }
}

fn kind_of(kind: ImportOrExportKind) -> ImportKind {
    if kind.is_type() {
        ImportKind::Type
    } else {
        ImportKind::Static
    }
}

impl<'a> Visit<'a> for Collector {
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        // `import { type A, type B } from` is erased like `import type`
        let all_types = it.specifiers.as_ref().is_some_and(|specifiers| {
            !specifiers.is_empty()
                && specifiers.iter().all(|specifier| {
                    matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(named) if named.import_kind.is_type())
                })
        });
        let kind = if all_types {
            ImportKind::Type
        } else {
            kind_of(it.import_kind)
        };
        self.push(&it.source.value, kind, it.span.start);
    }

    fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
        let all_types = !it.specifiers.is_empty()
            && it
                .specifiers
                .iter()
                .all(|specifier| specifier.export_kind.is_type());
        let kind = if all_types {
            ImportKind::Type
        } else {
            kind_of(it.export_kind)
        };
        self.push(&it.source.value, kind, it.span.start);
    }

    fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
        self.push(&it.source.value, kind_of(it.export_kind), it.span.start);
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if let Some(specifier) = literal(&it.source) {
            self.push(specifier, ImportKind::Dynamic, it.span.start);
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if it.is_require_call()
            && let Some(specifier) = it.arguments.first().and_then(|argument| match argument {
                Argument::StringLiteral(text) => Some(text.value.as_str()),
                Argument::TemplateLiteral(text) => text.single_quasi().map(|quasi| quasi.as_str()),
                _ => None,
            })
        {
            self.push(specifier, ImportKind::Require, it.span.start);
        }
        walk::walk_call_expression(self, it);
    }
}

/// A string or a template literal without expressions
fn literal<'e>(expression: &'e Expression<'_>) -> Option<&'e str> {
    match expression {
        Expression::StringLiteral(text) => Some(text.value.as_str()),
        Expression::TemplateLiteral(text) => text.single_quasi().map(|quasi| quasi.as_str()),
        _ => None,
    }
}

/// `@scope/name/sub` is `@scope/name`, `name/sub` is `name`
fn package_name(specifier: &str) -> &str {
    let mut parts = specifier.splitn(3, '/');
    let first = parts.next().unwrap_or(specifier);
    match (first.starts_with('@'), parts.next()) {
        (true, Some(second)) => &specifier[..first.len() + 1 + second.len()],
        _ => first,
    }
}

fn is_bare(specifier: &str) -> bool {
    !(specifier.starts_with('.') || specifier.starts_with('/') || specifier.starts_with('#'))
}

fn is_declared(declared: &HashSet<String>, name: &str) -> bool {
    let types = format!("@types/{}", name.trim_start_matches('@').replace('/', "__"));
    declared.contains(name) || declared.contains(&types)
}

fn has_scheme(specifier: &str) -> bool {
    specifier.split_once(':').is_some_and(|(scheme, _)| {
        scheme.len() > 1
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

/// Root-relative `/`-separated path of a file inside the root and outside node_modules
fn relative_inside(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts: Vec<&str> = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<_>>()?;
    (!parts.contains(&"node_modules")).then(|| parts.join("/"))
}

/// Imports of files outside the graph (styles, images, JSON, declarations) are dropped like the old scan did
fn resolve(
    resolver: &Resolver,
    root: &Path,
    file: &Path,
    from: &str,
    raw: RawImport,
    index: &HashSet<&str>,
    declared: &HashSet<String>,
) -> Option<GraphImport> {
    let mut import = GraphImport {
        from: from.to_owned(),
        to: None,
        specifier: raw.specifier,
        kind: raw.kind,
        external: None,
        unresolved: false,
        line: raw.line,
    };
    let external = |specifier: &str| Some(package_name(specifier).to_owned());
    match resolver.resolve_file(file, &import.specifier) {
        Ok(resolution) => match relative_inside(root, resolution.path()) {
            Some(path) if index.contains(path.as_str()) => import.to = Some(path),
            Some(_) => return None,
            None if is_bare(&import.specifier) => import.external = external(&import.specifier),
            None => return None,
        },
        Err(ResolveError::Builtin { .. }) => import.external = Some(import.specifier.clone()),
        Err(ResolveError::Ignored(_)) => return None,
        // A runtime's own modules: `bun:test`, `electron:...`
        Err(_) if has_scheme(&import.specifier) => import.external = Some(import.specifier.clone()),
        // Declared but not installed (or types only, in @types) is still a package, not a broken import
        Err(_)
            if is_bare(&import.specifier)
                && is_declared(declared, package_name(&import.specifier)) =>
        {
            import.external = external(&import.specifier)
        }
        Err(_) => import.unresolved = true,
    }
    Some(import)
}

/// One cycle per strongly connected group of files, over every import but type-only ones
fn cycles(files: &[String], imports: &[GraphImport]) -> Vec<Vec<String>> {
    let position: HashMap<&str, usize> = files
        .iter()
        .enumerate()
        .map(|(at, path)| (path.as_str(), at))
        .collect();
    let mut edges: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); files.len()];
    for import in imports
        .iter()
        .filter(|import| import.kind != ImportKind::Type)
    {
        if let (Some(&from), Some(&to)) = (
            position.get(import.from.as_str()),
            import.to.as_deref().and_then(|to| position.get(to)),
        ) && from != to
        {
            edges[from].insert(to);
        }
    }
    strongly_connected(&edges)
        .into_iter()
        .filter(|group| group.len() > 1)
        .filter_map(|group| shortest_cycle(&edges, &group))
        .map(|cycle| cycle.into_iter().map(|at| files[at].clone()).collect())
        .collect()
}

/// Tarjan's algorithm, iterative so deep import chains cannot overflow the stack; groups come out sorted
fn strongly_connected(edges: &[BTreeSet<usize>]) -> Vec<Vec<usize>> {
    let count = edges.len();
    let (mut index, mut low) = (vec![usize::MAX; count], vec![0; count]);
    let mut on_stack = vec![false; count];
    let (mut stack, mut groups, mut next) = (Vec::new(), Vec::new(), 0);
    for start in 0..count {
        if index[start] != usize::MAX {
            continue;
        }
        let mut work: Vec<(usize, Vec<usize>)> = Vec::new();
        index[start] = next;
        low[start] = next;
        next += 1;
        stack.push(start);
        on_stack[start] = true;
        work.push((start, edges[start].iter().rev().copied().collect()));
        while let Some((node, pending)) = work.last_mut() {
            let node = *node;
            if let Some(target) = pending.pop() {
                if index[target] == usize::MAX {
                    index[target] = next;
                    low[target] = next;
                    next += 1;
                    stack.push(target);
                    on_stack[target] = true;
                    work.push((target, edges[target].iter().rev().copied().collect()));
                } else if on_stack[target] {
                    low[node] = low[node].min(index[target]);
                }
                continue;
            }
            work.pop();
            if let Some((parent, _)) = work.last() {
                low[*parent] = low[*parent].min(low[node]);
            }
            if low[node] == index[node] {
                let mut group = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member] = false;
                    group.push(member);
                    if member == node {
                        break;
                    }
                }
                group.sort_unstable();
                groups.push(group);
            }
        }
    }
    groups.sort();
    groups
}

/// The shortest way from the group's first file back to itself, inside the group
fn shortest_cycle(edges: &[BTreeSet<usize>], group: &[usize]) -> Option<Vec<usize>> {
    let members: HashSet<usize> = group.iter().copied().collect();
    let start = *group.first()?;
    let mut previous: HashMap<usize, usize> = HashMap::new();
    let mut queue = VecDeque::from([start]);
    while let Some(node) = queue.pop_front() {
        for &target in &edges[node] {
            if target == start {
                let mut cycle = vec![node];
                while let Some(&before) = previous.get(cycle.last()?) {
                    cycle.push(before);
                }
                cycle.reverse();
                return Some(cycle);
            }
            if members.contains(&target) && !previous.contains_key(&target) && target != start {
                previous.insert(target, node);
                queue.push_back(target);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests;
