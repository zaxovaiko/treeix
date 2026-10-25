//! The browser pane's webviews: one child webview per `browser:<id>` pane leaf, laid over the pane's rect in the
//! main window with `Window::add_child` (tauri `unstable`). This module is the only user of that API. An injected
//! script reports console and network entries and serves the agent tools (snapshot, click, type).
//! Contract: docs/contracts/phase67-contract.md. Owner: B7

mod cookies;
mod tools;

pub use cookies::{cookie_profiles, import_cookies};
pub use tools::tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewBuilder,
    WebviewUrl,
};
use tauri_specta::Event;

/// The pane's rect in logical px from the main window's top-left
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BrowserNav {
    Back,
    Forward,
    Reload,
    Stop,
}

/// What the pane's bar shows
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    /// The pane leaf's id, after `browser:`
    pub pane: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// The last load failed, like `Nothing is answering on localhost:5173`
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConsoleLevel {
    Error,
    Warning,
    Info,
    Log,
    Debug,
}

/// A console message or a request of the page, for the pane's DevTools strip and "Send to agent"
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserEntry {
    #[serde(rename_all = "camelCase")]
    Console {
        id: String,
        level: ConsoleLevel,
        text: String,
        /// `file:line:column` it came from
        source: String,
        /// Unix ms
        time: u64,
    },
    #[serde(rename_all = "camelCase")]
    Network {
        id: String,
        method: String,
        url: String,
        /// None while pending or when it failed
        status: Option<u16>,
        failed: Option<String>,
        started_at: u64,
        duration_ms: Option<f64>,
    },
}

/// Pushed to every window
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserEvent {
    /// An agent opened a pane (browser_navigate without a tab); the window adds its leaf
    Opened { state: BrowserState },
    /// Navigation, title, loading or history changed
    Changed { state: BrowserState },
    /// New entries, batched; `reset` drops the earlier ones (a new page loaded)
    Entries {
        pane: String,
        reset: bool,
        entries: Vec<BrowserEntry>,
    },
    /// The webview is gone (closed, crashed)
    Closed { pane: String },
}

/// A browser profile cookies can come from
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    /// What `import_cookies` takes
    pub key: String,
    /// Chrome, Arc, Brave, Edge, Chromium, Vivaldi, Firefox, Safari
    pub browser: String,
    pub name: String,
    /// The OS keeps it from Treeix (Safari without Full Disk Access)
    pub blocked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CookieImport {
    pub imported: u32,
    pub skipped: u32,
    pub error: Option<String>,
}

const INJECT: &str = include_str!("inject.js");
/// Console and network entries kept per pane for the agent tools
const ENTRY_LIMIT: usize = 500;
const TEXT_LIMIT: usize = 4000;
// ponytail: polls every pane for its entries; a page-to-app channel without exposing IPC to pages if it ever matters
const POLL: Duration = Duration::from_millis(300);
/// How long a local dev server gets to accept a connection before the pane says nothing is answering
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

struct Pane {
    webview: Webview,
    state: BrowserState,
    entries: Vec<BrowserEntry>,
}

static PANES: LazyLock<Mutex<HashMap<String, Pane>>> = LazyLock::new(Default::default);

fn panes() -> MutexGuard<'static, HashMap<String, Pane>> {
    PANES.lock().unwrap_or_else(PoisonError::into_inner)
}

fn settings() -> treeix_core::settings::Settings {
    treeix_core::settings::load(&treeix_proto::data_dir())
}

fn emit(app: &AppHandle, event: BrowserEvent) {
    if let Err(e) = event.emit(app) {
        tracing::warn!("browser event: {e}");
    }
}

fn webview(pane: &str) -> Result<Webview, String> {
    panes()
        .get(pane)
        .map(|entry| entry.webview.clone())
        .ok_or_else(|| format!("No browser pane {pane}"))
}

fn state(pane: &str) -> Result<BrowserState, String> {
    panes()
        .get(pane)
        .map(|entry| entry.state.clone())
        .ok_or_else(|| format!("No browser pane {pane}"))
}

