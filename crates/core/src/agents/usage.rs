//! Token usage per day, agent, model and project from every Claude transcript and codex rollout, cached by
//! file size and mtime. Port of packages/plugins/agent-usage/main

use super::{count, parse_line, text};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

/// Tokens one agent spent on one model in one project on one local day
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// YYYY-MM-DD, local time
    pub day: String,
    pub agent: String,
    pub model: String,
    /// The repository, worktrees counted toward it, shown from ~
    pub project: String,
    /// Claude or Codex session id
    pub session: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// USD per token: input, output, cache read, cache write
pub type Price = [f64; 4];

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub rows: Vec<UsageRow>,
    /// By model id
    pub prices: BTreeMap<String, Price>,
    /// Session titles the agents saved, by session id
    pub titles: BTreeMap<String, String>,
}

/// A log's usage rows and the session titles it names
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub rows: Vec<UsageRow>,
    pub titles: BTreeMap<String, String>,
}

// Bumped when parsing changes, so every log is read again
const CACHE_VERSION: u32 = 2;
const CACHE_FILE: &str = "usage-cache.json";
const PRICES_FILE: &str = "prices.json";
// The price list ccusage and most token counters read; fetched at most daily
const PRICES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICES_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

fn local_day(timestamp: &str) -> Option<String> {
    super::local_day(super::timestamp_ms(timestamp)? as i64)
}

/// A worktree counts toward its repository, shown from ~
pub fn project_of(cwd: &str, home: &str) -> String {
    let repo = cwd.find("/.claude/worktrees/").map_or(cwd, |at| &cwd[..at]);
    if repo.is_empty() {
        return "unknown".into();
    }
    match repo.strip_prefix(home) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => repo.into(),
    }
}

/// Sums tokens per day, agent, model, project and session, in first-seen order
#[derive(Default)]
struct Tally {
    index: HashMap<[String; 5], usize>,
    rows: Vec<UsageRow>,
}

impl Tally {
    fn add(&mut self, key: [String; 5], tokens: [u64; 4]) {
        let at = *self.index.entry(key.clone()).or_insert_with(|| {
            let [day, agent, model, project, session] = key;
            self.rows.push(UsageRow {
                day,
                agent,
                model,
                project,
                session,
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            });
            self.rows.len() - 1
        });
        let row = &mut self.rows[at];
        row.input += tokens[0];
        row.output += tokens[1];
        row.cache_read += tokens[2];
        row.cache_write += tokens[3];
    }
}

/// Claude Code transcripts: one `usage` per API reply, repeated on each content block line of that reply; a
/// title the user set beats the generated one
pub fn claude_rows<'a>(lines: impl IntoIterator<Item = &'a str>, home: &str) -> Parsed {
    let mut tally = Tally::default();
    let mut seen = HashSet::new();
    let mut titles = BTreeMap::new();
    let mut named = HashSet::new();
    for line in lines {
        if line.contains("-title\"") {
            let Some(entry) = parse_line(line) else {
                continue;
            };
            let session = text(entry.get("sessionId"));
            let kind = text(entry.get("type"));
            let custom = if kind == "custom-title" {
                text(entry.get("customTitle"))
            } else {
                ""
            };
            let generated = if kind == "ai-title" {
                text(entry.get("aiTitle"))
            } else {
                ""
            };
            if session.is_empty() {
                continue;
            }
            if !custom.is_empty() {
                named.insert(session.to_owned());
                titles.insert(session.to_owned(), custom.to_owned());
            } else if !generated.is_empty() && !named.contains(session) {
                titles.insert(session.to_owned(), generated.to_owned());
            }
            continue;
        }
        if !line.contains("\"usage\"") {
            continue;
        }
        let Some(entry) = parse_line(line).filter(|e| text(e.get("type")) == "assistant") else {
            continue;
        };
        let Some(message) = entry.get("message") else {
            continue;
        };
        let model = text(message.get("model"));
        let (Some(usage), Some(day)) = (
            message.get("usage").filter(|u| u.is_object()),
            local_day(text(entry.get("timestamp"))),
        ) else {
            continue;
        };
        if model == "<synthetic>" {
            continue;
        }
        let id = text(message.get("id"));
        if !id.is_empty() && !seen.insert(format!("{id}:{}", text(entry.get("requestId")))) {
            continue;
        }
        let session = text(entry.get("sessionId"));
        tally.add(
            [
                day,
                "claude".into(),
                if model.is_empty() { "unknown" } else { model }.into(),
                project_of(text(entry.get("cwd")), home),
                if session.is_empty() {
                    "unknown"
                } else {
                    session
                }
                .into(),
            ],
            [
                count(usage.get("input_tokens")),
                count(usage.get("output_tokens")),
                count(usage.get("cache_read_input_tokens")),
                count(usage.get("cache_creation_input_tokens")),
            ],
        );
    }
    Parsed {
        rows: tally.rows,
        titles,
    }
}

