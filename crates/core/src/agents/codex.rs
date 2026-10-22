//! Codex conversations from its rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), so a codex
//! terminal learns the id `codex resume` takes. Port of the Electron terminal plugin's codex.ts

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexConversation {
    pub id: String,
    pub cwd: String,
    /// Unix millis
    pub started_at: u64,
}

const DAY_MS: i64 = 86_400_000;

/// The session_meta line Codex writes first in each rollout file
pub fn parse_rollout_head(head: &str) -> Option<CodexConversation> {
    let line = super::parse_line(head.lines().next()?)?;
    let payload = line.get("payload")?;
    Some(CodexConversation {
        id: payload.get("id")?.as_str()?.to_owned(),
        cwd: payload.get("cwd")?.as_str()?.to_owned(),
        started_at: super::timestamp_ms(payload.get("timestamp")?.as_str()?)?,
    })
}

/// Rollout files can be megabytes; the first line, long with Codex's instructions, is all that's needed
fn read_head(path: &Path) -> String {
    let mut head = String::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = BufReader::new(file).read_line(&mut head);
    }
    head
}

/// Conversations started in `cwd` since `since` (unix millis), oldest first
pub fn codex_conversations(home: &Path, cwd: &str, since: u64) -> Vec<CodexConversation> {
    let sessions = home.join(".codex/sessions");
    let mut days = std::collections::BTreeSet::new();
    // A day either side covers the UTC dates in the folder names and a session started just before midnight
    let mut time = since as i64 - DAY_MS;
    while time <= super::now_ms() as i64 + DAY_MS {
        if let Some(day) = super::local_day(time) {
            days.insert(day.replace('-', "/"));
        }
        time += DAY_MS;
    }
    let mut found: Vec<CodexConversation> = days
        .iter()
        .filter_map(|day| fs::read_dir(sessions.join(day)).ok())
        .flatten()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("rollout-") && name.ends_with(".jsonl")
        })
        .filter_map(|entry| parse_rollout_head(&read_head(&entry.path())))
        .filter(|c| c.cwd == cwd && c.started_at >= since)
        .collect();
    found.sort_by_key(|c| c.started_at);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rollout_head_reads_the_id_folder_and_start_of_a_codex_conversation() {
        let head = r#"{"type":"session_meta","payload":{"id":"abc","cwd":"/repo","timestamp":"2026-09-19T10:01:26.305Z"}}
{"partial":"#;
        assert_eq!(
            parse_rollout_head(head),
            Some(CodexConversation {
                id: "abc".into(),
                cwd: "/repo".into(),
                started_at: 1_789_812_086_305,
            })
        );
        assert_eq!(parse_rollout_head(r#"{"type":"other"}"#), None);
    }

    #[test]
    fn codex_conversations_finds_todays_rollouts_in_the_folder() {
        let home = tempfile::tempdir().unwrap();
        let now = super::super::now_ms();
        let day = super::super::local_day(now as i64)
            .unwrap()
            .replace('-', "/");
        let dir = home.path().join(".codex/sessions").join(day);
        fs::create_dir_all(&dir).unwrap();
        let at = jiff::Timestamp::from_millisecond(now as i64).unwrap();
        let meta = |id: &str, cwd: &str| {
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"{at}"}}}}"#
            )
        };
        fs::write(dir.join("rollout-1-a.jsonl"), meta("a", "/repo")).unwrap();
        fs::write(dir.join("rollout-2-b.jsonl"), meta("b", "/other")).unwrap();
        fs::write(dir.join("notes.txt"), meta("c", "/repo")).unwrap();
        let found = codex_conversations(home.path(), "/repo", now - 1000);
        assert_eq!(
            found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        assert!(codex_conversations(home.path(), "/repo", now + 60_000).is_empty());
    }
}