/// Changes the pane's state and tells the windows when it changed
fn update(app: &AppHandle, pane: &str, change: impl FnOnce(&mut BrowserState)) {
    let state = {
        let mut panes = panes();
        let Some(entry) = panes.get_mut(pane) else {
            return;
        };
        let before = entry.state.clone();
        change(&mut entry.state);
        if entry.state == before {
            return;
        }
        entry.state.clone()
    };
    emit(app, BrowserEvent::Changed { state });
}

fn valid_pane(pane: &str) -> Result<(), String> {
    let valid = (1..=64).contains(&pane.len())
        && pane
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(format!("{pane} is not a browser pane id"))
    }
}

/// Pages, not app or file URLs
fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "blob" | "data")
}

/// A hidden child webview of the main window on the panes' shared data store
fn create(app: &AppHandle, label: &str, pane: &str) -> Result<Webview, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Treeix has no main window")?
        .as_ref()
        .window();
    let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
    let builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
        .initialization_script(INJECT)
        .devtools(true)
        .on_navigation(allowed)
        .on_new_window({
            // Links that open a window load in the pane instead
            let pane = pane.to_string();
            move |url, _| {
                if allowed(&url)
                    && let Ok(webview) = webview(&pane)
                {
                    let _ = webview.navigate(url);
                }
                NewWindowResponse::Deny
            }
        })
        .on_document_title_changed({
            let (app, pane) = (app.clone(), pane.to_string());
            move |_, title| update(&app, &pane, |state| state.title = title)
        })
        .on_page_load({
            let (app, pane) = (app.clone(), pane.to_string());
            move |_, payload| {
                let url = payload.url().to_string();
                let loading = payload.event() == PageLoadEvent::Started;
                update(&app, &pane, |state| {
                    state.url = url;
                    state.loading = loading;
                    if loading {
                        state.error = None;
                    }
                });
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(*b"treeix-browser01");
    #[cfg(not(target_os = "macos"))]
    let builder = builder.data_directory(treeix_proto::data_dir().join("browser"));
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    webview.hide().map_err(|e| e.to_string())?;
    Ok(webview)
}

/// Creates the pane's webview hidden at `url`, or returns the one it has; `place` shows it
pub fn open(app: &AppHandle, pane: &str, url: &str) -> Result<BrowserState, String> {
    valid_pane(pane)?;
    if let Ok(state) = state(pane) {
        return Ok(state);
    }
    if !settings().features.browser {
        return Err("The browser is off in Settings > Features".into());
    }
    let webview = create(app, &format!("browser-{pane}"), pane)?;
    let initial = BrowserState {
        pane: pane.into(),
        url: String::new(),
        title: String::new(),
        loading: false,
        can_go_back: false,
        can_go_forward: false,
        error: None,
    };
    panes().insert(
        pane.into(),
        Pane {
            webview,
            state: initial,
            entries: Vec::new(),
        },
    );
    tauri::async_runtime::spawn(poll(app.clone(), pane.to_string()));
    if !url.trim().is_empty() {
        navigate(app, pane, url)?;
    }
    state(pane)
}

/// The webview over `bounds`, None when there is nothing to show (zero or broken sizes)
fn rect(bounds: Bounds) -> Option<Rect> {
    let Bounds {
        x,
        y,
        width,
        height,
    } = bounds;
    let finite = [x, y, width, height].iter().all(|v| v.is_finite());
    (finite && width >= 1.0 && height >= 1.0).then(|| Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width, height).into(),
    })
}

/// Moves the webview over the pane; None hides it (popovers, dialogs, another tab, a pane that scrolled away)
pub fn place(app: &AppHandle, pane: &str, bounds: Option<Bounds>) -> Result<(), String> {
    let _ = app;
    let webview = webview(pane)?;
    match bounds.and_then(rect) {
        Some(rect) => webview.set_bounds(rect).and_then(|()| webview.show()),
        None => webview.hide(),
    }
    .map_err(|e| e.to_string())
}

