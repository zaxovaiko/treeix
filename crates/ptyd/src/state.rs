//! `state.json` and the per-session screen snapshots in the data dir.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use treeix_proto::SessionInfo;

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

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}
