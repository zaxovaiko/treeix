//! Claude transcripts (`~/.claude/projects/<cwd>/<id>.jsonl`) and codex rollouts: what a session spent, its
//! replies, and the stats History shows. Port of the Electron terminal plugin's transcripts.ts

use super::{count, parse_line, text};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Claude,
    Codex,
}

/// Tokens one conversation spent; `cached` is the cache reads
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    /// Claude's own figure from the statusline, when it ran with Treeix's hooks
    pub cost_usd: Option<f64>,
}

/// History's figures for a closed session
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TranscriptStats {
    /// Prompts and written replies
    pub messages: u32,
    pub first_prompt: Option<String>,
}

const FIRST_PROMPT_CHARS: usize = 200;

/// Claude writes one line per content block, each repeating its message's usage, so messages count once by id
pub fn claude_usage(transcript: &str) -> SessionUsage {
    let mut seen = HashSet::new();
    let mut usage = SessionUsage::default();
    for line in transcript.lines().filter(|l| l.contains("\"usage\"")) {
        let Some(message) = parse_line(line).and_then(|mut l| l.remove("message")) else {
            continue;
        };
        let (Some(id), Some(tokens)) = (
            message.get("id").and_then(Value::as_str),
            message.get("usage"),
        ) else {
            continue;
        };
        if !tokens.is_object() || !seen.insert(id.to_owned()) {
            continue;
        }
        usage.input +=
            count(tokens.get("input_tokens")) + count(tokens.get("cache_creation_input_tokens"));
        usage.cached += count(tokens.get("cache_read_input_tokens"));
        usage.output += count(tokens.get("output_tokens"));
    }
    usage
}

/// Codex reports running totals; the last one is the conversation's
pub fn codex_usage(rollout: &str) -> SessionUsage {
    let total = rollout
        .lines()
        .rfind(|l| l.contains("\"total_token_usage\""))
        .and_then(parse_line)
        .and_then(|l| {
            l.get("payload")?
                .get("info")?
                .get("total_token_usage")
                .cloned()
        })
        .filter(Value::is_object);
    let Some(total) = total else {
        return SessionUsage::default();
    };
    let cached = count(total.get("cached_input_tokens"));
    SessionUsage {
        input: count(total.get("input_tokens")).saturating_sub(cached),
        cached,
        output: count(total.get("output_tokens")),
        cost_usd: None,
    }
}

/// Claude keeps `<id>.jsonl` in a folder named after the working directory, which can move; so every project
/// folder is tried. Codex names each rollout `rollout-<time>-<id>.jsonl` under YYYY/MM/DD
pub fn transcript_path(home: &Path, kind: AgentKind, agent_session: &str) -> Option<PathBuf> {
    if !super::safe_id(agent_session) {
        return None;
    }
    match kind {
        AgentKind::Claude => fs::read_dir(home.join(".claude/projects"))
            .ok()?
            .flatten()
            .map(|folder| folder.path().join(format!("{agent_session}.jsonl")))
            .find(|path| path.is_file()),
        AgentKind::Codex => find_file(
            &home.join(".codex/sessions"),
            &format!("-{agent_session}.jsonl"),
            3,
        ),
    }
}

fn find_file(dir: &Path, suffix: &str, depth: u32) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if entry.file_type().ok()?.is_dir() {
            (depth > 0).then(|| find_file(&path, suffix, depth - 1))?
        } else {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(suffix)
                .then_some(path)
        }
    })
}

/// Finds and reads the conversation's transcript; None when it is gone
pub fn transcript_usage(
    home: &Path,
    kind: AgentKind,
    agent_session: &str,
) -> Result<Option<SessionUsage>, String> {
    let Some(path) = transcript_path(home, kind, agent_session) else {
        return Ok(None);
    };
    let transcript = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(match kind {
        AgentKind::Claude => claude_usage(&transcript),
        AgentKind::Codex => codex_usage(&transcript),
    }))
}

fn texts<'a>(content: Option<&'a Value>, kind: &str) -> Vec<&'a str> {
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some(kind))
        .filter_map(|block| block.get("text")?.as_str())
        .collect()
}

/// The agent's last `count` written replies, oldest first; tool calls and results left out
pub fn last_replies(kind: AgentKind, transcript: &str, count: usize) -> Vec<String> {
    let mut replies = Vec::new();
    for entry in transcript.lines().filter_map(parse_line) {
        match kind {
            AgentKind::Claude if text(entry.get("type")) == "assistant" => {
                let content = entry.get("message").and_then(|m| m.get("content"));
                replies.extend(texts(content, "text").into_iter().map(str::to_owned));
            }
            AgentKind::Codex => {
                let Some(payload) = entry.get("payload") else {
                    continue;
                };
                if text(payload.get("type")) == "message"
                    && text(payload.get("role")) == "assistant"
                {
                    replies.extend(
                        texts(payload.get("content"), "output_text")
                            .into_iter()
                            .map(str::to_owned),
                    );
                }
            }
            AgentKind::Claude => {}
        }
    }
    replies.split_off(replies.len().saturating_sub(count))
}

/// What the user typed: Claude's meta lines (commands, caveats) and tool results are no prompt
fn claude_prompt(entry: &serde_json::Map<String, Value>) -> Option<String> {
    if text(entry.get("type")) != "user"
        || entry.get("isMeta").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let content = entry.get("message")?.get("content")?;
    let prompt = match content.as_str() {
        Some(prompt) => prompt.to_owned(),
        None => texts(Some(content), "text").join("\n"),
    };
    let prompt = prompt.trim();
    (!prompt.is_empty() && !prompt.starts_with('<')).then(|| prompt.to_owned())
}