pub fn close(app: &AppHandle, pane: &str) -> Result<(), String> {
    let Some(entry) = panes().remove(pane) else {
        return Ok(());
    };
    entry.webview.close().map_err(|e| e.to_string())?;
    emit(app, BrowserEvent::Closed { pane: pane.into() });
    Ok(())
}

/// Dev servers: localhost and its subdomains, IPv4 addresses (LAN devices, Docker) and IPv6 loopback, all plain http
fn local_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let label = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    };
    let ipv4 = {
        let parts: Vec<&str> = host.split('.').collect();
        parts.len() == 4
            && parts
                .iter()
                .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    };
    host == "[::1]"
        || ipv4
        || host == "localhost"
        || host
            .strip_suffix(".localhost")
            .is_some_and(|sub| sub.split('.').all(label))
}

/// `host` and `host:port` without what follows; None when the port is not digits
fn host_of(text: &str) -> (&str, Option<&str>) {
    let end = text.find(['/', '?', '#']).unwrap_or(text.len());
    let authority = &text[..end];
    match authority.rsplit_once(':') {
        Some((host, port))
            if !host.ends_with(':')
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            (host, Some(port))
        }
        _ => (authority, None),
    }
}

/// encodeURIComponent
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// What the address bar loads: a URL as typed, a host completed with a scheme, anything else searched
fn to_url(input: &str, search_url: &str) -> String {
    let text = input.trim();
    if text.is_empty() {
        return "about:blank".into();
    }
    let spaced = text.contains(char::is_whitespace);
    let scheme = text.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-_".contains(c))
    });
    let lower = text.to_ascii_lowercase();
    // Like Chrome: a space means words to search, even after a scheme
    if (scheme && !spaced)
        || ["about:", "data:", "file:"]
            .iter()
            .any(|p| lower.starts_with(p))
    {
        return text.into();
    }
    let (host, _) = host_of(text);
    if !spaced && local_host(host) {
        return format!("http://{text}");
    }
    let domain = !spaced
        && !host.contains('@')
        && host.rsplit_once('.').is_some_and(|(name, tld)| {
            !name.is_empty() && tld.chars().count() >= 2 && tld.chars().all(char::is_alphabetic)
        });
    if domain {
        return format!("https://{text}");
    }
    if search_url.contains("%s") {
        search_url.replace("%s", &encode(text))
    } else {
        format!("{search_url}{}", encode(text))
    }
}

/// `host:port` of a local address nothing accepts connections on
fn local_down(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    if !local_host(host) {
        return None;
    }
    let port = url.port_or_known_default()?;
    let addrs = (host.trim_matches(['[', ']']), port)
        .to_socket_addrs()
        .ok()?;
    let answering = addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).is_ok());
    (!answering).then(|| format!("{host}:{port}"))
}

/// A URL, a bare host (`localhost:5173`) or search text (settings.browser.searchUrl)
pub fn navigate(app: &AppHandle, pane: &str, input: &str) -> Result<(), String> {
    let url = to_url(input, &settings().browser.search_url);
    let parsed = Url::parse(&url).map_err(|_| format!("{input} is not an address"))?;
    if !allowed(&parsed) {
        return Err("Only web pages open in the browser pane".into());
    }
    let webview = webview(pane)?;
    if let Some(host) = local_down(&parsed) {
        update(app, pane, |state| {
            state.url = url;
            state.loading = false;
            state.error = Some(format!("Nothing is answering on {host}"));
        });
        return Ok(());
    }
    update(app, pane, |state| {
        state.url = url;
        state.loading = true;
        state.error = None;
    });
    webview.navigate(parsed).map_err(|e| e.to_string())
}

pub fn go(app: &AppHandle, pane: &str, nav: BrowserNav) -> Result<(), String> {
    let webview = webview(pane)?;
    match nav {
        BrowserNav::Back => webview.eval("history.back()"),
        BrowserNav::Forward => webview.eval("history.forward()"),
        BrowserNav::Stop => {
            update(app, pane, |state| state.loading = false);
            webview.eval("window.stop()")
        }
        BrowserNav::Reload => {
            // A server that was down never loaded, so there is nothing to reload; try it again
            let state = state(pane)?;
            if state.error.is_some() {
                return navigate(app, pane, &state.url);
            }
            webview.reload()
        }
    }
    .map_err(|e| e.to_string())
}

