//! The browser tools agents get over MCP. A tab is a browser pane; the page is driven through the injected script.
//! Port of the Electron app's browser agentTools.ts.

use super::{BrowserEntry, BrowserEvent, BrowserNav, emit, panes, state, webview};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use treeix_core::mcp::{McpTool, ToolFuture};

/// How long a page gets to load before a tool answers anyway
const SETTLE: Duration = Duration::from_secs(15);
const ANSWER: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 60_000;

fn tool(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    run: impl Fn(AppHandle, Value) -> ToolFuture + Send + Sync + 'static,
    app: &AppHandle,
) -> McpTool {
    let app = app.clone();
    McpTool {
        name: name.into(),
        description: description.into(),
        input_schema: json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false }),
        run: Arc::new(move |args| {
            if !enabled() {
                return Box::pin(async {
                    Err("The browser tools are off in Settings > Browser".into())
                });
            }
            run(app.clone(), args)
        }),
    }
}

fn enabled() -> bool {
    let settings = super::settings();
    settings.features.browser && settings.browser.agents
}

fn tab(args: &Value) -> Result<String, String> {
    let tab = args["tab"].as_str().unwrap_or_default();
    if panes().contains_key(tab) {
        Ok(tab.into())
    } else {
        Err(format!("No tab {tab}; browser_tabs lists the open ones"))
    }
}

fn reference(args: &Value) -> Result<u64, String> {
    args["ref"]
        .as_u64()
        .ok_or_else(|| "ref is required".to_string())
}

fn describe(pane: &str) -> String {
    state(pane).map_or_else(
        |error| error,
        |state| {
            let title = if state.title.is_empty() {
                "(untitled)"
            } else {
                &state.title
            };
            match state.error {
                Some(error) => format!("{title} | {} | {error}", state.url),
                None => format!("{title} | {}", state.url),
            }
        },
    )
}

/// The script's answer to `js`, run in the page
async fn eval(pane: &str, js: String) -> Result<Value, String> {
    let webview = webview(pane)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    webview
        .eval_with_callback(js, move |json| {
            if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                let _ = tx.send(json);
            }
        })
        .map_err(|e| e.to_string())?;
    let json = tokio::time::timeout(ANSWER, rx)
        .await
        .map_err(|_| "The page did not answer".to_string())?
        .map_err(|_| "The page did not answer".to_string())?;
    Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
}

/// `window.__treeix.<call>`, or an error when the page has no script (a page that failed to load, about:blank)
async fn call(pane: &str, call: String) -> Result<Value, String> {
    let result = eval(
        pane,
        format!("window.__treeix ? window.__treeix.{call} : '__missing'"),
    )
    .await?;
    if result == "__missing" {
        return Err(format!("The page can't be driven yet: {}", describe(pane)));
    }
    Ok(result)
}