/// Prompts and written replies, and the first prompt, for History
pub fn transcript_stats(kind: AgentKind, transcript: &str) -> TranscriptStats {
    let mut stats = TranscriptStats::default();
    let mut replies = HashSet::new();
    for entry in transcript.lines().filter_map(parse_line) {
        let prompt = match kind {
            AgentKind::Claude => {
                let message = entry.get("message");
                let id = message.and_then(|m| m.get("id")).and_then(Value::as_str);
                if text(entry.get("type")) == "assistant"
                    && !texts(message.and_then(|m| m.get("content")), "text").is_empty()
                    && id.is_none_or(|id| replies.insert(id.to_owned()))
                {
                    stats.messages += 1;
                }
                claude_prompt(&entry)
            }
            // event_msg lines carry what the user and the agent wrote, without the injected context
            AgentKind::Codex => {
                let payload = entry.get("payload");
                match payload.map(|p| text(p.get("type"))) {
                    Some("agent_message") => {
                        stats.messages += 1;
                        None
                    }
                    Some("user_message") if text(entry.get("type")) == "event_msg" => payload
                        .map(|p| text(p.get("message")).trim().to_owned())
                        .filter(|m| !m.is_empty()),
                    _ => None,
                }
            }
        };
        if let Some(prompt) = prompt {
            stats.messages += 1;
            stats
                .first_prompt
                .get_or_insert_with(|| prompt.chars().take(FIRST_PROMPT_CHARS).collect());
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(values: &[Value]) -> String {
        values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn claude_usage_counts_each_message_once_across_its_content_block_lines() {
        let line = |id: &str, usage: Value| json!({ "message": { "id": id, "usage": usage } });
        let usage = json!({ "input_tokens": 10, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 100, "output_tokens": 7 });
        let transcript = format!(
            "{}\n{{\"type\":\"user\"}}\nnot json",
            lines(&[
                line("a", usage.clone()),
                line("a", usage),
                line("b", json!({ "input_tokens": 1, "output_tokens": 2 })),
            ])
        );
        assert_eq!(
            claude_usage(&transcript),
            SessionUsage {
                input: 16,
                cached: 100,
                output: 9,
                cost_usd: None
            }
        );
    }

    #[test]
    fn codex_usage_takes_the_last_running_total_cached_input_apart() {
        let total = |input: u64, cached: u64, output: u64| json!({ "payload": { "type": "token_count", "info": { "total_token_usage": { "input_tokens": input, "cached_input_tokens": cached, "output_tokens": output } } } });
        assert_eq!(
            codex_usage(&lines(&[total(10, 0, 1), total(500, 400, 30)])),
            SessionUsage {
                input: 100,
                cached: 400,
                output: 30,
                cost_usd: None
            }
        );
        assert_eq!(codex_usage(""), SessionUsage::default());
    }

    #[test]
    fn last_replies_keeps_the_written_replies_not_tool_calls() {
        let claude = lines(&[
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "one" }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": "Bash" }] } }),
            json!({ "type": "user", "message": { "content": "hi" } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "two" }] } }),
        ]);
        assert_eq!(last_replies(AgentKind::Claude, &claude, 1), ["two"]);
        let codex = json!({ "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "done" }] } });
        assert_eq!(
            last_replies(AgentKind::Codex, &format!("{codex}\nnot json"), 3),
            ["done"]
        );
    }

    #[test]
    fn transcript_stats_counts_prompts_and_replies_and_keeps_the_first_prompt() {
        let claude = lines(&[
            json!({ "type": "user", "isMeta": true, "message": { "content": "Caveat: local commands" } }),
            json!({ "type": "user", "message": { "content": "<command-name>/clear</command-name>" } }),
            json!({ "type": "user", "message": { "content": "Fix the build" } }),
            json!({ "type": "assistant", "message": { "id": "m1", "content": [{ "type": "text", "text": "On it" }] } }),
            json!({ "type": "assistant", "message": { "id": "m1", "content": [{ "type": "tool_use" }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": "ok" }] } }),
            json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "text", "text": "Done" }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "text", "text": "Thanks" }] } }),
        ]);
        assert_eq!(
            transcript_stats(AgentKind::Claude, &claude),
            TranscriptStats {
                messages: 4,
                first_prompt: Some("Fix the build".into())
            }
        );
        let codex = lines(&[
            json!({ "type": "response_item", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<environment_context>" }] } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "Add a test" } }),
            json!({ "type": "event_msg", "payload": { "type": "agent_message", "message": "Added" } }),
        ]);
        assert_eq!(
            transcript_stats(AgentKind::Codex, &codex),
            TranscriptStats {
                messages: 2,
                first_prompt: Some("Add a test".into())
            }
        );
    }

    #[test]
    fn transcript_usage_finds_both_agents_files_and_refuses_odd_ids() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude/projects/-repo");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("c1.jsonl"),
            json!({ "message": { "id": "a", "usage": { "input_tokens": 3, "output_tokens": 4 } } })
                .to_string(),
        )
        .unwrap();
        let day = home.path().join(".codex/sessions/2026/10/22");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-2026-10-22T10-00-00-x1.jsonl"), "").unwrap();
        assert_eq!(
            transcript_usage(home.path(), AgentKind::Claude, "c1").unwrap(),
            Some(SessionUsage {
                input: 3,
                output: 4,
                cached: 0,
                cost_usd: None
            })
        );
        assert_eq!(
            transcript_usage(home.path(), AgentKind::Codex, "x1").unwrap(),
            Some(SessionUsage::default())
        );
        assert_eq!(
            transcript_usage(home.path(), AgentKind::Claude, "gone").unwrap(),
            None
        );
        assert_eq!(
            transcript_path(home.path(), AgentKind::Claude, "../-repo/c1"),
            None
        );
    }
}
