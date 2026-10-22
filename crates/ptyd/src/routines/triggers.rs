//! Event and webhook triggers. Events: `gh api` with `If-None-Match` every 60 s (review requests, failed
//! checks, PR comments on the user's PRs) and `acli` (tickets newly assigned), each hit fired once per routine.
//! Webhooks: `POST http://127.0.0.1:<WEBHOOK_PORT>/r/<token>`. Owner: R6

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use treeix_proto::routines::{Routine, RoutineEvent, RoutineId, RunCause, Trigger};

/// Something that fires a routine, with the prompt's `{variables}`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    pub routine: RoutineId,
    pub cause: RunCause,
    /// `RoutineRun.detail`
    pub detail: Option<String>,
    pub vars: BTreeMap<String, String>,
    /// Local checkout the hit is about, for `repo: None` routines and `RoutinePlace::PrWorktree`
    pub repo: Option<String>,
    /// PR number for PR events
    pub pr: Option<u64>,
}

/// One event a poll found
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// Fires once, like `review:owner/repo#12`
    pub key: String,
    pub event: RoutineEvent,
    /// `owner/repo` for PR events
    pub slug: Option<String>,
    pub pr: Option<u64>,
    pub detail: String,
    pub vars: BTreeMap<String, String>,
}

/// gh / acli state between polls; `seen` and `primed` are saved, so a restart does not fire old events again
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Poller {
    /// Endpoint to its last ETag and body, so a 304 answers from here
    #[serde(skip)]
    pub etags: HashMap<String, (String, Value)>,
    /// Events already fired, like `review:owner/repo#12`; the first poll of a kind only fills this
    // ponytail: one key per event ever seen, never pruned; drop keys older than a month if state.json gets big
    pub seen: HashSet<String>,
    /// Kinds polled since a routine wanted them; one nobody wants is dropped, so turning it on later does not fire
    /// everything that happened meanwhile
    pub primed: HashSet<String>,
    #[serde(skip)]
    login: Option<String>,
    /// Checkout to its `owner/repo`
    #[serde(skip)]
    slugs: HashMap<String, Option<String>>,
}

fn kind(event: RoutineEvent) -> &'static str {
    match event {
        RoutineEvent::ReviewRequested => "review",
        RoutineEvent::CiFailed => "ci",
        RoutineEvent::PrComment => "comment",
        RoutineEvent::TicketAssigned => "ticket",
    }
}

const EVENTS: [RoutineEvent; 4] = [
    RoutineEvent::ReviewRequested,
    RoutineEvent::CiFailed,
    RoutineEvent::PrComment,
    RoutineEvent::TicketAssigned,
];

fn wanted(routines: &[Routine], event: RoutineEvent) -> bool {
    routines
        .iter()
        .any(|r| r.enabled && r.trigger == Trigger::Event { event })
}

impl Poller {
    /// One round for the enabled event routines; blocking (gh, acli, git). `checkouts` are the repos a
    /// `repo: None` routine's PR event may run in
    pub fn poll(&mut self, routines: &[Routine], checkouts: &[String]) -> Vec<Hit> {
        let mut found = Vec::new();
        for event in EVENTS {
            if !wanted(routines, event) {
                self.primed.remove(kind(event));
                continue;
            }
            match self.fetch(event) {
                Ok(events) => found.extend(self.fresh(event, events)),
                Err(e) => tracing::info!("routine {} poll: {e}", kind(event)),
            }
        }
        found
            .into_iter()
            .flat_map(|found| self.hits(routines, checkouts, &found))
            .collect()
    }

    /// Events not fired before; all of them are seen from now on. The first round of a kind fires nothing
    pub fn fresh(&mut self, event: RoutineEvent, found: Vec<Found>) -> Vec<Found> {
        let primed = !self.primed.insert(kind(event).to_owned());
        found
            .into_iter()
            .filter(|f| self.seen.insert(f.key.clone()) && primed)
            .collect()
    }