/// Codex rollouts: cumulative `token_count` totals, so each event adds what grew since the last;
/// Ollama-backed sessions count as Ollama
pub fn codex_rows<'a>(lines: impl IntoIterator<Item = &'a str>, home: &str) -> Parsed {
    let mut tally = Tally::default();
    let mut session = "unknown".to_owned();
    let mut cwd = String::new();
    let mut agent = "codex";
    let mut model = "unknown".to_owned();
    let mut previous: Option<Value> = None;
    for line in lines {
        if !["\"session_meta\"", "\"turn_context\"", "\"token_count\""]
            .iter()
            .any(|kind| line.contains(kind))
        {
            continue;
        }
        let Some(event) = parse_line(line) else {
            continue;
        };
        let payload = event.get("payload");
        let field = |key: &str| text(payload.and_then(|p| p.get(key)));
        match text(event.get("type")) {
            "session_meta" => {
                if !field("cwd").is_empty() {
                    cwd = field("cwd").into();
                }
                if !field("id").is_empty() {
                    session = field("id").into();
                }
                agent = if field("model_provider").contains("ollama") {
                    "ollama"
                } else {
                    "codex"
                };
                continue;
            }
            "turn_context" => {
                if !field("model").is_empty() {
                    model = field("model").into();
                }
                if !field("cwd").is_empty() {
                    cwd = field("cwd").into();
                }
                continue;
            }
            _ => {}
        }
        let info = payload
            .filter(|_| field("type") == "token_count")
            .and_then(|p| p.get("info"))
            .filter(|i| i.is_object());
        let (Some(info), Some(day)) = (info, local_day(text(event.get("timestamp")))) else {
            continue;
        };
        let total = info.get("total_token_usage").filter(|t| t.is_object());
        let last = info.get("last_token_usage");
        let before = |key: &str| count(previous.as_ref().and_then(|p| p.get(key)));
        // A total that shrank started over; the turn's own usage is the best left
        let from_total = total.filter(|t| count(t.get("total_tokens")) >= before("total_tokens"));
        let spent = |key: &str| match from_total {
            Some(total) => count(total.get(key)).saturating_sub(before(key)),
            None => count(last.and_then(|l| l.get(key))),
        };
        // input_tokens includes the cached ones
        let cache_read = spent("cached_input_tokens");
        let cache_write = spent("cache_write_input_tokens");
        let tokens = [
            spent("input_tokens").saturating_sub(cache_read + cache_write),
            spent("output_tokens"),
            cache_read,
            cache_write,
        ];
        if let Some(total) = total {
            previous = Some(total.clone());
        }
        if tokens.iter().sum::<u64>() > 0 {
            tally.add(
                [
                    day,
                    agent.into(),
                    model.clone(),
                    project_of(&cwd, home),
                    session.clone(),
                ],
                tokens,
            );
        }
    }
    Parsed {
        rows: tally.rows,
        titles: BTreeMap::new(),
    }
}

/// Codex keeps thread names apart from the rollouts; a later line renames
pub fn codex_titles<'a>(lines: impl IntoIterator<Item = &'a str>) -> BTreeMap<String, String> {
    let mut titles = BTreeMap::new();
    for entry in lines.into_iter().filter_map(parse_line) {
        let (id, name) = (text(entry.get("id")), text(entry.get("thread_name")));
        if !id.is_empty() && !name.is_empty() {
            titles.insert(id.to_owned(), name.to_owned());
        }
    }
    titles
}