/// The web inspector for the pane's page
pub fn devtools(app: &AppHandle, pane: &str) -> Result<(), String> {
    let _ = app;
    let webview = webview(pane)?;
    if webview.is_devtools_open() {
        webview.close_devtools();
    } else {
        webview.open_devtools();
    }
    Ok(())
}

/// Runs `work` on a webview of the panes' shared data store, a hidden one while no pane is open
fn with_store<T>(
    app: &AppHandle,
    work: impl FnOnce(&Webview) -> Result<T, String>,
) -> Result<T, String> {
    let open = panes().values().next().map(|entry| entry.webview.clone());
    if let Some(webview) = open {
        return work(&webview);
    }
    let webview = create(app, "browser-store", "")?;
    let result = work(&webview);
    let _ = webview.close();
    result
}

/// Cookies, storage and cache of every pane
pub fn clear_data(app: &AppHandle) -> Result<(), String> {
    with_store(app, |webview| {
        webview.clear_all_browsing_data().map_err(|e| e.to_string())
    })
}

const DEV_SCRIPTS: [&str; 3] = ["dev", "start", "serve"];
const LOCKFILES: [(&str, &str); 4] = [
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
];

/// `pnpm run dev` for the first dev-like script in package.json, with the package manager its lockfile names
fn dev_script(package: &Value, lockfiles: &[&str]) -> Option<String> {
    let scripts = package.get("scripts")?.as_object()?;
    let script = DEV_SCRIPTS
        .iter()
        .find(|name| scripts.contains_key(**name))?;
    let manager = LOCKFILES
        .iter()
        .find(|(file, _)| lockfiles.contains(file))
        .map_or("npm", |(_, manager)| manager);
    Some(format!("{manager} run {script}"))
}

/// `PORT=<free> bun run dev` for the folder's first dev / start / serve script, by its lockfile; None without one.
/// PORT is honored by Next, Nuxt, Remix, Astro and most Node servers
pub fn dev_command(folder: &str) -> Result<Option<String>, String> {
    let folder = Path::new(folder);
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    let Ok(bytes) = std::fs::read(folder.join("package.json")) else {
        return Ok(None);
    };
    let package: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let present: Vec<&str> = LOCKFILES
        .iter()
        .map(|(file, _)| *file)
        .filter(|file| folder.join(file).exists())
        .collect();
    let Some(command) = dev_script(&package, &present) else {
        return Ok(None);
    };
    let port = TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map_err(|e| e.to_string())?
        .port();
    Ok(Some(format!("PORT={port} {command}")))
}

fn clip(text: &mut String) {
    if let Some((at, _)) = text.char_indices().nth(TEXT_LIMIT) {
        text.truncate(at);
        text.push_str("...");
    }
}

/// An entry from the page, which may say anything
fn entry(value: &Value) -> Option<BrowserEntry> {
    let mut entry: BrowserEntry = serde_json::from_value(value.clone()).ok()?;
    match &mut entry {
        BrowserEntry::Console {
            id, text, source, ..
        } => [id, text, source].into_iter().for_each(clip),
        BrowserEntry::Network {
            id,
            method,
            url,
            failed,
            ..
        } => {
            [id, method, url].into_iter().for_each(clip);
            failed.iter_mut().for_each(clip);
        }
    }
    Some(entry)
}

fn entry_id(entry: &BrowserEntry) -> &str {
    match entry {
        BrowserEntry::Console { id, .. } | BrowserEntry::Network { id, .. } => id,
    }
}

/// Newest last; a request that changed replaces its earlier row
fn keep(list: &mut Vec<BrowserEntry>, reset: bool, entries: &[BrowserEntry]) {
    if reset {
        list.clear();
    }
    for entry in entries {
        list.retain(|kept| entry_id(kept) != entry_id(entry));
        list.push(entry.clone());
    }
    let over = list.len().saturating_sub(ENTRY_LIMIT);
    list.drain(..over);
}

