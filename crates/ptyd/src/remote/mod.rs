//! The phone page: HTTP on `<data dir>/remote.sock`, which `tailscale serve` puts on the tailnet (core tailscale.rs).
//! It answers only the Tailscale login in settings.phone.owner, and its changes go through the app's request handler

use crate::server::{ClientId, Daemon};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::sync::mpsc::unbounded_channel;
use treeix_proto::chat::ChatContent;
use treeix_proto::{Request as DaemonRequest, Response as DaemonResponse, ServerMsg};

/// Never registered as a client, so the phone does not count as an open app
const PHONE: ClientId = 0;
const SCREEN_HISTORY: usize = 300;
const CHAT_ENTRIES: usize = 2000;
const RUNS: u32 = 30;
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
                   connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

type Shared = State<Arc<Daemon>>;
type Reply = Result<Response, (StatusCode, String)>;

/// Serves until the daemon exits; a failed bind only logs, the terminals don't depend on it
pub fn listen(daemon: &Arc<Daemon>) {
    let path = treeix_core::tailscale::socket(&daemon.data_dir);
    let _ = fs::remove_file(&path);
    let listener = match UnixListener::bind(&path)
        .and_then(|l| fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map(|()| l))
    {
        Ok(listener) => listener,
        Err(e) => {
            tracing::warn!("phone page {}: {e}", path.display());
            return;
        }
    };
    let app = router(daemon.clone());
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::warn!("phone page: {e}");
        }
    });
}

fn router(daemon: Arc<Daemon>) -> Router {
    Router::new()
        .route(
            "/",
            get(|| file("text/html", include_str!("web/index.html"))),
        )
        .route(
            "/app.js",
            get(|| file("text/javascript", include_str!("web/app.js"))),
        )
        .route(
            "/app.css",
            get(|| file("text/css", include_str!("web/app.css"))),
        )
        .route("/api/state", get(state))
        .route("/api/sessions/{id}/screen", get(screen))
        .route("/api/sessions/{id}/input", post(input))
        .route("/api/chats/{id}/log", get(chat_log))
        .route("/api/chats/{id}/prompt", post(prompt))
        .route("/api/chats/{id}/answer", post(answer))
        .route("/api/chats/{id}/cancel", post(cancel))
        .route("/api/routines/{id}/run", post(run_now))
        .route("/api/routines/{id}/enabled", post(set_enabled))
        .route("/api/runs/{id}/cancel", post(cancel_run))
        .layer(middleware::from_fn_with_state(daemon.clone(), guard))
        .with_state(daemon)
}

async fn file(kind: &'static str, body: &'static str) -> Response {
    (
        [(header::CONTENT_TYPE, format!("{kind}; charset=utf-8"))],
        body,
    )
        .into_response()
}

/// Checks every request against the settings of the moment, so turning the page off takes effect at once
async fn guard(State(daemon): Shared, req: Request, next: Next) -> Response {
    let owner = treeix_core::settings::load(&daemon.data_dir).phone.owner;
    let mut res = match allowed(
        req.method(),
        req.uri().path(),
        req.headers(),
        owner.as_deref(),
    ) {
        Ok(()) => next.run(req).await,
        Err(why) => (StatusCode::FORBIDDEN, why).into_response(),
    };
    let headers = res.headers_mut();
    for (name, value) in [
        (header::CONTENT_SECURITY_POLICY, CSP),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CACHE_CONTROL, "no-store"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    res
}

/// Tailscale serve sets `Tailscale-User-Login` for tailnet users and drops any the client sent. The page drives
/// terminals, so other sites must not: API calls are same-origin, and changes are JSON (a cross-site form can't send it)
fn allowed(
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    owner: Option<&str>,
) -> Result<(), &'static str> {
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let owner = owner.ok_or("The phone page is off. Turn it on in Treeix, Settings, Phone")?;
    if headers.contains_key("tailscale-funnel-request") {
        return Err("Not over Funnel");
    }
    if text("tailscale-user-login") != Some(owner) {
        return Err("Only the Tailscale account signed in on the Mac can open this");
    }
    if path.starts_with("/api/") && text("sec-fetch-site").is_some_and(|site| site != "same-origin")
    {
        return Err("Cross-site request");
    }
    if method != Method::GET
        && !text("content-type").is_some_and(|t| t.starts_with("application/json"))
    {
        return Err("Changes must be JSON");
    }
    Ok(())
}

/// One request through the app's handler, on a one-shot outbox
async fn call(
    daemon: &Arc<Daemon>,
    req: DaemonRequest,
) -> Result<DaemonResponse, (StatusCode, String)> {
    let (outbox, mut rx) = unbounded_channel();
    daemon.handle(PHONE, &outbox, 0, req);
    drop(outbox);
    while let Some(msg) = rx.recv().await {
        if let ServerMsg::Resp { resp, .. } = msg {
            return resp.map_err(|e| (StatusCode::BAD_REQUEST, e));
        }
    }
    Err((StatusCode::INTERNAL_SERVER_ERROR, "No reply".into()))
}