    /// A hit for each enabled routine the event is for: its repo, or any checkout of the event's repo
    pub fn hits(&mut self, routines: &[Routine], checkouts: &[String], found: &Found) -> Vec<Hit> {
        let mut hits = Vec::new();
        for routine in routines {
            if !routine.enabled || routine.trigger != (Trigger::Event { event: found.event }) {
                continue;
            }
            let repo = match (&found.slug, &routine.repo) {
                (Some(slug), Some(repo)) if self.slug_of(repo).as_ref() == Some(slug) => {
                    Some(repo.clone())
                }
                (Some(_), Some(_)) => continue,
                (Some(slug), None) => {
                    let checkout = checkouts
                        .iter()
                        .find(|c| self.slug_of(c).as_ref() == Some(slug))
                        .cloned();
                    if checkout.is_none() {
                        tracing::info!("routine {}: no checkout of {slug}", routine.name);
                        continue;
                    }
                    checkout
                }
                (None, repo) => repo.clone(),
            };
            hits.push(Hit {
                routine: routine.id.clone(),
                cause: RunCause::Event,
                detail: Some(found.detail.clone()),
                vars: found.vars.clone(),
                repo,
                pr: found.pr,
            });
        }
        hits
    }

    fn slug_of(&mut self, checkout: &str) -> Option<String> {
        self.slugs
            .entry(checkout.to_owned())
            .or_insert_with(|| {
                let out = Command::new("git")
                    .args([
                        "--no-optional-locks",
                        "-C",
                        checkout,
                        "remote",
                        "get-url",
                        "origin",
                    ])
                    .stdin(Stdio::null())
                    .output()
                    .ok()?;
                let url = String::from_utf8_lossy(&out.stdout);
                treeix_core::prs::parse_remote(&url).map(|r| r.slug)
            })
            .clone()
    }

    fn fetch(&mut self, event: RoutineEvent) -> Result<Vec<Found>, String> {
        match event {
            RoutineEvent::ReviewRequested => {
                let search =
                    self.gh("search/issues?q=is:pr+is:open+review-requested:@me&per_page=50")?;
                Ok(review_requests(&search))
            }
            RoutineEvent::CiFailed => {
                let mut found = Vec::new();
                for pr in self.my_prs()? {
                    let detail = self.gh(&format!("repos/{}/pulls/{}", pr.slug, pr.number))?;
                    let head =
                        |key: &str| detail["head"][key].as_str().unwrap_or_default().to_owned();
                    let (sha, branch) = (head("sha"), head("ref"));
                    if sha.is_empty() {
                        continue;
                    }
                    let runs = self.gh(&format!(
                        "repos/{}/commits/{sha}/check-runs?per_page=100",
                        pr.slug
                    ))?;
                    found.extend(failed_checks(&pr, &sha, &branch, &runs));
                }
                Ok(found)
            }
            RoutineEvent::PrComment => {
                let me = self.login()?;
                let mut found = Vec::new();
                for pr in self.my_prs()?.into_iter().filter(|pr| pr.comments > 0) {
                    let comments = self.gh(&format!(
                        "repos/{}/issues/{}/comments?per_page=100",
                        pr.slug, pr.number
                    ))?;
                    found.extend(new_comments(&pr, &me, &comments));
                }
                Ok(found)
            }
            RoutineEvent::TicketAssigned => {
                let jql =
                    "assignee = currentUser() AND statusCategory != Done ORDER BY created DESC";
                let tickets = treeix_core::tickets::acli::search(jql)?;
                Ok(tickets
                    .into_iter()
                    .map(|t| Found {
                        key: format!("ticket:{}", t.key),
                        event,
                        slug: None,
                        pr: None,
                        detail: format!("{} {}", t.key, t.title),
                        vars: BTreeMap::from([
                            ("ticket".into(), t.key.clone()),
                            ("title".into(), t.title),
                            // Filled for fresh tickets only (`describe`), one acli call each
                            ("desc".into(), String::new()),
                        ]),
                    })
                    .collect())
            }
        }
    }

    fn my_prs(&mut self) -> Result<Vec<Pr>, String> {
        let search = self.gh("search/issues?q=is:pr+is:open+author:@me&per_page=50")?;
        Ok(prs(&search))
    }

    fn login(&mut self) -> Result<String, String> {
        if let Some(login) = &self.login {
            return Ok(login.clone());
        }
        let user = self.gh("user")?;
        let login = user["login"].as_str().ok_or("gh: no login")?.to_owned();
        self.login = Some(login.clone());
        Ok(login)
    }

