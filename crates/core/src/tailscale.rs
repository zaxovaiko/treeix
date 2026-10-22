//! The phone page over Tailscale: who is signed in on this Mac, and `tailscale serve` of ptyd's remote.sock on 443.
//! Serving a Unix socket needs root, so turning it on or off asks for the admin password

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Command;

/// This Mac on the tailnet
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// The Tailscale account, like `you@example.com`
    pub login: String,
    /// Like `mac.tail1234.ts.net`
    pub dns_name: String,
}

/// Where ptyd serves the phone page
pub fn socket(data_dir: &Path) -> PathBuf {
    data_dir.join("remote.sock")
}

/// Err says why the page can't be served: not installed, signed out, stopped
pub fn node() -> Result<Node, String> {
    let output = Command::new(binary()?)
        .args(["status", "--json"])
        .output()
        .map_err(|e| e.to_string())?;
    let status: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Tailscale is not running".to_string())?;
    parse_node(&status)
}

fn parse_node(status: &Value) -> Result<Node, String> {
    if status["BackendState"] != "Running" {
        return Err("Tailscale is not connected".into());
    }
    let me = &status["Self"];
    let user = me["UserID"]
        .as_u64()
        .map(|id| &status["User"][id.to_string()]);
    match (
        user.and_then(|u| u["LoginName"].as_str()),
        me["DNSName"].as_str(),
    ) {
        (Some(login), Some(dns)) if !dns.is_empty() => Ok(Node {
            login: login.to_owned(),
            dns_name: dns.trim_end_matches('.').to_owned(),
        }),
        _ => Err("Tailscale has no signed-in user".into()),
    }
}

/// `tailscale serve` points at `socket` now
pub fn serving(socket: &Path) -> bool {
    let Ok(output) = binary().and_then(|bin| {
        Command::new(bin)
            .args(["serve", "status", "--json"])
            .output()
            .map_err(|e| e.to_string())
    }) else {
        return false;
    };
    serde_json::from_slice(&output.stdout).is_ok_and(|config| proxies_to(&config, socket))
}

fn proxies_to(config: &Value, socket: &Path) -> bool {
    let target = format!("unix:{}", socket.display());
    config["Web"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(_, site)| {
            site["Handlers"]
                .as_object()
                .into_iter()
                .flatten()
                .any(|(_, handler)| handler["Proxy"] == target.as_str())
        })
}

/// `https://<this Mac>/` serves `socket` to the tailnet, or nothing on 443. Asks for the admin password
pub fn serve(socket: &Path, on: bool) -> Result<(), String> {
    let bin = shell_quote(&binary()?.to_string_lossy());
    let command = if on {
        let target = shell_quote(&format!("unix:{}", socket.display()));
        format!("{bin} serve --bg --https=443 {target}")
    } else {
        format!("{bin} serve --https=443 off")
    };
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    Err(if error.contains("-128") {
        "Cancelled".into()
    } else {
        error.trim().to_owned()
    })
}

/// A GUI app has a bare PATH, and the admin shell an even barer one, so this is an absolute path
fn binary() -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    ["/opt/homebrew/bin", "/usr/local/bin"]
        .into_iter()
        .map(PathBuf::from)
        .chain(std::env::split_paths(&path))
        .map(|dir| dir.join("tailscale"))
        .chain([PathBuf::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        )])
        .find(|bin| bin.is_file())
        .ok_or_else(|| "Tailscale is not installed".into())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_node_is_the_signed_in_user_and_dns_name() {
        let status = json!({
            "BackendState": "Running",
            "Self": {"DNSName": "mac.tail1.ts.net.", "UserID": 7691989151766729u64},
            "User": {"7691989151766729": {"LoginName": "me@example.com"}}
        });
        let node = parse_node(&status).unwrap();
        assert_eq!(node.login, "me@example.com");
        assert_eq!(node.dns_name, "mac.tail1.ts.net");
        assert!(parse_node(&json!({"BackendState": "Stopped"})).is_err());
    }

    #[test]
    fn serving_means_a_handler_proxies_to_the_socket() {
        let socket = Path::new("/Users/me/Library/Application Support/Treeix/remote.sock");
        let config = json!({"Web": {"mac.tail1.ts.net:443": {"Handlers": {"/": {
            "Proxy": "unix:/Users/me/Library/Application Support/Treeix/remote.sock"
        }}}}});
        assert!(proxies_to(&config, socket));
        assert!(!proxies_to(&config, Path::new("/other/remote.sock")));
        assert!(!proxies_to(&json!({}), socket));
    }

    #[test]
    fn quoting_survives_spaces_and_quotes() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
