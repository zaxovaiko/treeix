//! `state.json` and the per-session screen snapshots in the data dir.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use treeix_proto::{SessionInfo, SessionKind};

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    /// False while a daemon runs; still false on the next start means it crashed
    pub clean_shutdown: bool,
    pub ui: Option<String>,
    pub sessions: Vec<SavedSession>,
}

#[derive(Serialize, Deserialize)]
pub struct SavedSession {
    pub info: SessionInfo,
    /// Kept for Restart
    pub env: Vec<(String, String)>,
    /// `procinfo::start_time` of `info.pid`, so a later daemon only kills that process and never a reused pid
    #[serde(default)]
    pub started: Option<u64>,
    /// The agent a shell ran in the foreground (`info.kind` is the kind it was launched as), so Restart resumes it
    #[serde(default)]
    pub foreground: Option<SessionKind>,
}

pub fn load(dir: &Path) -> State {
    match fs::read(dir.join("state.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::error!("state.json is unreadable, starting empty: {e}");
            State::default()
        }),
        Err(_) => State::default(),
    }
}

pub fn save(dir: &Path, state: &State) -> io::Result<()> {
    write_atomic(&dir.join("state.json"), &serde_json::to_vec_pretty(state)?)
}

fn snapshot_path(dir: &Path, session: &str) -> PathBuf {
    dir.join("sessions").join(format!("{session}.ansi.zst"))
}

pub fn save_snapshot(dir: &Path, session: &str, ansi: &[u8]) -> io::Result<()> {
    let path = snapshot_path(dir, session);
    fs::create_dir_all(dir.join("sessions"))?;
    write_atomic(&path, &zstd::encode_all(ansi, 3)?)
}

pub fn load_snapshot(dir: &Path, session: &str) -> Option<Vec<u8>> {
    zstd::decode_all(fs::File::open(snapshot_path(dir, session)).ok()?).ok()
}

pub fn remove_snapshot(dir: &Path, session: &str) {
    let _ = fs::remove_file(snapshot_path(dir, session));
}

/// The tmp name is unique per call, so concurrent writers of one file never rename each other's tmp away
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}
