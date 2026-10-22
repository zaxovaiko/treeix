//! Secrets in the OS keyring (keyring crate). Where none answers (Linux without a secret service) they go to
//! `<data dir>/secrets.json`, mode 0600. Values never reach the webview.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub const SERVICE: &str = "com.dyvertex.treeix";
/// Keyring account of the MCP server's bearer token, which the webview never asks for
pub const MCP_TOKEN: &str = "mcp-token";
/// macOS always has a keychain; a failing one is an error to show, not a reason to write a file
const FILE_FALLBACK: bool = cfg!(target_os = "linux");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Secret {
    NotionToken,
}

impl Secret {
    /// The keyring account name
    pub fn account(self) -> &'static str {
        match self {
            Self::NotionToken => "notion-token",
        }
    }
}

pub fn get(data_dir: &Path, secret: Secret) -> Result<Option<String>, String> {
    get_account(data_dir, secret.account())
}

pub fn set(data_dir: &Path, secret: Secret, value: &str) -> Result<(), String> {
    set_account(data_dir, secret.account(), value)
}

/// Gone already is fine
pub fn delete(data_dir: &Path, secret: Secret) -> Result<(), String> {
    delete_account(data_dir, secret.account())
}

fn entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, account)
}

pub fn get_account(data_dir: &Path, account: &str) -> Result<Option<String>, String> {
    match entry(account).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        // An earlier fallback may hold it
        Err(_) if FILE_FALLBACK => Ok(read_file(data_dir).remove(account)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

pub fn set_account(data_dir: &Path, account: &str, value: &str) -> Result<(), String> {
    match entry(account).and_then(|entry| entry.set_password(value)) {
        Ok(()) => Ok(()),
        Err(_) if FILE_FALLBACK => {
            let mut secrets = read_file(data_dir);
            secrets.insert(account.into(), value.into());
            write_file(data_dir, &secrets)
        }
        Err(e) => Err(format!("keychain: {e}")),
    }
}

pub fn delete_account(data_dir: &Path, account: &str) -> Result<(), String> {
    let keyring = match entry(account).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) if FILE_FALLBACK => Ok(()),
        Err(e) => Err(format!("keychain: {e}")),
    };
    let mut secrets = read_file(data_dir);
    if secrets.remove(account).is_some() {
        write_file(data_dir, &secrets)?;
    }
    keyring
}

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets.json")
}

fn read_file(data_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read(file(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Created 0600 before any byte is written, then renamed over the old file
fn write_file(data_dir: &Path, secrets: &BTreeMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
    let tmp = data_dir.join("secrets.json.tmp");
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let _ = std::fs::remove_file(&tmp);
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        out.write_all(&json)?;
        out.sync_all()?;
        std::fs::rename(&tmp, file(data_dir))
    };
    write().map_err(|e| format!("secrets file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn the_fallback_file_is_private_and_keeps_other_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let mut secrets = BTreeMap::from([("a".to_string(), "1".to_string())]);
        write_file(dir.path(), &secrets).unwrap();
        secrets.insert("b".into(), "2".into());
        write_file(dir.path(), &secrets).unwrap();
        assert_eq!(read_file(dir.path()), secrets);
        let mode = std::fs::metadata(file(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_unreadable_fallback_file_holds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_file(dir.path()).is_empty());
        std::fs::write(file(dir.path()), "not json").unwrap();
        assert!(read_file(dir.path()).is_empty());
    }
}
