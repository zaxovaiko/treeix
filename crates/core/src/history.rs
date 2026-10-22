//! Local file history (a snapshot before each save, like history.ts) and the record of closed sessions.

use crate::fs::inside_root;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Snapshots closer together than this are merged into one
pub const MIN_GAP_MS: u64 = 60_000;
/// Oldest snapshots past this count are dropped
pub const MAX_ENTRIES: usize = 100;

/// One saved version of a file
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Millisecond timestamp as a string
    pub id: String,
    /// Unix ms
    pub saved_at: u64,
    pub bytes: u64,
}

/// What kind of session a record is
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordKind {
    Shell,
    Claude,
    Codex,
}

/// A closed session, for the History panel
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    /// The daemon session id it had
    pub id: String,
    pub kind: RecordKind,
    pub title: String,
    pub cwd: String,
    /// Branch it ran on, to offer "Recreate worktree" once the folder is gone
    pub branch: Option<String>,
    pub repo_root: Option<String>,
    /// Claude / Codex session id that `--resume` takes
    pub agent_session: Option<String>,
    pub command: Vec<String>,
    /// Unix ms
    pub created_at: u64,
    pub closed_at: u64,
    /// Agent transcript stats; None until Phase 4 reads transcripts
    pub messages: Option<u32>,
    pub cost: Option<f64>,
    pub first_prompt: Option<String>,
}

/// Snapshots of one file live in `dir/<sha1(root \0 file)>/<ms>.txt`
fn file_dir(dir: &Path, root: &str, file: &str) -> PathBuf {
    dir.join(
        sha1_smol::Sha1::from(format!("{root}\0{file}"))
            .digest()
            .to_string(),
    )
}

/// Snapshot ids, newest first
fn snapshot_ids(dir: &Path) -> Vec<u64> {
    let mut ids: Vec<u64> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_suffix(".txt")?
                .parse()
                .ok()
        })
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids
}

/// Keeps the on-disk version before it gets overwritten: one per burst of editing, since autosave writes on every pause
pub fn snapshot_before_save(dir: &Path, root: &str, file: &str, now: u64) -> Result<(), String> {
    let Ok(current) = fs::read_to_string(inside_root(Path::new(root), file)?) else {
        return Ok(());
    };
    let folder = file_dir(dir, root, file);
    let ids = snapshot_ids(&folder);
    if let Some(&latest) = ids.first() {
        if now.saturating_sub(latest) < MIN_GAP_MS {
            return Ok(());
        }
        if fs::read_to_string(folder.join(format!("{latest}.txt")))
            .ok()
            .as_deref()
            == Some(&current)
        {
            return Ok(());
        }
    }
    let failed = |e: std::io::Error| format!("history: {e}");
    fs::create_dir_all(&folder).map_err(failed)?;
    fs::write(folder.join(format!("{now}.txt")), current).map_err(failed)?;
    let meta = serde_json::json!({ "worktreePath": root, "filePath": file });
    fs::write(folder.join("file.json"), meta.to_string()).map_err(failed)?;
    for stale in ids.iter().skip(MAX_ENTRIES - 1) {
        let _ = fs::remove_file(folder.join(format!("{stale}.txt")));
    }
    Ok(())
}

/// Snapshots of a file, newest first
pub fn list(dir: &Path, root: &str, file: &str) -> Vec<HistoryEntry> {
    let folder = file_dir(dir, root, file);
    snapshot_ids(&folder)
        .into_iter()
        .filter_map(|id| {
            let bytes = fs::metadata(folder.join(format!("{id}.txt"))).ok()?.len();
            Some(HistoryEntry {
                id: id.to_string(),
                saved_at: id,
                bytes,
            })
        })
        .collect()
}

pub fn read(dir: &Path, root: &str, file: &str, id: &str) -> Result<String, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid snapshot id".into());
    }
    fs::read_to_string(file_dir(dir, root, file).join(format!("{id}.txt")))
        .map_err(|e| e.to_string())
}

/// Closed sessions, one JSON per line, oldest first
pub fn record_session(path: &Path, record: &SessionRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Newest first; unreadable lines are skipped
pub fn sessions(path: &Path) -> Vec<SessionRecord> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut records: Vec<SessionRecord> = text
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    records.sort_by_key(|record| std::cmp::Reverse(record.closed_at));
    records
}

pub fn forget_session(path: &Path, id: &str) -> Result<(), String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(());
    };
    let kept: String = text
        .lines()
        .filter(|line| {
            serde_json::from_str::<SessionRecord>(line).is_ok_and(|record| record.id != id)
        })
        .map(|line| format!("{line}\n"))
        .collect();
    // Written aside then renamed, so a crash never leaves half the history
    let aside = path.with_extension("jsonl.tmp");
    fs::write(&aside, kept).map_err(|e| e.to_string())?;
    fs::rename(aside, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_the_previous_version_at_most_once_a_minute_and_skips_duplicates() {
        let worktree = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let (root, dir) = (worktree.path().to_str().unwrap(), history.path());
        fs::write(worktree.path().join("a.ts"), "one").unwrap();
        snapshot_before_save(dir, root, "a.ts", 1_000_000).unwrap();
        fs::write(worktree.path().join("a.ts"), "two").unwrap();
        snapshot_before_save(dir, root, "a.ts", 1_030_000).unwrap();
        snapshot_before_save(dir, root, "a.ts", 1_100_000).unwrap();
        snapshot_before_save(dir, root, "a.ts", 1_200_000).unwrap();
        let saved: Vec<u64> = list(dir, root, "a.ts")
            .iter()
            .map(|entry| entry.saved_at)
            .collect();
        assert_eq!(saved, [1_100_000, 1_000_000]);
        assert_eq!(read(dir, root, "a.ts", "1000000").unwrap(), "one");
        assert_eq!(read(dir, root, "a.ts", "1100000").unwrap(), "two");
        assert!(read(dir, root, "a.ts", "../x").is_err());
        snapshot_before_save(dir, root, "missing.ts", 1_000_000).unwrap();
        assert!(list(dir, root, "missing.ts").is_empty());
    }

    #[test]
    fn keeps_the_newest_hundred() {
        let worktree = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let (root, dir) = (worktree.path().to_str().unwrap(), history.path());
        for index in 0..105u64 {
            fs::write(worktree.path().join("a.ts"), index.to_string()).unwrap();
            snapshot_before_save(dir, root, "a.ts", index * MIN_GAP_MS).unwrap();
        }
        let entries = list(dir, root, "a.ts");
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].saved_at, 104 * MIN_GAP_MS);
    }

    fn record(id: &str, closed_at: u64) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            kind: RecordKind::Claude,
            title: "t".into(),
            cwd: "/repo".into(),
            branch: Some("main".into()),
            repo_root: Some("/repo".into()),
            agent_session: None,
            command: vec!["claude".into()],
            created_at: 1,
            closed_at,
            messages: None,
            cost: None,
            first_prompt: None,
        }
    }

    #[test]
    fn records_closed_sessions_newest_first_and_forgets_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.jsonl");
        assert!(sessions(&path).is_empty());
        record_session(&path, &record("a", 10)).unwrap();
        record_session(&path, &record("b", 20)).unwrap();
        let ids: Vec<String> = sessions(&path)
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(ids, ["b", "a"]);
        forget_session(&path, "b").unwrap();
        assert_eq!(sessions(&path), [record("a", 10)]);
    }
}