/// Waits a moment for what the action started, then until the page stops loading
async fn settled(pane: &str) {
    tokio::time::sleep(Duration::from_millis(250)).await;
    let deadline = tokio::time::Instant::now() + SETTLE;
    while state(pane).is_ok_and(|state| state.loading) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn clip(text: String) -> String {
    match text.char_indices().nth(OUTPUT_LIMIT) {
        Some((at, _)) => format!("{}\n(cut)", &text[..at]),
        None => text,
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

async fn navigate(app: AppHandle, args: Value) -> Result<String, String> {
    let url = args["url"].as_str().unwrap_or_default().to_string();
    let action = args["action"].as_str().unwrap_or_default().to_string();
    if args["tab"].is_null() {
        if url.is_empty() {
            return Err("url is required for a new tab".into());
        }
        let pane = format!("agent{:08x}", rand_id());
        let opened = pane.clone();
        let state = blocking(move || {
            super::open(&app.clone(), &opened, &url).inspect(|state| {
                emit(
                    &app,
                    BrowserEvent::Opened {
                        state: state.clone(),
                    },
                );
            })
        })
        .await?;
        settled(&state.pane).await;
        return Ok(format!("Opened tab {pane}: {}", describe(&pane)));
    }
    let pane = tab(&args)?;
    let nav = match action.as_str() {
        "back" => Some(BrowserNav::Back),
        "forward" => Some(BrowserNav::Forward),
        "reload" => Some(BrowserNav::Reload),
        "" => None,
        other => return Err(format!("{other} is not back, forward or reload")),
    };
    let target = pane.clone();
    blocking(move || match nav {
        Some(nav) => super::go(&app, &target, nav),
        None if url.is_empty() => Err("url or action is required".into()),
        None => super::navigate(&app, &target, &url),
    })
    .await?;
    settled(&pane).await;
    Ok(describe(&pane))
}

/// Enough to tell agent tabs apart; not a secret
fn rand_id() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.subsec_nanos())
}

async fn click(args: Value) -> Result<String, String> {
    let pane = tab(&args)?;
    let id = reference(&args)?;
    let double = args["double"].as_bool().unwrap_or(false);
    match call(&pane, format!("click({id}, {double})"))
        .await?
        .as_str()
    {
        Some("done") => {
            settled(&pane).await;
            Ok(format!("Clicked. {}", describe(&pane)))
        }
        _ => Err(format!("Ref {id} is gone; take a new browser_snapshot")),
    }
}

async fn type_text(args: Value) -> Result<String, String> {
    let pane = tab(&args)?;
    let id = reference(&args)?;
    let text = serde_json::to_string(args["text"].as_str().unwrap_or_default())
        .map_err(|e| e.to_string())?;
    match call(&pane, format!("fill({id}, {text})")).await?.as_str() {
        Some("done") => {}
        Some("no-option") => return Err(format!("Ref {id} has no option {text}")),
        Some("not-a-field") => {
            return Err(format!(
                "Ref {id} is not a field; take a new browser_snapshot"
            ));
        }
        _ => return Err(format!("Ref {id} is gone; take a new browser_snapshot")),
    }
    if args["submit"].as_bool().unwrap_or(false) {
        call(&pane, "press('Enter')".into()).await?;
        settled(&pane).await;
    }
    Ok(format!("Typed. {}", describe(&pane)))
}

fn console(args: &Value) -> Result<String, String> {
    let pane = tab(args)?;
    let limit = args["limit"].as_u64().unwrap_or(50) as usize;
    let panes = panes();
    let lines: Vec<String> = panes
        .get(&pane)
        .map(|open| {
            open.entries
                .iter()
                .filter_map(|entry| match entry {
                    BrowserEntry::Console {
                        level,
                        text,
                        source,
                        ..
                    } if source.is_empty() => Some(format!("[{level:?}] {text}")),
                    BrowserEntry::Console {
                        level,
                        text,
                        source,
                        ..
                    } => Some(format!("[{level:?}] {text} ({source})")),
                    BrowserEntry::Network { .. } => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let newest = &lines[lines.len().saturating_sub(limit)..];
    Ok(if newest.is_empty() {
        "Nothing logged".into()
    } else {
        clip(newest.join("\n"))
    })
}

#[cfg(target_os = "macos")]
async fn screenshot(args: Value) -> Result<String, String> {
    let pane = tab(&args)?;
    let webview = webview(&pane)?;
    let png = blocking(move || capture::png(&webview)).await?;
    let path = std::env::temp_dir().join(format!("treeix-browser-{pane}-{}.png", rand_id()));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(format!(
        "Saved a screenshot of {} to {}; read that file to see it",
        describe(&pane),
        path.display()
    ))
}

#[cfg(not(target_os = "macos"))]
async fn screenshot(args: Value) -> Result<String, String> {
    tab(&args)?;
    Err("Screenshots are macOS only for now; browser_snapshot reads the page".into())
}

/// MCP tools for agents (browser_tabs, browser_navigate, browser_snapshot, browser_click, browser_type,
/// browser_screenshot, browser_console); empty while the browser feature or settings.browser.agents is off
pub fn tools(app: &AppHandle) -> Vec<McpTool> {
    if !enabled() {
        return Vec::new();
    }
    let tab_arg =
        json!({ "type": "string", "description": "Tab id from browser_navigate or browser_tabs" });
    let ref_arg = json!({ "type": "number", "description": "Element ref from browser_snapshot" });
    vec![
        tool(
            "browser_tabs",
            "Lists the tabs open in Treeix's browser panes: id, title and address.",
            json!({}),
            &[],
            |_, _| {
                Box::pin(async {
                    let ids: Vec<String> = panes().keys().cloned().collect();
                    let lines: Vec<String> = ids
                        .iter()
                        .map(|id| format!("{id}  {}", describe(id)))
                        .collect();
                    Ok(if lines.is_empty() {
                        "No tabs are open".into()
                    } else {
                        lines.join("\n")
                    })
                })
            },
            app,
        ),
        tool(
            "browser_navigate",
            "Loads an address in a tab, or in a new browser pane when no tab is given, and waits for the page. Returns the tab id the other browser tools take.",
            json!({
                "tab": tab_arg,
                "url": { "type": "string", "description": "http or https; a bare host like localhost:3000 gets http://" },
                "action": { "type": "string", "enum": ["back", "forward", "reload"] },
            }),
            &[],
            |app, args| Box::pin(navigate(app, args)),
            app,
        ),
        tool(
            "browser_snapshot",
            "The page's accessibility tree as text: roles, names, values and states, with refs for browser_click and browser_type. Cheaper and more exact than a screenshot.",
            json!({ "tab": tab_arg }),
            &["tab"],
            |_, args| {
                Box::pin(async move {
                    let pane = tab(&args)?;
                    let snapshot = call(&pane, "snapshot()".into()).await?;
                    Ok(clip(snapshot.as_str().unwrap_or_default().to_string()))
                })
            },
            app,
        ),
        tool(
            "browser_click",
            "Clicks an element by its ref from browser_snapshot.",
            json!({ "tab": tab_arg, "ref": ref_arg, "double": { "type": "boolean", "description": "Double click" } }),
            &["tab", "ref"],
            |_, args| Box::pin(click(args)),
            app,
        ),
        tool(
            "browser_type",
            "Replaces the text of a field by its ref, or picks an option of a select by its value or label. submit presses Enter after.",
            json!({ "tab": tab_arg, "ref": ref_arg, "text": { "type": "string" }, "submit": { "type": "boolean" } }),
            &["tab", "ref", "text"],
            |_, args| Box::pin(type_text(args)),
            app,
        ),
        tool(
            "browser_screenshot",
            "Saves a PNG of what the tab shows and returns its path; read the file to see it.",
            json!({ "tab": tab_arg }),
            &["tab"],
            |_, args| Box::pin(screenshot(args)),
            app,
        ),
        tool(
            "browser_console",
            "Console messages and uncaught errors of the page since it last loaded, newest last.",
            json!({ "tab": tab_arg, "limit": { "type": "number", "description": "How many of the newest to return, 50 by default" } }),
            &["tab"],
            |_, args| Box::pin(async move { console(&args) }),
            app,
        ),
    ]
}

#[cfg(target_os = "macos")]
mod capture {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{CStr, c_void};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Webview;

    /// NSBitmapImageFileTypePNG
    const PNG: usize = 4;

    /// What the WKWebView shows, as PNG; call off the main thread, which WebKit answers on
    pub fn png(webview: &Webview) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        webview
            .with_webview(move |platform| {
                let view = platform.inner().cast::<AnyObject>();
                let done = RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
                    // SAFETY: WebKit hands an NSImage or nil
                    let _ = tx.send(unsafe { encode(image) });
                });
                // SAFETY: `inner` is the pane's live WKWebView; a nil configuration snapshots the visible bounds
                unsafe {
                    let _: () = msg_send![
                        view,
                        takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(),
                        completionHandler: &*done
                    ];
                }
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .ok()
            .flatten()
            .ok_or_else(|| "The tab is not on screen, so there is nothing to capture".into())
    }

    /// NSImage to PNG bytes through its TIFF and a bitmap rep
    unsafe fn encode(image: *mut AnyObject) -> Option<Vec<u8>> {
        if image.is_null() {
            return None;
        }
        let class = |name: &CStr| AnyClass::get(name);
        // SAFETY: plain AppKit and Foundation messages on objects checked for nil
        unsafe {
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                return None;
            }
            let rep: *mut AnyObject =
                msg_send![class(c"NSBitmapImageRep")?, imageRepWithData: tiff];
            let properties: *mut AnyObject = msg_send![class(c"NSDictionary")?, dictionary];
            if rep.is_null() {
                return None;
            }
            let data: *mut AnyObject =
                msg_send![rep, representationUsingType: PNG, properties: properties];
            if data.is_null() {
                return None;
            }
            let length: usize = msg_send![data, length];
            let bytes: *const c_void = msg_send![data, bytes];
            (!bytes.is_null())
                .then(|| std::slice::from_raw_parts(bytes.cast::<u8>(), length).to_vec())
        }
    }
}