async fn done(daemon: &Arc<Daemon>, req: DaemonRequest) -> Reply {
    call(daemon, req).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn not_found(e: String) -> (StatusCode, String) {
    (StatusCode::NOT_FOUND, e)
}

async fn state(State(daemon): Shared) -> Json<serde_json::Value> {
    let mut sessions: Vec<_> = daemon.sessions().iter().map(|s| s.info()).collect();
    sessions.sort_by_key(|s| s.created_at);
    Json(json!({
        "sessions": sessions,
        "chats": daemon.chats.list(),
        "routines": daemon.routines.list(),
        "runs": daemon.routines.runs(None, RUNS),
    }))
}

#[derive(Deserialize)]
struct Seq {
    seq: Option<u64>,
}

/// `lines` only when the output moved past `seq`
async fn screen(State(daemon): Shared, Path(id): Path<String>, Query(since): Query<Seq>) -> Reply {
    let session = daemon.session(&id).map_err(not_found)?;
    let info = session.info();
    if since.seq == Some(info.seq) {
        return Ok(Json(json!({ "info": info })).into_response());
    }
    let (seq, cols, lines) = session.view(SCREEN_HISTORY);
    Ok(Json(json!({ "info": info, "seq": seq, "cols": cols, "lines": lines })).into_response())
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

async fn input(
    State(daemon): Shared,
    Path(session): Path<String>,
    Json(input): Json<Text>,
) -> Reply {
    let data = input.text.into_bytes();
    done(&daemon, DaemonRequest::Write { session, data }).await
}

#[derive(Deserialize)]
struct From {
    #[serde(default)]
    from: u64,
}

async fn chat_log(
    State(daemon): Shared,
    Path(id): Path<String>,
    Query(from): Query<From>,
) -> Reply {
    let chat = daemon.chats.get(&id).map_err(not_found)?;
    let (info, entries) = chat.since(from.from, CHAT_ENTRIES);
    Ok(Json(json!({ "info": info, "entries": entries })).into_response())
}

async fn prompt(
    State(daemon): Shared,
    Path(chat): Path<String>,
    Json(prompt): Json<Text>,
) -> Reply {
    let content = vec![ChatContent::Text { text: prompt.text }];
    done(&daemon, DaemonRequest::ChatPrompt { chat, content }).await
}

#[derive(Deserialize)]
struct Answer {
    request: String,
    option: Option<String>,
}

async fn answer(
    State(daemon): Shared,
    Path(chat): Path<String>,
    Json(answer): Json<Answer>,
) -> Reply {
    let Answer { request, option } = answer;
    done(
        &daemon,
        DaemonRequest::ChatAnswer {
            chat,
            request,
            option,
        },
    )
    .await
}

async fn cancel(State(daemon): Shared, Path(chat): Path<String>) -> Reply {
    done(&daemon, DaemonRequest::ChatCancel { chat }).await
}

async fn run_now(State(daemon): Shared, Path(routine): Path<String>) -> Reply {
    done(&daemon, DaemonRequest::RoutineRunNow { routine }).await
}

#[derive(Deserialize)]
struct Enabled {
    enabled: bool,
}

async fn set_enabled(
    State(daemon): Shared,
    Path(id): Path<String>,
    Json(to): Json<Enabled>,
) -> Reply {
    let mut routine = daemon
        .routines
        .list()
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| not_found(format!("no routine {id}")))?;
    routine.enabled = to.enabled;
    done(&daemon, DaemonRequest::RoutinePut { routine }).await
}

async fn cancel_run(State(daemon): Shared, Path(run): Path<String>) -> Reply {
    done(&daemon, DaemonRequest::RunCancel { run }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: Option<&str> = Some("me@example.com");

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        pairs
            .iter()
            .map(|(k, v)| {
                (
                    header::HeaderName::from_static(k),
                    HeaderValue::from_static(v),
                )
            })
            .collect()
    }

    fn me(extra: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = headers(&[("tailscale-user-login", "me@example.com")]);
        h.extend(headers(extra));
        h
    }

    #[test]
    fn only_the_owner_over_the_tailnet_gets_in() {
        let get = &Method::GET;
        assert!(allowed(get, "/", &me(&[]), OWNER).is_ok());
        assert!(allowed(get, "/", &me(&[]), None).is_err(), "off");
        assert!(
            allowed(get, "/", &headers(&[]), OWNER).is_err(),
            "no identity"
        );
        let other = headers(&[("tailscale-user-login", "you@example.com")]);
        assert!(allowed(get, "/", &other, OWNER).is_err(), "someone else");
        let funnel = me(&[("tailscale-funnel-request", "?1")]);
        assert!(allowed(get, "/", &funnel, OWNER).is_err(), "funnel");
    }

    #[test]
    fn other_sites_cannot_drive_it() {
        let post = &Method::POST;
        let path = "/api/sessions/s1/input";
        let json = me(&[
            ("content-type", "application/json"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(allowed(post, path, &json, OWNER).is_ok());
        let form = me(&[
            ("content-type", "text/plain"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(allowed(post, path, &form, OWNER).is_err(), "not JSON");
        let cross = me(&[
            ("content-type", "application/json"),
            ("sec-fetch-site", "cross-site"),
        ]);
        assert!(allowed(post, path, &cross, OWNER).is_err(), "cross-site");
        let read = me(&[("sec-fetch-site", "same-site")]);
        assert!(
            allowed(&Method::GET, "/api/state", &read, OWNER).is_err(),
            "another tailnet site"
        );
        let link = me(&[("sec-fetch-site", "cross-site")]);
        assert!(
            allowed(&Method::GET, "/", &link, OWNER).is_ok(),
            "opened from a link"
        );
    }
}