    /// `gh api -i` with the endpoint's last ETag; a 304 (free against the rate limit) answers the cached body
    fn gh(&mut self, endpoint: &str) -> Result<Value, String> {
        let mut cmd = Command::new("gh");
        cmd.args(["api", "-i"]);
        if let Some((etag, _)) = self.etags.get(endpoint) {
            cmd.args(["-H", &format!("If-None-Match: {etag}")]);
        }
        let out = cmd
            .arg(endpoint)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("gh: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let Some(reply) = parse_http(&stdout) else {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
        };
        match reply.status {
            304 => self
                .etags
                .get(endpoint)
                .map(|(_, body)| body.clone())
                .ok_or_else(|| "gh: 304 without a cached reply".into()),
            200 => {
                let body: Value = serde_json::from_str(reply.body).map_err(|e| e.to_string())?;
                if let Some(etag) = reply.etag {
                    self.etags
                        .insert(endpoint.to_owned(), (etag.to_owned(), body.clone()));
                }
                Ok(body)
            }
            status => Err(format!("gh api {endpoint}: HTTP {status}")),
        }
    }

    /// Ticket descriptions for the prompt's `{desc}`, read only for tickets that fire
    pub fn describe(hits: &mut [Hit]) {
        for hit in hits {
            let Some(key) = hit
                .vars
                .get("ticket")
                .filter(|_| hit.vars.contains_key("desc"))
            else {
                continue;
            };
            match treeix_core::tickets::acli::detail(key) {
                Ok(detail) => {
                    hit.vars.insert("desc".into(), detail.description);
                }
                Err(e) => tracing::info!("ticket {key}: {e}"),
            }
        }
    }

    pub fn load(dir: &Path) -> Self {
        std::fs::read(dir.join("poller.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) {
        if let Err(e) = serde_json::to_vec(self)
            .map_err(|e| e.to_string())
            .and_then(|json| super::write_atomic(&dir.join("poller.json"), &json))
        {
            tracing::warn!("saving poller.json: {e}");
        }
    }
}

struct HttpReply<'a> {
    status: u16,
    etag: Option<&'a str>,
    body: &'a str,
}

/// `gh api -i` output: the status line, headers, a blank line, the body
fn parse_http(text: &str) -> Option<HttpReply<'_>> {
    let (head, body) = text
        .split_once("\r\n\r\n")
        .or_else(|| text.split_once("\n\n"))?;
    let mut lines = head.lines();
    let status = lines
        .next()?
        .strip_prefix("HTTP/")?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    let etag = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("etag").then(|| value.trim())
    });
    Some(HttpReply { status, etag, body })
}

/// One of the user's open PRs from the search API
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pr {
    pub slug: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    pub comments: u64,
}

fn prs(search: &Value) -> Vec<Pr> {
    search["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let slug = item["repository_url"]
                .as_str()?
                .split("/repos/")
                .nth(1)?
                .to_owned();
            Some(Pr {
                slug,
                number: item["number"].as_u64()?,
                title: item["title"].as_str().unwrap_or_default().to_owned(),
                author: item["user"]["login"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                comments: item["comments"].as_u64().unwrap_or(0),
            })
        })
        .collect()
}

fn pr_found(pr: &Pr, key: String, event: RoutineEvent, detail: String) -> Found {
    Found {
        key,
        event,
        slug: Some(pr.slug.clone()),
        pr: Some(pr.number),
        detail,
        vars: BTreeMap::from([
            ("pr".into(), pr.number.to_string()),
            ("title".into(), pr.title.clone()),
            ("author".into(), pr.author.clone()),
        ]),
    }
}

pub fn review_requests(search: &Value) -> Vec<Found> {
    prs(search)
        .iter()
        .map(|pr| {
            let detail = format!("#{} {} ({})", pr.number, pr.title, pr.author);
            let key = format!("review:{}#{}", pr.slug, pr.number);
            pr_found(pr, key, RoutineEvent::ReviewRequested, detail)
        })
        .collect()
}

