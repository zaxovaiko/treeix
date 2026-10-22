//! The phone page (treeix_core::tailscale): ptyd's remote.sock served to the tailnet

use super::Result;
use super::files::blocking;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use treeix_core::settings;
use treeix_core::tailscale::{self, Node};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    /// This Mac on the tailnet; None with `problem` saying why
    pub node: Option<Node>,
    pub problem: Option<String>,
    /// An owner is set and `tailscale serve` points at remote.sock
    pub on: bool,
    /// `https://<this Mac>/`
    pub url: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn phone_status() -> Result<PhoneStatus> {
    blocking(|| Ok(status())).await
}

/// On serves the page for the signed-in Tailscale account; both ways ask for the admin password
#[tauri::command]
#[specta::specta]
pub async fn set_phone(app: AppHandle, on: bool) -> Result<PhoneStatus> {
    let socket = tailscale::socket(&treeix_proto::data_dir());
    let owner = if on {
        let node = blocking(tailscale::node).await?;
        let serving = socket.clone();
        blocking(move || tailscale::serve(&serving, true)).await?;
        Some(node.login)
    } else {
        None
    };
    // Off locks the page before the serve goes away, so a cancelled password prompt still leaves it shut
    super::update_settings(app, serde_json::json!({ "phone": { "owner": owner } })).await?;
    if !on && tailscale::serving(&socket) {
        blocking(move || tailscale::serve(&socket, false)).await?;
    }
    phone_status().await
}

fn status() -> PhoneStatus {
    let socket = tailscale::socket(&treeix_proto::data_dir());
    let owner = settings::load(&treeix_proto::data_dir()).phone.owner;
    match tailscale::node() {
        Ok(node) => PhoneStatus {
            on: owner.is_some() && tailscale::serving(&socket),
            url: Some(format!("https://{}/", node.dns_name)),
            node: Some(node),
            problem: None,
        },
        Err(problem) => PhoneStatus {
            node: None,
            problem: Some(problem),
            on: false,
            url: None,
        },
    }
}