/// The injected script's batch: history and what the page logged and loaded since the last one
fn drained(app: &AppHandle, pane: &str, json: &str) {
    let Ok(batch) = serde_json::from_str::<Value>(json) else {
        return;
    };
    if !batch.is_object() {
        return;
    }
    let flag = |name: &str| batch[name].as_bool().unwrap_or(false);
    let (back, forward, reset) = (flag("canGoBack"), flag("canGoForward"), flag("reset"));
    update(app, pane, |state| {
        state.can_go_back = back;
        state.can_go_forward = forward;
    });
    let entries: Vec<BrowserEntry> = batch["entries"]
        .as_array()
        .map(|items| items.iter().filter_map(entry).collect())
        .unwrap_or_default();
    if !reset && entries.is_empty() {
        return;
    }
    match panes().get_mut(pane) {
        Some(open) => keep(&mut open.entries, reset, &entries),
        None => return,
    }
    emit(
        app,
        BrowserEvent::Entries {
            pane: pane.into(),
            reset,
            entries,
        },
    );
}

async fn poll(app: AppHandle, pane: String) {
    loop {
        tokio::time::sleep(POLL).await;
        let Ok(webview) = webview(&pane) else {
            return;
        };
        let (app, pane) = (app.clone(), pane.clone());
        let _ = webview.eval_with_callback(
            "window.__treeix ? window.__treeix.drain() : null",
            move |json| drained(&app, &pane, &json),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rect_lays_the_webview_over_the_pane_and_skips_empty_or_broken_sizes() {
        let bounds = |x, y, width, height| Bounds {
            x,
            y,
            width,
            height,
        };
        let rect = rect(bounds(10.0, 40.5, 300.0, 200.0)).expect("a rect");
        assert_eq!(rect.position, LogicalPosition::new(10.0, 40.5).into());
        assert_eq!(rect.size, LogicalSize::new(300.0, 200.0).into());
        assert!(super::rect(bounds(0.0, 0.0, 0.0, 200.0)).is_none());
        assert!(super::rect(bounds(0.0, 0.0, 300.0, 0.5)).is_none());
        assert!(super::rect(bounds(f64::NAN, 0.0, 300.0, 200.0)).is_none());
        assert!(super::rect(bounds(0.0, 0.0, f64::INFINITY, 200.0)).is_none());
    }

    #[test]
    fn to_url_keeps_urls_completes_hosts_and_searches_the_rest() {
        let google = "https://www.google.com/search?q=%s";
        let cases = [
            ("https://example.com/a", "https://example.com/a"),
            ("localhost:3000", "http://localhost:3000"),
            ("127.0.0.1:8080/x", "http://127.0.0.1:8080/x"),
            ("192.168.1.5:8080", "http://192.168.1.5:8080"),
            ("app.localhost:5173/x", "http://app.localhost:5173/x"),
            ("0.0.0.0:3000", "http://0.0.0.0:3000"),
            ("1.2.3", "https://www.google.com/search?q=1.2.3"),
            ("github.com/zaxovaiko", "https://github.com/zaxovaiko"),
            ("about:blank", "about:blank"),
            ("  ", "about:blank"),
            (
                "react hooks",
                "https://www.google.com/search?q=react%20hooks",
            ),
            ("пример.рф", "https://пример.рф"),
            ("medium.com/@treeix", "https://medium.com/@treeix"),
            (
                "me@example.com",
                "https://www.google.com/search?q=me%40example.com",
            ),
            (
                "https://ex ample.com",
                "https://www.google.com/search?q=https%3A%2F%2Fex%20ample.com",
            ),
        ];
        for (input, url) in cases {
            assert_eq!(to_url(input, google), url, "{input}");
        }
        assert_eq!(
            to_url("treeix", "https://duckduckgo.com/?q=%s"),
            "https://duckduckgo.com/?q=treeix"
        );
    }

    #[test]
    fn local_down_names_a_local_port_nothing_listens_on() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let url = |text: String| Url::parse(&text).expect("url");
        assert_eq!(local_down(&url(format!("http://127.0.0.1:{port}/"))), None);
        // Not a freed ephemeral port: another test can take it, or the connect can pick it as its own source port
        assert_eq!(
            local_down(&url("http://127.0.0.1:1/".into())),
            Some("127.0.0.1:1".into())
        );
        assert_eq!(local_down(&url("https://example.com/".into())), None);
    }

    #[test]
    fn dev_script_runs_the_first_dev_like_script_with_the_lockfile_package_manager() {
        assert_eq!(
            dev_script(
                &json!({ "scripts": { "start": "x", "dev": "y" } }),
                &["pnpm-lock.yaml"]
            )
            .as_deref(),
            Some("pnpm run dev")
        );
        assert_eq!(
            dev_script(&json!({ "scripts": { "serve": "x" } }), &[]).as_deref(),
            Some("npm run serve")
        );
        assert_eq!(
            dev_script(&json!({ "scripts": { "build": "x" } }), &["bun.lock"]),
            None
        );
        assert_eq!(dev_script(&Value::Null, &[]), None);
    }

    #[test]
    fn dev_command_adds_a_free_port() {
        let dir = std::env::temp_dir().join(format!("treeix-dev-command-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).expect("write");
        std::fs::write(dir.join("bun.lock"), "").expect("write");
        let command = dev_command(&dir.to_string_lossy())
            .expect("command")
            .expect("some");
        let _ = std::fs::remove_dir_all(&dir);
        let port = command
            .strip_prefix("PORT=")
            .and_then(|rest| rest.strip_suffix(" bun run dev"));
        assert!(
            port.is_some_and(|port| port.parse::<u16>().is_ok()),
            "{command}"
        );
        assert!(dev_command("relative").is_err());
    }

    #[test]
    fn keep_replaces_changed_requests_keeps_the_last_entries_and_resets() {
        let console = |id: &str| BrowserEntry::Console {
            id: id.into(),
            level: ConsoleLevel::Log,
            text: id.into(),
            source: String::new(),
            time: 0,
        };
        let request = |status: Option<u16>| BrowserEntry::Network {
            id: "r".into(),
            method: "GET".into(),
            url: "http://localhost/".into(),
            status,
            failed: None,
            started_at: 0,
            duration_ms: None,
        };
        let mut list = Vec::new();
        keep(&mut list, false, &[request(None), console("a")]);
        keep(&mut list, false, &[request(Some(200))]);
        assert_eq!(list, vec![console("a"), request(Some(200))]);
        let many: Vec<BrowserEntry> = (0..ENTRY_LIMIT + 2)
            .map(|n| console(&n.to_string()))
            .collect();
        keep(&mut list, false, &many);
        assert_eq!(list.len(), ENTRY_LIMIT);
        assert_eq!(list.first(), Some(&console("2")));
        keep(&mut list, true, &[console("b")]);
        assert_eq!(list, vec![console("b")]);
    }

    #[test]
    fn entry_reads_the_page_defensively() {
        let long = "x".repeat(TEXT_LIMIT + 10);
        let parsed = entry(
            &json!({ "kind": "console", "id": "e1", "level": "warning", "text": long, "source": "a.js:1", "time": 5 }),
        );
        let Some(BrowserEntry::Console { level, text, .. }) = parsed else {
            panic!("a console entry");
        };
        assert_eq!(level, ConsoleLevel::Warning);
        assert_eq!(text.chars().count(), TEXT_LIMIT + 3);
        assert!(entry(&json!({ "kind": "console", "id": 1 })).is_none());
        assert!(entry(&json!({ "kind": "network", "id": "r", "method": "GET", "url": "u", "status": 404, "failed": null, "startedAt": 1, "durationMs": 2.5 })).is_some());
    }

    #[test]
    fn valid_pane_takes_short_plain_ids() {
        assert!(valid_pane("a1B2-c_3").is_ok());
        assert!(valid_pane("").is_err());
        assert!(valid_pane("../x").is_err());
        assert!(valid_pane(&"a".repeat(65)).is_err());
    }
}