/// One event per failed head commit, naming every failed job
pub fn failed_checks(pr: &Pr, sha: &str, branch: &str, runs: &Value) -> Vec<Found> {
    let failed: Vec<&str> = runs["check_runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|run| {
            matches!(
                run["conclusion"].as_str(),
                Some("failure" | "timed_out" | "startup_failure")
            )
        })
        .filter_map(|run| run["name"].as_str())
        .collect();
    if failed.is_empty() {
        return vec![];
    }
    let job = failed.join(", ");
    let detail = format!("#{} {}: {job}", pr.number, pr.title);
    let mut found = pr_found(
        pr,
        format!("ci:{}#{}@{sha}", pr.slug, pr.number),
        RoutineEvent::CiFailed,
        detail,
    );
    found.vars.insert("branch".into(), branch.to_owned());
    found.vars.insert("job".into(), job);
    vec![found]
}

/// Comments by anyone but the user
pub fn new_comments(pr: &Pr, me: &str, comments: &Value) -> Vec<Found> {
    comments
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|comment| {
            let author = comment["user"]["login"].as_str()?;
            if author == me {
                return None;
            }
            let body = comment["body"].as_str().unwrap_or_default();
            let detail = format!("#{} {} ({author})", pr.number, pr.title);
            let mut found = pr_found(
                pr,
                format!("comment:{}#{}", pr.slug, comment["id"].as_u64()?),
                RoutineEvent::PrComment,
                detail,
            );
            found.vars.insert("author".into(), author.to_owned());
            found.vars.insert("comment".into(), body.to_owned());
            found.vars.insert("body".into(), body.to_owned());
            Some(found)
        })
        .collect()
}

/// The prompt with `{name}` replaced from `vars`; unknown names stay as written
pub fn render(prompt: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut rest = prompt;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after
            .find('}')
            .and_then(|close| Some((close, vars.get(&after[..close])?)))
        {
            Some((close, value)) => {
                out.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Webhook bodies past this are refused
const MAX_BODY: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Compares every byte whatever the first difference, so the time does not tell how much of a token was right
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The enabled webhook routine with this token; every routine is compared, in constant time
pub fn by_token<'a>(routines: &'a [Routine], token: &str) -> Option<&'a Routine> {
    let mut found = None;
    for routine in routines {
        if let Trigger::Webhook { token: own } = &routine.trigger
            && same(own.as_bytes(), token.as_bytes())
            && !own.is_empty()
            && routine.enabled
        {
            found = Some(routine);
        }
    }
    found
}

/// What a webhook POST asks for: `Ok((token, body))` or the HTTP status to refuse it with
async fn read_request(stream: &mut TcpStream) -> Result<(String, String), u16> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, length) = loop {
        let n = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..at]).into_owned();
            let length = head
                .lines()
                .filter_map(|l| l.split_once(':'))
                .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                .map_or(Ok(0), |(_, v)| v.trim().parse::<usize>())
                .map_err(|_| 400u16)?;
            break (at + 4, length);
        }
        if buf.len() > MAX_BODY {
            return Err(431);
        }
    };
    if length > MAX_BODY {
        return Err(413);
    }
    while buf.len() < head_end + length {
        let n = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let mut request = head.lines().next().unwrap_or_default().split_whitespace();
    let (method, path) = (
        request.next().unwrap_or_default(),
        request.next().unwrap_or_default(),
    );
    let path = path.split('?').next().unwrap_or_default();
    let Some(token) = path.strip_prefix("/r/") else {
        return Err(404);
    };
    if method != "POST" {
        return Err(405);
    }
    let body = String::from_utf8_lossy(&buf[head_end..head_end + length]).into_owned();
    Ok((token.to_owned(), body))
}

