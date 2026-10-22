//! Find in files across places with `ignore` (walk, .gitignore) and `grep-searcher`.

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_MATCHES: usize = 2000;
pub const MAX_MATCHES_PER_FILE: usize = 100;
/// Longer lines are cut to this many chars
pub const MAX_LINE_CHARS: usize = 400;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// The searched root the match is under
    pub root: String,
    /// Relative to `root`
    pub path: String,
    /// 1-based
    pub line: u32,
    /// 0-based, in UTF-16 code units of the line (what Monaco and JS strings use)
    pub column: u32,
    pub length: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    /// A limit was hit
    pub truncated: bool,
}

fn matcher(query: &str, options: SearchOptions) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .fixed_strings(!options.regex)
        .build(query)
        .map_err(|e| e.to_string())
}

/// Project-wide text search, like VS Code's Shift+Cmd+F: every file `.gitignore` lets through, one match per line,
/// in parallel. Fails with the regex error when the pattern does not compile
pub fn search_text(
    roots: &[String],
    query: &str,
    options: SearchOptions,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult {
            matches: Vec::new(),
            truncated: false,
        });
    }
    let matcher = matcher(query, options)?;
    let matches = Mutex::new(Vec::new());
    let truncated = AtomicBool::new(false);
    for root in roots {
        let base = Path::new(root);
        WalkBuilder::new(base)
            .hidden(false)
            .require_git(false)
            .filter_entry(|entry| entry.file_name() != ".git")
            .build_parallel()
            .run(|| {
                let (matcher, matches, truncated) = (matcher.clone(), &matches, &truncated);
                let mut searcher = SearcherBuilder::new()
                    .line_number(true)
                    .binary_detection(BinaryDetection::quit(0))
                    .build();
                Box::new(move |entry| {
                    if truncated.load(Ordering::Relaxed) {
                        return WalkState::Quit;
                    }
                    let Ok(entry) = entry else {
                        return WalkState::Continue;
                    };
                    if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                        return WalkState::Continue;
                    }
                    let Ok(rel) = entry.path().strip_prefix(base) else {
                        return WalkState::Continue;
                    };
                    let path = rel.to_string_lossy().into_owned();
                    let mut found = Vec::new();
                    let _ = searcher.search_path(
                        &matcher,
                        entry.path(),
                        Lossy(|line, text| {
                            let text = text.trim_end_matches(['\n', '\r']);
                            let Ok(Some(hit)) = matcher.find(text.as_bytes()) else {
                                return Ok(true);
                            };
                            found.push(SearchMatch {
                                root: root.clone(),
                                path: path.clone(),
                                line: line as u32,
                                column: utf16_len(&text[..hit.start()]),
                                length: utf16_len(&text[hit.start()..hit.end()]),
                                text: text.chars().take(MAX_LINE_CHARS).collect(),
                            });
                            Ok(found.len() < MAX_MATCHES_PER_FILE)
                        }),
                    );
                    let Ok(mut all) = matches.lock() else {
                        return WalkState::Quit;
                    };
                    all.extend(found);
                    if all.len() >= MAX_MATCHES {
                        all.truncate(MAX_MATCHES);
                        truncated.store(true, Ordering::Relaxed);
                        return WalkState::Quit;
                    }
                    WalkState::Continue
                })
            });
        if truncated.load(Ordering::Relaxed) {
            break;
        }
    }
    let mut matches = matches.into_inner().map_err(|e| e.to_string())?;
    matches.sort_by(|a, b| {
        let order = |m: &SearchMatch| roots.iter().position(|root| *root == m.root);
        (order(a), &a.path, a.line).cmp(&(order(b), &b.path, b.line))
    });
    Ok(SearchResult {
        matches,
        truncated: truncated.into_inner(),
    })
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(case_sensitive: bool, whole_word: bool, regex: bool) -> SearchOptions {
        SearchOptions {
            case_sensitive,
            whole_word,
            regex,
        }
    }

    #[test]
    fn search_text_finds_text_across_worktrees_with_case_and_whole_word_options() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::write(
            dir.path().join("a:b.ts"),
            "const grantBonus = 1\nGrantBonus()\n",
        )
        .unwrap();
        let roots = [root];
        let insensitive = search_text(&roots, "grantbonus", options(false, false, false)).unwrap();
        let found: Vec<_> = insensitive
            .matches
            .iter()
            .map(|m| format!("{}:{}:{}", m.path, m.line, m.column))
            .collect();
        assert_eq!(found, ["a:b.ts:1:6", "a:b.ts:2:0"]);
        let exact = search_text(&roots, "Grant", options(true, true, false)).unwrap();
        assert!(exact.matches.is_empty());
        assert!(search_text(&roots, "(", options(true, false, true)).is_err());
        assert_eq!(
            search_text(&roots, "(", options(true, false, false))
                .unwrap()
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn search_text_respects_gitignore_skips_binary_and_caps_results() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        std::fs::create_dir(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/out.js"), "needle").unwrap();
        std::fs::write(root.join("bin"), b"needle\0").unwrap();
        std::fs::write(root.join("many.txt"), "\u{1F600} needle\n".repeat(150)).unwrap();
        for index in 0..25 {
            std::fs::write(root.join(format!("f{index}.txt")), "needle\n".repeat(100)).unwrap();
        }
        let roots = [root.to_string_lossy().into_owned()];
        let result = search_text(&roots, "needle", options(true, false, false)).unwrap();
        assert!(result.truncated);
        assert_eq!(result.matches.len(), MAX_MATCHES);
        assert!(
            result
                .matches
                .iter()
                .all(|m| m.path != "bin" && !m.path.starts_with("dist"))
        );
        let few = search_text(&roots, "\u{1F600} needle", options(true, false, false)).unwrap();
        assert_eq!(few.matches.len(), MAX_MATCHES_PER_FILE);
        assert_eq!((few.matches[0].column, few.matches[0].length), (0, 9));
        // Alone, so the parallel walk can't hit the cap before it reaches the file
        let emoji = tempfile::tempdir().unwrap();
        std::fs::write(emoji.path().join("many.txt"), "\u{1F600} needle\n").unwrap();
        let emoji_roots = [emoji.path().to_string_lossy().into_owned()];
        let after_emoji = search_text(&emoji_roots, "needle", options(true, true, true)).unwrap();
        assert!(
            after_emoji
                .matches
                .iter()
                .any(|m| m.path == "many.txt" && m.column == 3)
        );
    }
}