/// Per-token prices of models listed under their bare name; a missing cache price falls back to the input price
pub fn reduce_prices(raw: &Value) -> BTreeMap<String, Price> {
    let Some(models) = raw.as_object() else {
        return BTreeMap::new();
    };
    models
        .iter()
        .filter(|(model, _)| !model.contains('/'))
        .filter_map(|(model, entry)| {
            let cost = |key: &str| entry.get(key).and_then(Value::as_f64);
            let input = cost("input_cost_per_token")?;
            let output = cost("output_cost_per_token")?;
            let price = [
                input,
                output,
                cost("cache_read_input_token_cost").unwrap_or(input),
                cost("cache_creation_input_token_cost").unwrap_or(input),
            ];
            Some((model.clone(), price))
        })
        .collect()
}

/// Exact name first, then without a trailing date such as -20251001
pub fn price_of(prices: &BTreeMap<String, Price>, model: &str) -> Option<Price> {
    let undated = model
        .rsplit_once('-')
        .filter(|(_, date)| date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()))
        .map(|(name, _)| name);
    prices.get(model).or_else(|| prices.get(undated?)).copied()
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPrices {
    fetched_at: u64,
    prices: BTreeMap<String, Price>,
}

fn saved_prices(cache_dir: &Path) -> SavedPrices {
    fs::read(cache_dir.join(PRICES_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Fetches the price list when the saved one is a day old; offline keeps the last known prices
pub async fn refresh_prices(cache_dir: &Path) {
    if super::now_ms().saturating_sub(saved_prices(cache_dir).fetched_at) < PRICES_MAX_AGE_MS {
        return;
    }
    let fetched = async {
        let response = reqwest::Client::new()
            .get(PRICES_URL)
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        response.json::<Value>().await.ok()
    };
    if let Some(raw) = fetched.await {
        let saved = SavedPrices {
            fetched_at: super::now_ms(),
            prices: reduce_prices(&raw),
        };
        if let Ok(json) = serde_json::to_vec(&saved) {
            let _ = fs::write(cache_dir.join(PRICES_FILE), json);
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRows {
    mtime_ms: u64,
    size: u64,
    #[serde(flatten)]
    parsed: Parsed,
}

#[derive(Serialize, Deserialize)]
struct UsageCache {
    version: u32,
    files: HashMap<String, FileRows>,
}

fn jsonl_under(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => jsonl_under(&path, found),
            Ok(_) if path.extension().is_some_and(|e| e == "jsonl") => found.push(path),
            _ => {}
        }
    }
}

/// Lines of a log, read lossily so one bad byte does not drop the file
fn lines_of(path: &Path) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .split(b'\n')
        .map_while(Result::ok)
        .map(|line| String::from_utf8_lossy(&line).into_owned())
        .collect()
}

/// Logs are read again only when their size or time changed; the rest come from the cache file.
/// ponytail: a growing log is re-read whole, read from the last offset if live sessions make this slow
fn scan(home: &Path, cache_dir: &Path) -> Parsed {
    let cache_file = cache_dir.join(CACHE_FILE);
    let cached = fs::read(&cache_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<UsageCache>(&bytes).ok())
        .filter(|cache| cache.version == CACHE_VERSION)
        .map(|cache| cache.files)
        .unwrap_or_default();
    let home_text = home.to_string_lossy();
    let mut claude = Vec::new();
    jsonl_under(&home.join(".claude/projects"), &mut claude);
    let mut codex = Vec::new();
    jsonl_under(&home.join(".codex/sessions"), &mut codex);
    jsonl_under(&home.join(".codex/archived_sessions"), &mut codex);
    let sources = claude
        .into_iter()
        .map(|path| (path, true))
        .chain(codex.into_iter().map(|path| (path, false)));
    let mut files = HashMap::new();
    let mut read = 0;
    for (path, is_claude) in sources {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let key = path.to_string_lossy().into_owned();
        let hit = cached
            .get(&key)
            .filter(|hit| hit.mtime_ms == mtime_ms && hit.size == meta.len());
        let rows = match hit {
            Some(hit) => hit.clone(),
            None => {
                read += 1;
                let lines = lines_of(&path);
                let lines = lines.iter().map(String::as_str);
                let parsed = if is_claude {
                    claude_rows(lines, &home_text)
                } else {
                    codex_rows(lines, &home_text)
                };
                FileRows {
                    mtime_ms,
                    size: meta.len(),
                    parsed,
                }
            }
        };
        files.insert(key, rows);
    }
    if read > 0 || cached.len() != files.len() {
        let cache = UsageCache {
            version: CACHE_VERSION,
            files,
        };
        if let Ok(json) = serde_json::to_vec(&cache) {
            let _ = fs::write(&cache_file, json);
        }
        files = cache.files;
    }
    let mut parsed = Parsed::default();
    for file in files.into_values() {
        parsed.rows.extend(file.parsed.rows);
        parsed.titles.extend(file.parsed.titles);
    }
    let index = lines_of(&home.join(".codex/session_index.jsonl"));
    parsed
        .titles
        .extend(codex_titles(index.iter().map(String::as_str)));
    parsed
}

/// Every agent's tokens by day, model, project and session, with session titles and the saved prices.
/// `cache_dir` holds the parsed-file cache and the price list; [`refresh_prices`] updates the latter
pub fn agent_usage(home: &Path, cache_dir: &Path) -> Result<AgentUsage, String> {
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let Parsed { rows, titles } = scan(home, cache_dir);
    Ok(AgentUsage {
        rows,
        prices: saved_prices(cache_dir).prices,
        titles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AT: &str = "2026-10-16T12:00:00.000Z";

    fn day() -> String {
        local_day(AT).unwrap()
    }

    fn rows_of(lines: &[String], claude: bool) -> Parsed {
        let lines = lines.iter().map(String::as_str);
        if claude {
            claude_rows(lines, "/Users/me")
        } else {
            codex_rows(lines, "/Users/me")
        }
    }

    #[test]
    fn project_of_folds_worktrees_into_their_repository_and_shortens_home() {
        assert_eq!(
            project_of("/Users/me/code/app/.claude/worktrees/feat+x", "/Users/me"),
            "~/code/app"
        );
        assert_eq!(project_of("/opt/app", "/Users/me"), "/opt/app");
        assert_eq!(project_of("/Users/meow", "/Users/me"), "/Users/meow");
        assert_eq!(project_of("", "/Users/me"), "unknown");
    }

    #[test]
    fn claude_rows_counts_each_reply_once_skips_synthetic_ones_and_keeps_the_title_the_user_set() {
        let reply = |id: &str, model: &str| {
            json!({
                "type": "assistant", "timestamp": AT, "cwd": "/opt/app", "sessionId": "s1", "requestId": format!("req_{id}"),
                "message": { "id": id, "model": model, "usage": { "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20 } }
            })
            .to_string()
        };
        let title = |kind: &str, key: &str, name: &str| {
            json!({ "type": kind, key: name, "sessionId": "s1" }).to_string()
        };
        let opus = "claude-opus-5-5";
        let parsed = rows_of(
            &[
                title("ai-title", "aiTitle", "Generated"),
                title("custom-title", "customTitle", "Mine"),
                title("ai-title", "aiTitle", "Generated later"),
                reply("a", opus),
                reply("a", opus),
                reply("b", opus),
                reply("c", "<synthetic>"),
                r#"{"type":"user"}"#.into(),
                r#"not json "usage""#.into(),
            ],
            true,
        );
        assert_eq!(
            parsed.titles,
            BTreeMap::from([("s1".into(), "Mine".into())])
        );
        assert_eq!(
            parsed.rows,
            [UsageRow {
                day: day(),
                agent: "claude".into(),
                model: opus.into(),
                project: "/opt/app".into(),
                session: "s1".into(),
                input: 20,
                output: 10,
                cache_read: 200,
                cache_write: 40,
            }]
        );
    }

    #[test]
    fn codex_rows_adds_what_each_cumulative_total_grew_by_and_names_ollama_sessions() {
        let count = |input: u64, cached: u64, output: u64| {
            json!({
                "timestamp": AT, "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": input, "cached_input_tokens": cached, "output_tokens": output, "total_tokens": input + output },
                    "last_token_usage": { "input_tokens": 7, "cached_input_tokens": 0, "output_tokens": 1, "total_tokens": 8 }
                } }
            })
            .to_string()
        };
        let meta = |provider: &str| {
            json!({ "timestamp": AT, "type": "session_meta", "payload": { "id": "c1", "cwd": "/opt/app", "model_provider": provider } })
                .to_string()
        };
        let turn = json!({ "timestamp": AT, "type": "turn_context", "payload": { "model": "gpt-6-luna" } }).to_string();
        // The repeated total adds nothing; the one that shrank falls back to the turn's own usage
        let parsed = rows_of(
            &[
                meta("openai"),
                turn.clone(),
                count(100, 40, 10),
                count(100, 40, 10),
                count(250, 140, 30),
                count(50, 0, 5),
            ],
            false,
        );
        assert_eq!(
            parsed.rows,
            [UsageRow {
                day: day(),
                agent: "codex".into(),
                model: "gpt-6-luna".into(),
                project: "/opt/app".into(),
                session: "c1".into(),
                input: 117,
                output: 31,
                cache_read: 140,
                cache_write: 0,
            }]
        );
        let ollama = rows_of(&[meta("ollama-launch"), turn, count(100, 0, 10)], false);
        assert_eq!(ollama.rows[0].agent, "ollama");
    }

    #[test]
    fn codex_titles_takes_the_latest_name_of_each_thread() {
        let name = |id: &str, name: &str| json!({ "id": id, "thread_name": name }).to_string();
        let lines = [
            name("c1", "First"),
            name("c2", "Other"),
            name("c1", "Renamed"),
            "broken".into(),
        ];
        assert_eq!(
            codex_titles(lines.iter().map(String::as_str)),
            BTreeMap::from([
                ("c1".into(), "Renamed".into()),
                ("c2".into(), "Other".into())
            ])
        );
    }

    #[test]
    fn reduce_prices_keeps_bare_model_names_and_falls_back_to_the_input_price_for_cache() {
        let prices = reduce_prices(&json!({
            "claude-opus-5-5": { "input_cost_per_token": 4e-6, "output_cost_per_token": 2e-5, "cache_read_input_token_cost": 2e-7, "cache_creation_input_token_cost": 5e-6 },
            "gpt-5.5": { "input_cost_per_token": 5e-6, "output_cost_per_token": 3e-5 },
            "azure/gpt-5.5": { "input_cost_per_token": 1, "output_cost_per_token": 1 },
            "sample_spec": { "max_tokens": "set to max" }
        }));
        assert_eq!(
            prices,
            BTreeMap::from([
                ("claude-opus-5-5".into(), [4e-6, 2e-5, 2e-7, 5e-6]),
                ("gpt-5.5".into(), [5e-6, 3e-5, 5e-6, 5e-6]),
            ])
        );
        let haiku = BTreeMap::from([("claude-haiku-4-5".to_owned(), [1.0, 2.0, 3.0, 4.0])]);
        assert_eq!(
            price_of(&haiku, "claude-haiku-4-5-20251001"),
            Some([1.0, 2.0, 3.0, 4.0])
        );
        assert_eq!(price_of(&prices, "gemma4:26b-mlx"), None);
    }

    #[test]
    fn agent_usage_scans_logs_and_reuses_the_cache_for_unchanged_files() {
        let home = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude/projects/-opt-app");
        fs::create_dir_all(&project).unwrap();
        let reply = json!({ "type": "assistant", "timestamp": AT, "sessionId": "s1", "cwd": "/opt/app",
            "message": { "id": "a", "model": "m", "usage": { "input_tokens": 1, "output_tokens": 2 } } });
        fs::write(project.join("s1.jsonl"), reply.to_string()).unwrap();
        let first = agent_usage(home.path(), cache.path()).unwrap();
        assert_eq!(first.rows.len(), 1);
        assert!(cache.path().join(CACHE_FILE).is_file());
        // A cached row survives even when the parser would now read the file differently
        let saved = fs::read_to_string(cache.path().join(CACHE_FILE))
            .unwrap()
            .replace("\"output\":2", "\"output\":9");
        fs::write(cache.path().join(CACHE_FILE), saved).unwrap();
        assert_eq!(
            agent_usage(home.path(), cache.path()).unwrap().rows[0].output,
            9
        );
    }
}