/// Answers webhook POSTs; `fire(token, body)` queues the run and returns its id, or the status to refuse with
pub async fn serve_webhooks(
    listener: TcpListener,
    fire: impl Fn(&str, String) -> Result<String, u16> + Send + Sync + 'static,
) {
    let fire = std::sync::Arc::new(fire);
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        let fire = fire.clone();
        tokio::spawn(async move {
            let answer = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
                Ok(Ok((token, body))) => fire(&token, body),
                Ok(Err(status)) => Err(status),
                Err(_) => Err(408),
            };
            let (status, body) = match answer {
                Ok(run) => (202, serde_json::json!({ "run": run }).to_string()),
                Err(status) => (
                    status,
                    serde_json::json!({ "error": reason(status) }).to_string(),
                ),
            };
            let reply = format!(
                "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                reason(status),
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        202 => "Accepted",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Bad Request",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routines::schedule::tests::routine;
    use serde_json::json;
    use treeix_proto::routines::WhileAsleep;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn render_fills_known_variables_and_leaves_the_rest() {
        let vars = vars(&[("pr", "412"), ("title", "Fix {login}")]);
        assert_eq!(
            render("Review #{pr} \"{title}\" {unknown} {pr", &vars),
            "Review #412 \"Fix {login}\" {unknown} {pr"
        );
        assert_eq!(render("{}{{pr}}", &vars), "{}{412}");
    }

    fn search() -> Value {
        json!({ "items": [
            { "number": 12, "title": "Fix login", "user": { "login": "octocat" }, "comments": 2,
              "repository_url": "https://api.github.com/repos/acme/web" },
            { "number": 7, "title": "Docs", "user": { "login": "hubot" }, "comments": 0,
              "repository_url": "https://api.github.com/repos/acme/api" }
        ]})
    }

    #[test]
    fn review_requests_read_the_search_api() {
        let found = review_requests(&search());
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].key, "review:acme/web#12");
        assert_eq!(found[0].detail, "#12 Fix login (octocat)");
        assert_eq!(found[0].slug.as_deref(), Some("acme/web"));
        assert_eq!(found[0].vars["author"], "octocat");
    }

    #[test]
    fn a_failed_head_commit_fires_once_naming_its_jobs() {
        let pr = &prs(&search())[0];
        let runs = json!({ "check_runs": [
            { "name": "test", "conclusion": "failure" },
            { "name": "lint", "conclusion": "success" },
            { "name": "e2e", "conclusion": "timed_out" },
            { "name": "build", "conclusion": null }
        ]});
        let found = failed_checks(pr, "abc", "fix-login", &runs);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "ci:acme/web#12@abc");
        assert_eq!(found[0].vars["job"], "test, e2e");
        assert_eq!(found[0].vars["branch"], "fix-login");
        assert!(failed_checks(pr, "abc", "x", &json!({ "check_runs": [] })).is_empty());
    }

    #[test]
    fn the_users_own_comments_do_not_fire() {
        let pr = &prs(&search())[0];
        let comments = json!([
            { "id": 1, "user": { "login": "me" }, "body": "mine" },
            { "id": 2, "user": { "login": "reviewer" }, "body": "nit: rename" }
        ]);
        let found = new_comments(pr, "me", &comments);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "comment:acme/web#2");
        assert_eq!(found[0].vars["comment"], "nit: rename");
        assert_eq!(found[0].vars["author"], "reviewer");
    }

    #[test]
    fn polls_fire_each_event_once_and_never_on_the_first_round() {
        let mut poller = Poller::default();
        let event = RoutineEvent::ReviewRequested;
        let first = review_requests(&search());
        assert!(poller.fresh(event, first.clone()).is_empty());
        assert!(poller.fresh(event, first.clone()).is_empty());
        let mut next = first.clone();
        next[0].key = "review:acme/web#13".into();
        let fresh = poller.fresh(event, next.clone());
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].key, "review:acme/web#13");
        assert!(poller.fresh(event, next).is_empty());

        // Saved and loaded, it remembers
        let dir = tempfile::tempdir().unwrap();
        poller.save(dir.path());
        let mut loaded = Poller::load(dir.path());
        assert!(loaded.fresh(event, first).is_empty());
    }

    #[test]
    fn a_kind_nobody_wants_starts_over_unprimed() {
        let mut poller = Poller::default();
        let event = RoutineEvent::TicketAssigned;
        poller.fresh(event, vec![]);
        assert!(poller.primed.contains("ticket"));
        poller.poll(&[], &[]);
        assert!(poller.primed.is_empty());
    }

    #[test]
    fn hits_go_to_every_matching_routine_with_its_repo() {
        let mut poller = Poller::default();
        let event_routine = |id: &str, event, repo: Option<&str>| {
            let mut r = routine(id, "* * * * *", WhileAsleep::CatchUp);
            r.trigger = Trigger::Event { event };
            r.repo = repo.map(str::to_owned);
            r
        };
        let routines = [
            event_routine("ticket", RoutineEvent::TicketAssigned, Some("/repo")),
            event_routine("review", RoutineEvent::ReviewRequested, None),
            event_routine("ci", RoutineEvent::CiFailed, None),
        ];
        let ticket = Found {
            key: "ticket:ABC-1".into(),
            event: RoutineEvent::TicketAssigned,
            slug: None,
            pr: None,
            detail: "ABC-1 Login".into(),
            vars: vars(&[("ticket", "ABC-1")]),
        };
        let hits = poller.hits(&routines, &[], &ticket);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].routine, "ticket");
        assert_eq!(hits[0].repo.as_deref(), Some("/repo"));
        // A PR event with no checkout of its repo has nowhere to run
        let review = &review_requests(&search())[0];
        assert!(poller.hits(&routines, &[], review).is_empty());
        poller
            .slugs
            .insert("/src/web".into(), Some("acme/web".into()));
        let hits = poller.hits(&routines, &["/src/web".into()], review);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].routine, "review");
        assert_eq!(hits[0].repo.as_deref(), Some("/src/web"));
        assert_eq!(hits[0].pr, Some(12));
    }

    #[test]
    fn gh_replies_parse_with_their_etag() {
        let reply =
            parse_http("HTTP/2.0 200 OK\r\nEtag: W/\"abc\"\r\nX: y\r\n\r\n{\"a\":1}").unwrap();
        assert_eq!(
            (reply.status, reply.etag, reply.body),
            (200, Some("W/\"abc\""), "{\"a\":1}")
        );
        let not_modified = parse_http("HTTP/2.0 304 Not Modified\r\nEtag: x\r\n\r\n").unwrap();
        assert_eq!(not_modified.status, 304);
        assert!(parse_http("gh: not logged in").is_none());
    }

    fn webhook(id: &str, token: &str) -> Routine {
        let mut r = routine(id, "* * * * *", WhileAsleep::CatchUp);
        r.trigger = Trigger::Webhook {
            token: token.into(),
        };
        r
    }

    #[test]
    fn tokens_must_match_exactly() {
        let routines = [
            webhook("a", "aaaa1111"),
            webhook("b", "bbbb2222"),
            webhook("empty", ""),
        ];
        assert_eq!(
            by_token(&routines, "bbbb2222").map(|r| r.id.as_str()),
            Some("b")
        );
        assert!(by_token(&routines, "bbbb222").is_none());
        assert!(by_token(&routines, "bbbb22223").is_none());
        assert!(by_token(&routines, "").is_none());
        let mut off = webhook("off", "cccc3333");
        off.enabled = false;
        assert!(by_token(&[off], "cccc3333").is_none());
    }

    async fn post(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        reply
    }

    #[tokio::test]
    async fn the_webhook_fires_only_with_its_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let routines = vec![webhook("deploy", "s3cret")];
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(serve_webhooks(listener, move |token, body| {
            let routine = by_token(&routines, token).ok_or(404u16)?;
            let _ = tx.send((routine.id.clone(), body));
            Ok("run-1".into())
        }));

        let body = "{\"ref\":\"main\"}";
        let ok = post(
            port,
            &format!(
                "POST /r/s3cret HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(ok.starts_with("HTTP/1.1 202"), "{ok}");
        assert!(ok.ends_with("{\"run\":\"run-1\"}"), "{ok}");
        assert_eq!(rx.recv().await, Some(("deploy".into(), body.into())));

        let wrong = post(port, "POST /r/s3cre7 HTTP/1.1\r\nContent-Length: 0\r\n\r\n").await;
        assert!(wrong.starts_with("HTTP/1.1 404"), "{wrong}");
        let none = post(port, "POST /r/ HTTP/1.1\r\n\r\n").await;
        assert!(none.starts_with("HTTP/1.1 404"), "{none}");
        let get = post(port, "GET /r/s3cret HTTP/1.1\r\n\r\n").await;
        assert!(get.starts_with("HTTP/1.1 405"), "{get}");
        let big = post(
            port,
            "POST /r/s3cret HTTP/1.1\r\nContent-Length: 999999\r\n\r\n",
        )
        .await;
        assert!(big.starts_with("HTTP/1.1 413"), "{big}");
        assert!(rx.try_recv().is_err());
    }
}
