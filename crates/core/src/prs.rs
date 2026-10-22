//! Pull requests through the `gh` and `glab` CLIs. Port of the Electron app's pull-requests plugin.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::process::{Command, Output, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Github,
    Gitlab,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

/// Your relation to an open PR
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Yours,
    Requested,
    Approved,
    Changes,
    Commented,
    Unreviewed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub state: ReviewState,
    /// Commits pushed after your review
    pub new_commits: u32,
    /// Someone else's latest review requests changes
    pub changes_requested: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Passed,
    Failed,
    Running,
    Skipped,
}

/// CI on the head commit: GitHub's checks rolled up, GitLab's pipeline
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    pub status: CheckStatus,
    /// Finished checks of `total`, for "CI 3/5"
    pub done: u32,
    pub total: u32,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub provider: Provider,
    /// Local repo it was listed for
    pub repo_path: String,
    pub number: u32,
    pub title: String,
    pub author: String,
    pub author_avatar_url: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    /// Short sha of the head commit
    pub head: String,
    pub state: PrState,
    pub draft: bool,
    /// RFC 3339
    pub updated_at: String,
    pub url: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    /// None when the provider list leaves it out (GitLab)
    pub changed_files: Option<u32>,
    pub review: Option<Review>,
    /// Open and can't merge cleanly; false while the provider is still computing it
    pub conflicts: bool,
    pub pipeline: Option<Pipeline>,
}

/// One repo that could not be listed (CLI missing, signed out, offline)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrError {
    pub repo_path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestList {
    pub pull_requests: Vec<PullRequest>,
    pub errors: Vec<PrError>,
}

/// Identifies a PR for checks and merge
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub provider: Provider,
    pub repo_path: String,
    pub number: u32,
}

/// One CI check or pipeline job
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

/// Whether a provider's CLI is usable, for the panel footer and the signed-out banner
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: Provider,
    pub installed: bool,
    pub signed_in: bool,
    /// Your login, which "Mine" filters on
    pub user: Option<String>,
}

const LIST_LIMIT: u32 = 50;

/// Where `origin` points, when it is GitHub or a GitLab host
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub provider: Provider,
    pub host: String,
    pub slug: String,
}

/// `git@host:a/b.git`, `https://host/a/b`, `ssh://git@host:2222/a/b.git`; None for other hosts
pub fn parse_remote(url: &str) -> Option<Remote> {
    let mut rest = url.trim();
    if let Some((scheme, after)) = rest.split_once("://")
        && !scheme.is_empty()
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '+')
    {
        rest = after;
    }
    if let Some((user, after)) = rest.split_once('@')
        && !user.is_empty()
        && !user.contains('/')
    {
        rest = after;
    }
    let host_end = rest.find([':', '/'])?;
    let (host, mut rest) = rest.split_at(host_end);
    if let Some(after) = rest.strip_prefix(':') {
        let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits > 0 && after[digits..].starts_with([':', '/']) {
            rest = &after[digits..];
        }
    }
    let slug = rest[1..].trim_end_matches('/');
    let slug = slug.strip_suffix(".git").unwrap_or(slug);
    if host.is_empty() || slug.is_empty() {
        return None;
    }
    let provider = if host == "github.com" {
        Provider::Github
    } else if host.contains("gitlab") {
        Provider::Gitlab
    } else {
        return None;
    };
    Some(Remote {
        provider,
        host: host.into(),
        slug: slug.into(),
    })
}

/// A GUI app started from Finder has a bare PATH, without Homebrew's bin
fn program(name: &str) -> String {
    ["/opt/homebrew/bin", "/usr/local/bin"]
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|path| path.is_file())
        .filter(|_| which(name).is_none())
        .map_or_else(
            || name.to_string(),
            |path| path.to_string_lossy().into_owned(),
        )
}

fn which(name: &str) -> Option<std::path::PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

fn output(command: &str, args: &[&str], cwd: &Path) -> Result<Output, String> {
    // ponytail: no timeout; gh and glab give up on their own network timeouts
    Command::new(program(command))
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| match e.kind() {
            ErrorKind::NotFound => format!("{command} is not installed"),
            _ => format!("{command}: {e}"),
        })
}

/// The first line of stderr says why a CLI failed
fn failure(command: &str, out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = stderr.lines().map(str::trim).find(|line| !line.is_empty());
    line.map_or_else(
        || format!("{command} failed ({})", out.status),
        str::to_owned,
    )
}

fn run(command: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
    let out = output(command, args, cwd)?;
    if !out.status.success() {
        return Err(failure(command, &out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_json(command: &str, args: &[&str], cwd: &Path) -> Result<Value, String> {
    serde_json::from_str(&run(command, args, cwd)?).map_err(|e| format!("{command}: {e}"))
}

fn remote_of(repo_path: &Path) -> Option<Remote> {
    let url = run(
        "git",
        &["--no-optional-locks", "remote", "get-url", "origin"],
        repo_path,
    )
    .ok()?;
    parse_remote(&url)
}

fn require_remote(repo_path: &Path) -> Result<Remote, String> {
    remote_of(repo_path).ok_or_else(|| "Repository has no GitHub or GitLab remote".into())
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn number(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|n| u32::try_from(n).ok())
}

fn nodes(value: &Value) -> &[Value] {
    value["nodes"].as_array().map_or(&[], Vec::as_slice)
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// `gh pr list` has no avatar field; bots come through as `app/<name>` and have no profile image
fn github_avatar(login: &str) -> Option<String> {
    (!login.is_empty() && !login.contains('/'))
        .then(|| format!("https://github.com/{login}.png?size=64"))
}

pub fn to_github_pull_request(raw: &Value, repo_path: &str) -> PullRequest {
    let login = text(&raw["author"]["login"]);
    PullRequest {
        provider: Provider::Github,
        repo_path: repo_path.into(),
        number: number(&raw["number"]).unwrap_or(0),
        title: text(&raw["title"]).into(),
        author: login.into(),
        author_avatar_url: github_avatar(login),
        source_branch: text(&raw["headRefName"]).into(),
        target_branch: text(&raw["baseRefName"]).into(),
        head: short(text(&raw["headRefOid"])),
        state: match text(&raw["state"]) {
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ => PrState::Open,
        },
        draft: raw["isDraft"] == true,
        updated_at: text(&raw["updatedAt"]).into(),
        url: text(&raw["url"]).into(),
        additions: number(&raw["additions"]),
        deletions: number(&raw["deletions"]),
        changed_files: number(&raw["changedFiles"]),
        review: None,
        conflicts: text(&raw["mergeable"]) == "CONFLICTING",
        pipeline: None,
    }
}

pub fn to_gitlab_pull_request(raw: &Value, repo_path: &str) -> PullRequest {
    let state = match text(&raw["state"]) {
        "merged" => PrState::Merged,
        "closed" | "locked" => PrState::Closed,
        _ => PrState::Open,
    };
    let avatar = text(&raw["author"]["avatar_url"]);
    PullRequest {
        provider: Provider::Gitlab,
        repo_path: repo_path.into(),
        number: number(&raw["iid"]).unwrap_or(0),
        title: text(&raw["title"]).into(),
        author: text(&raw["author"]["username"]).into(),
        author_avatar_url: (!avatar.is_empty()).then(|| avatar.into()),
        source_branch: text(&raw["source_branch"]).into(),
        target_branch: text(&raw["target_branch"]).into(),
        head: short(text(&raw["sha"])),
        state,
        draft: raw["draft"] == true,
        updated_at: text(&raw["updated_at"]).into(),
        url: text(&raw["web_url"]).into(),
        additions: None,
        deletions: None,
        changed_files: None,
        review: None,
        conflicts: raw["has_conflicts"] == true && text(&raw["state"]) == "opened",
        pipeline: None,
    }
}

// `gh pr list --json latestReviews,commits` exceeds GitHub's GraphQL node limit, so review state has its own narrow query
const REVIEW_QUERY: &str = r"query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        author { login }
        reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } } } }
        latestReviews(first: 30) { nodes { author { login } state commit { oid } } }
        commits(last: 100) { nodes { commit { oid } } }
        head: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
          ... on CheckRun { status }
          ... on StatusContext { state }
        } } } } } }
      }
    }
  }
}";

/// Review status of each PR by number, from REVIEW_QUERY's response
pub fn github_review_statuses(raw: &Value) -> HashMap<u32, Review> {
    let data = &raw["data"];
    let viewer = text(&data["viewer"]["login"]);
    let mut statuses = HashMap::new();
    for pr in nodes(&data["search"]) {
        let Some(number) = number(&pr["number"]) else {
            continue;
        };
        let oids: Vec<&str> = nodes(&pr["commits"])
            .iter()
            .map(|node| text(&node["commit"]["oid"]))
            .collect();
        let reviews = nodes(&pr["latestReviews"]);
        let mine = reviews
            .iter()
            .find(|review| text(&review["author"]["login"]) == viewer);
        let reviewed_oid = mine.map_or("", |review| text(&review["commit"]["oid"]));
        // A review on a commit outside the last 100 counts every listed commit as new
        let new_commits = if reviewed_oid.is_empty() {
            0
        } else {
            let last = oids.iter().rposition(|oid| *oid == reviewed_oid);
            (oids.len() as i64 - 1 - last.map_or(-1, |index| index as i64)) as u32
        };
        let requested = nodes(&pr["reviewRequests"])
            .iter()
            .any(|node| text(&node["requestedReviewer"]["login"]) == viewer);
        let state = if text(&pr["author"]["login"]) == viewer {
            ReviewState::Yours
        } else if requested {
            ReviewState::Requested
        } else if let Some(mine) = mine {
            match text(&mine["state"]) {
                "APPROVED" => ReviewState::Approved,
                "CHANGES_REQUESTED" => ReviewState::Changes,
                _ => ReviewState::Commented,
            }
        } else {
            ReviewState::Unreviewed
        };
        let changes_requested = reviews.iter().any(|review| {
            text(&review["state"]) == "CHANGES_REQUESTED"
                && text(&review["author"]["login"]) != viewer
        });
        let new_commits = if state == ReviewState::Yours {
            0
        } else {
            new_commits
        };
        statuses.insert(
            number,
            Review {
                state,
                new_commits,
                changes_requested,
            },
        );
    }
    statuses
}

/// The head commit's check rollup per PR number, from REVIEW_QUERY's response; the url is filled in by the caller
pub fn github_pipelines(raw: &Value) -> HashMap<u32, Pipeline> {
    let mut pipelines = HashMap::new();
    for pr in nodes(&raw["data"]["search"]) {
        let rollup = nodes(&pr["head"])
            .first()
            .map(|node| &node["commit"]["statusCheckRollup"]);
        let (Some(number), Some(rollup)) = (number(&pr["number"]), rollup) else {
            continue;
        };
        let status = match text(&rollup["state"]) {
            "SUCCESS" => CheckStatus::Passed,
            "FAILURE" | "ERROR" => CheckStatus::Failed,
            "PENDING" | "EXPECTED" => CheckStatus::Running,
            _ => continue,
        };
        let contexts = nodes(&rollup["contexts"]);
        let done = contexts
            .iter()
            .filter(|context| match context["status"].as_str() {
                Some(status) => status == "COMPLETED",
                None => !matches!(text(&context["state"]), "PENDING" | "EXPECTED"),
            })
            .count() as u32;
        let total = contexts.len() as u32;
        pipelines.insert(
            number,
            Pipeline {
                status,
                done,
                total,
                url: String::new(),
            },
        );
    }
    pipelines
}

const GITLAB_PIPELINE_QUERY: &str = r"query($path: ID!) {
  project(fullPath: $path) { mergeRequests(state: opened, first: 50, sort: UPDATED_DESC) { nodes {
    iid headPipeline { status path jobs { nodes { status } } }
  } } }
}";

/// Skipped, manual and canceled pipelines say nothing about the code, so they show as none
fn gitlab_status(status: &str) -> Option<CheckStatus> {
    match status {
        "SUCCESS" => Some(CheckStatus::Passed),
        "FAILED" => Some(CheckStatus::Failed),
        "RUNNING" | "PENDING" | "CREATED" | "PREPARING" | "WAITING_FOR_RESOURCE" | "SCHEDULED" => {
            Some(CheckStatus::Running)
        }
        _ => None,
    }
}

/// The head pipeline of each open merge request by iid; GitLab's REST list doesn't include it
pub fn gitlab_pipelines(raw: &Value, host: &str) -> HashMap<u32, Pipeline> {
    let mut pipelines = HashMap::new();
    for request in nodes(&raw["data"]["project"]["mergeRequests"]) {
        let pipeline = &request["headPipeline"];
        let iid = text(&request["iid"]).parse::<u32>().ok();
        let path = text(&pipeline["path"]);
        let (Some(status), Some(iid), false) = (
            gitlab_status(text(&pipeline["status"])),
            iid,
            path.is_empty(),
        ) else {
            continue;
        };
        let jobs = nodes(&pipeline["jobs"]);
        let done = jobs
            .iter()
            .filter(|job| gitlab_status(text(&job["status"])) != Some(CheckStatus::Running))
            .count() as u32;
        let url = format!("https://{host}{path}");
        pipelines.insert(
            iid,
            Pipeline {
                status,
                done,
                total: jobs.len() as u32,
                url,
            },
        );
    }
    pipelines
}

const GITHUB_FIELDS: &str = "number,title,author,headRefName,headRefOid,baseRefName,state,isDraft,updatedAt,additions,deletions,changedFiles,url,mergeable";

fn list_for_repo(repo_path: &str) -> Result<Vec<PullRequest>, String> {
    let cwd = Path::new(repo_path);
    let Some(remote) = remote_of(cwd) else {
        return Ok(Vec::new());
    };
    let repo = format!("{}/{}", remote.host, remote.slug);
    if remote.provider == Provider::Github {
        let limit = LIST_LIMIT.to_string();
        let list_args = [
            "pr",
            "list",
            "-R",
            &repo,
            "--state",
            "all",
            "--limit",
            &limit,
            "--json",
            GITHUB_FIELDS,
        ];
        let search = format!("q=repo:{} is:pr sort:updated-desc", remote.slug);
        let query = format!("query={REVIEW_QUERY}");
        let review_args = [
            "api",
            "graphql",
            "--hostname",
            &remote.host,
            "-f",
            &search,
            "-f",
            &query,
        ];
        // Review marks are a nicety: the list still loads when that query fails
        let (list, review_data) = std::thread::scope(|scope| {
            let reviews = scope.spawn(|| run_json("gh", &review_args, cwd).unwrap_or(Value::Null));
            (
                run_json("gh", &list_args, cwd),
                reviews.join().unwrap_or(Value::Null),
            )
        });
        return Ok(github_list(&list?, &review_data, repo_path));
    }
    let path =
        format!("projects/:id/merge_requests?state=all&order_by=updated_at&per_page={LIST_LIMIT}");
    let query = format!("query={GITLAB_PIPELINE_QUERY}");
    let slug = format!("path={}", remote.slug);
    // Pipelines are a nicety too: the list still loads without them
    let (requests, pipeline_data, viewer) = std::thread::scope(|scope| {
        let pipelines = scope.spawn(|| {
            run_json("glab", &["api", "graphql", "-f", &query, "-f", &slug], cwd)
                .unwrap_or(Value::Null)
        });
        let viewer = scope.spawn(|| {
            run_json("glab", &["api", "user"], cwd)
                .map(|user| text(&user["username"]).to_string())
                .ok()
        });
        let requests = run_json("glab", &["api", &path], cwd);
        (
            requests,
            pipelines.join().unwrap_or(Value::Null),
            viewer.join().ok().flatten(),
        )
    });
    Ok(gitlab_list(
        &requests?,
        &pipeline_data,
        &remote.host,
        viewer.as_deref(),
        repo_path,
    ))
}

fn github_list(list: &Value, review_data: &Value, repo_path: &str) -> Vec<PullRequest> {
    let reviews = github_review_statuses(review_data);
    let mut pipelines = github_pipelines(review_data);
    let raw = list.as_array().map_or(&[][..], Vec::as_slice);
    raw.iter()
        .map(|raw| {
            let mut pr = to_github_pull_request(raw, repo_path);
            if pr.state == PrState::Open {
                pr.review = reviews.get(&pr.number).cloned();
                pr.pipeline = pipelines.remove(&pr.number).map(|pipeline| Pipeline {
                    url: format!("{}/checks", pr.url),
                    ..pipeline
                });
            }
            pr
        })
        .collect()
}

fn gitlab_list(
    requests: &Value,
    pipeline_data: &Value,
    host: &str,
    viewer: Option<&str>,
    repo_path: &str,
) -> Vec<PullRequest> {
    let mut pipelines = gitlab_pipelines(pipeline_data, host);
    let raw = requests.as_array().map_or(&[][..], Vec::as_slice);
    raw.iter()
        .map(|raw| {
            let mut pr = to_gitlab_pull_request(raw, repo_path);
            if pr.state == PrState::Open {
                pr.pipeline = pipelines.remove(&pr.number);
                // Only your own merge requests are marked: GitLab's list carries no review state for anyone else's
                if viewer == Some(pr.author.as_str()) {
                    pr.review = Some(Review {
                        state: ReviewState::Yours,
                        new_commits: 0,
                        changes_requested: false,
                    });
                }
            }
            pr
        })
        .collect()
}

/// Every repo in parallel; one that fails lands in `errors` and the rest still list
pub fn list_pull_requests(repo_paths: &[String]) -> PullRequestList {
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = repo_paths
            .iter()
            .map(|path| scope.spawn(move || list_for_repo(path)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("listing crashed".into()))
            })
            .collect()
    });
    let mut list = PullRequestList {
        pull_requests: Vec::new(),
        errors: Vec::new(),
    };
    for (repo_path, result) in repo_paths.iter().zip(results) {
        match result {
            Ok(prs) => list.pull_requests.extend(prs),
            Err(message) => list.errors.push(PrError {
                repo_path: repo_path.clone(),
                message,
            }),
        }
    }
    list.pull_requests
        .sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    list
}

/// `gh pr checks --json name,bucket,link`
pub fn github_checks(raw: &Value) -> Vec<Check> {
    let raw = raw.as_array().map_or(&[][..], Vec::as_slice);
    raw.iter()
        .map(|check| Check {
            name: text(&check["name"]).into(),
            status: match text(&check["bucket"]) {
                "pass" => CheckStatus::Passed,
                "fail" | "cancel" => CheckStatus::Failed,
                "pending" => CheckStatus::Running,
                _ => CheckStatus::Skipped,
            },
            url: Some(text(&check["link"]))
                .filter(|link| !link.is_empty())
                .map(Into::into),
        })
        .collect()
}

/// A pipeline's jobs from the REST API
pub fn gitlab_jobs(raw: &Value) -> Vec<Check> {
    let raw = raw.as_array().map_or(&[][..], Vec::as_slice);
    raw.iter()
        .map(|job| Check {
            name: text(&job["name"]).into(),
            status: gitlab_status(&text(&job["status"]).to_uppercase())
                .unwrap_or(CheckStatus::Skipped),
            url: Some(text(&job["web_url"]))
                .filter(|url| !url.is_empty())
                .map(Into::into),
        })
        .collect()
}

pub fn pr_checks(pr: &PrRef) -> Result<Vec<Check>, String> {
    let cwd = Path::new(&pr.repo_path);
    let number = pr.number.to_string();
    if pr.provider == Provider::Github {
        let out = output(
            "gh",
            &["pr", "checks", &number, "--json", "name,bucket,link"],
            cwd,
        )?;
        // gh exits 1 when a check failed and 8 while some are pending, with the JSON still on stdout
        if let Ok(raw) = serde_json::from_slice::<Value>(&out.stdout) {
            return Ok(github_checks(&raw));
        }
        let message = failure("gh", &out);
        return if message.contains("no checks reported") {
            Ok(Vec::new())
        } else {
            Err(message)
        };
    }
    let pipelines = run_json(
        "glab",
        &[
            "api",
            &format!("projects/:id/merge_requests/{number}/pipelines"),
        ],
        cwd,
    )?;
    let Some(id) = pipelines
        .get(0)
        .and_then(|pipeline| pipeline["id"].as_u64())
    else {
        return Ok(Vec::new());
    };
    Ok(gitlab_jobs(&run_json(
        "glab",
        &[
            "api",
            &format!("projects/:id/pipelines/{id}/jobs?per_page=100"),
        ],
        cwd,
    )?))
}

/// encodeURIComponent, for a branch name segment in an API path
fn encode(segment: &str) -> String {
    segment
        .bytes()
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

pub fn merge_pull_request(
    pr: &PrRef,
    method: MergeMethod,
    delete_branch: bool,
) -> Result<(), String> {
    let cwd = Path::new(&pr.repo_path);
    let remote = require_remote(cwd)?;
    let number = pr.number.to_string();
    if remote.provider == Provider::Github {
        let repo = format!("{}/{}", remote.host, remote.slug);
        let branch = if delete_branch {
            let view = run_json(
                "gh",
                &["pr", "view", &number, "-R", &repo, "--json", "headRefName"],
                cwd,
            )?;
            Some(text(&view["headRefName"]).to_string())
        } else {
            None
        };
        let method = match method {
            MergeMethod::Merge => "merge_method=merge",
            MergeMethod::Squash => "merge_method=squash",
            MergeMethod::Rebase => "merge_method=rebase",
        };
        let merge = format!("repos/{}/pulls/{number}/merge", remote.slug);
        run(
            "gh",
            &[
                "api",
                "--hostname",
                &remote.host,
                "-X",
                "PUT",
                &merge,
                "-f",
                method,
            ],
            cwd,
        )?;
        if let Some(branch) = branch.filter(|branch| !branch.is_empty()) {
            let encoded: Vec<String> = branch.split('/').map(encode).collect();
            let refs = format!("repos/{}/git/refs/heads/{}", remote.slug, encoded.join("/"));
            run(
                "gh",
                &["api", "--hostname", &remote.host, "-X", "DELETE", &refs],
                cwd,
            )?;
        }
        return Ok(());
    }
    let mut args = vec!["mr", "merge", &number, "--yes", "--auto-merge=false"];
    match method {
        MergeMethod::Squash => args.push("--squash"),
        MergeMethod::Rebase => args.push("--rebase"),
        MergeMethod::Merge => {}
    }
    if delete_branch {
        args.push("--remove-source-branch");
    }
    run("glab", &args, cwd).map(drop)
}

/// Opens a draft PR (a draft MR on GitLab) of the pushed `branch` into `base`; its number and URL
pub fn open_draft_pr(
    repo_path: &str,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<(u32, String), String> {
    let cwd = Path::new(repo_path);
    let remote = require_remote(cwd)?;
    let out = if remote.provider == Provider::Github {
        let repo = format!("{}/{}", remote.host, remote.slug);
        run(
            "gh",
            &[
                "pr", "create", "--draft", "-R", &repo, "--head", branch, "--base", base,
                "--title", title, "--body", body,
            ],
            cwd,
        )?
    } else {
        run(
            "glab",
            &[
                "mr",
                "create",
                "--draft",
                "--yes",
                "--source-branch",
                branch,
                "--target-branch",
                base,
                "--title",
                title,
                "--description",
                body,
            ],
            cwd,
        )?
    };
    created_pr(&out).ok_or_else(|| format!("No PR link in: {}", out.trim()))
}

/// The link `gh pr create` and `glab mr create` print, like `https://github.com/o/r/pull/12`
fn created_pr(output: &str) -> Option<(u32, String)> {
    output.split_whitespace().rev().find_map(|word| {
        let (_, number) = word
            .rsplit_once("/pull/")
            .or_else(|| word.rsplit_once("/merge_requests/"))?;
        Some((number.trim_end_matches('/').parse().ok()?, word.to_owned()))
    })
}

/// One PR of the repo, without review state
pub fn pull_request(repo_path: &str, number: u32) -> Result<PullRequest, String> {
    let cwd = Path::new(repo_path);
    let remote = require_remote(cwd)?;
    let number = number.to_string();
    if remote.provider == Provider::Github {
        let repo = format!("{}/{}", remote.host, remote.slug);
        let view = run_json(
            "gh",
            &["pr", "view", &number, "-R", &repo, "--json", GITHUB_FIELDS],
            cwd,
        )?;
        return Ok(to_github_pull_request(&view, repo_path));
    }
    let request = run_json(
        "glab",
        &["api", &format!("projects/:id/merge_requests/{number}")],
        cwd,
    )?;
    Ok(to_gitlab_pull_request(&request, repo_path))
}

/// Accounts in `gh auth status` / `glab auth status` output: "Logged in to <host> account <user>" or "... as <user>"
pub fn signed_in_accounts(output: &str) -> Vec<String> {
    let mut accounts: Vec<String> = Vec::new();
    for (_, after) in output
        .match_indices("Logged in to ")
        .map(|(index, found)| output.split_at(index + found.len()))
    {
        let mut words = after.split_whitespace().skip(1);
        let account = match words.next() {
            Some("account" | "as") => words.next(),
            other => other,
        };
        if let Some(account) =
            account.filter(|account| !accounts.iter().any(|known| known == account))
        {
            accounts.push(account.into());
        }
    }
    accounts
}

pub fn pr_providers() -> Vec<ProviderStatus> {
    [(Provider::Github, "gh"), (Provider::Gitlab, "glab")]
        .map(|(provider, command)| {
            let Ok(out) = output(command, &["auth", "status"], &std::env::temp_dir()) else {
                return ProviderStatus {
                    provider,
                    installed: false,
                    signed_in: false,
                    user: None,
                };
            };
            // glab exits non-zero when any one of several hosts fails, so the output decides
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let user = signed_in_accounts(&text).into_iter().next();
            ProviderStatus {
                provider,
                installed: true,
                signed_in: user.is_some(),
                user,
            }
        })
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn created_prs_are_read_from_the_printed_link() {
        let gh = "Creating draft pull request for routine/x into main\n\nhttps://github.com/o/r/pull/12\n";
        assert_eq!(
            created_pr(gh),
            Some((12, "https://github.com/o/r/pull/12".into()))
        );
        let glab = "https://gitlab.com/g/r/-/merge_requests/7\n";
        assert_eq!(created_pr(glab).map(|(n, _)| n), Some(7));
        assert_eq!(created_pr("Warning: 2 uncommitted changes"), None);
    }

    fn remote(provider: Provider, host: &str, slug: &str) -> Option<Remote> {
        Some(Remote {
            provider,
            host: host.into(),
            slug: slug.into(),
        })
    }

    #[test]
    fn parse_remote_reads_github_and_gitlab_urls() {
        assert_eq!(
            parse_remote("git@github.com:blurifycom/openora.git"),
            remote(Provider::Github, "github.com", "blurifycom/openora")
        );
        assert_eq!(
            parse_remote("https://github.com/a/b"),
            remote(Provider::Github, "github.com", "a/b")
        );
        assert_eq!(
            parse_remote("ssh://git@gitlab.blurify.com:2222/betfeel/sub/betfeel.git\n"),
            remote(
                Provider::Gitlab,
                "gitlab.blurify.com",
                "betfeel/sub/betfeel"
            )
        );
        assert_eq!(parse_remote("git@bitbucket.org:a/b.git"), None);
        assert_eq!(parse_remote(""), None);
    }

    #[test]
    fn to_gitlab_pull_request_maps_states() {
        let pr = to_gitlab_pull_request(
            &json!({ "iid": 427, "state": "opened", "draft": true, "author": { "username": "o" } }),
            "/repo",
        );
        assert_eq!(
            (pr.number, pr.state, pr.draft, pr.author.as_str()),
            (427, PrState::Open, true, "o")
        );
        let avatar = |login: &str| {
            to_github_pull_request(&json!({ "author": { "login": login } }), "/repo")
                .author_avatar_url
        };
        assert_eq!(
            avatar("zaxovaiko").as_deref(),
            Some("https://github.com/zaxovaiko.png?size=64")
        );
        assert_eq!(avatar("app/dependabot"), None);
    }

    #[test]
    fn github_review_statuses_tells_reviewed_requested_and_own_prs_apart() {
        let pr = |number: u32,
                  author: &str,
                  requested: &[&str],
                  reviews: &[(&str, &str, &str)],
                  commits: &[&str]| {
            json!({
                "number": number,
                "author": { "login": author },
                "reviewRequests": { "nodes": requested.iter().map(|login| json!({ "requestedReviewer": { "login": login } })).collect::<Vec<_>>() },
                "latestReviews": { "nodes": reviews.iter().map(|(login, state, oid)| json!({ "author": { "login": login }, "state": state, "commit": { "oid": oid } })).collect::<Vec<_>>() },
                "commits": { "nodes": commits.iter().map(|oid| json!({ "commit": { "oid": oid } })).collect::<Vec<_>>() },
            })
        };
        let statuses = github_review_statuses(
            &json!({ "data": { "viewer": { "login": "me" }, "search": { "nodes": [
            pr(1, "me", &[], &[], &["a"]),
            pr(2, "ann", &["me"], &[], &["a"]),
            pr(3, "ann", &[], &[("me", "APPROVED", "b"), ("bob", "CHANGES_REQUESTED", "b")], &["a", "b"]),
            pr(4, "ann", &[], &[("me", "CHANGES_REQUESTED", "a")], &["a", "b", "c"]),
            pr(5, "ann", &[], &[], &["a"]),
            pr(6, "me", &[], &[("ann", "APPROVED", "a"), ("bob", "CHANGES_REQUESTED", "a")], &["a", "b"]),
            {},
        ] } } }),
        );
        let review = |state, new_commits, changes_requested| Review {
            state,
            new_commits,
            changes_requested,
        };
        let expected = HashMap::from([
            (1, review(ReviewState::Yours, 0, false)),
            (2, review(ReviewState::Requested, 0, false)),
            (3, review(ReviewState::Approved, 0, true)),
            (4, review(ReviewState::Changes, 2, false)),
            (5, review(ReviewState::Unreviewed, 0, false)),
            (6, review(ReviewState::Yours, 0, true)),
        ]);
        assert_eq!(statuses, expected);
    }

    #[test]
    fn github_pipelines_reads_the_head_commit_check_rollup() {
        let head = |state: Option<&str>| {
            json!({ "nodes": [{ "commit": { "statusCheckRollup": state.map(|state| json!({ "state": state, "contexts": { "nodes": [
            { "status": "COMPLETED" }, { "status": "IN_PROGRESS" }, { "state": "SUCCESS" }, { "state": "PENDING" }
        ] } })) } }] })
        };
        let raw = json!({ "data": { "search": { "nodes": [
            { "number": 1, "head": head(Some("SUCCESS")) },
            { "number": 2, "head": head(Some("ERROR")) },
            { "number": 3, "head": head(Some("PENDING")) },
            { "number": 4, "head": head(None) },
        ] } } });
        let pipelines = github_pipelines(&raw);
        let mut statuses: Vec<_> = pipelines
            .iter()
            .map(|(number, pipeline)| (*number, pipeline.status))
            .collect();
        statuses.sort_by_key(|(number, _)| *number);
        assert_eq!(
            statuses,
            [
                (1, CheckStatus::Passed),
                (2, CheckStatus::Failed),
                (3, CheckStatus::Running)
            ]
        );
        assert_eq!((pipelines[&1].done, pipelines[&1].total), (2, 4));
    }

    #[test]
    fn gitlab_pipelines_links_each_merge_request_to_its_head_pipeline_and_skips_ones_that_say_nothing()
     {
        let node = |iid: &str, status: &str| json!({ "iid": iid, "headPipeline": { "status": status, "path": format!("/g/p/-/pipelines/{iid}"), "jobs": { "nodes": [{ "status": "SUCCESS" }, { "status": "RUNNING" }, { "status": "MANUAL" }] } } });
        let raw = json!({ "data": { "project": { "mergeRequests": { "nodes": [node("7", "FAILED"), node("8", "SKIPPED"), { "iid": "9", "headPipeline": null }] } } } });
        let pipelines = gitlab_pipelines(&raw, "gitlab.example.com");
        let expected = Pipeline {
            status: CheckStatus::Failed,
            done: 2,
            total: 3,
            url: "https://gitlab.example.com/g/p/-/pipelines/7".into(),
        };
        assert_eq!(pipelines, HashMap::from([(7, expected)]));
    }

    /// Trimmed `gh pr list --json ...` output
    const GH_LIST: &str = r#"[
        {"number":12,"title":"feat: x","author":{"login":"ann","is_bot":false},"headRefName":"feat/x","headRefOid":"1234567890abcdef","baseRefName":"main","state":"OPEN","isDraft":false,"updatedAt":"2026-10-20T10:00:00Z","additions":10,"deletions":2,"changedFiles":3,"url":"https://github.com/acme/app/pull/12","mergeable":"CONFLICTING"},
        {"number":11,"title":"fix: y","author":{"login":"me"},"headRefName":"fix/y","headRefOid":"abcdef1234567890","baseRefName":"main","state":"MERGED","isDraft":false,"updatedAt":"2026-10-19T10:00:00Z","additions":1,"deletions":1,"changedFiles":1,"url":"https://github.com/acme/app/pull/11","mergeable":"UNKNOWN"}
    ]"#;

    #[test]
    fn github_list_joins_reviews_and_checks_on_open_prs() {
        let review = json!({ "data": { "viewer": { "login": "me" }, "search": { "nodes": [
            { "number": 12, "author": { "login": "ann" }, "reviewRequests": { "nodes": [{ "requestedReviewer": { "login": "me" } }] },
              "head": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE", "contexts": { "nodes": [{ "status": "COMPLETED" }] } } } }] } },
            { "number": 11, "author": { "login": "me" }, "head": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] } },
        ] } } });
        let prs = github_list(&serde_json::from_str(GH_LIST).unwrap(), &review, "/repo");
        let open = &prs[0];
        assert_eq!(
            (open.head.as_str(), open.conflicts, open.changed_files),
            ("1234567", true, Some(3))
        );
        assert_eq!(
            open.review.as_ref().map(|review| review.state),
            Some(ReviewState::Requested)
        );
        let pipeline = open.pipeline.as_ref().unwrap();
        assert_eq!(
            (pipeline.status, pipeline.done, pipeline.url.as_str()),
            (
                CheckStatus::Failed,
                1,
                "https://github.com/acme/app/pull/12/checks"
            )
        );
        assert_eq!(
            (
                prs[1].state,
                prs[1].review.is_none(),
                prs[1].pipeline.is_none()
            ),
            (PrState::Merged, true, true)
        );
        // The review query failing still lists
        assert_eq!(
            github_list(
                &serde_json::from_str(GH_LIST).unwrap(),
                &Value::Null,
                "/repo"
            )
            .len(),
            2
        );
    }

    /// Trimmed `glab api projects/:id/merge_requests` output
    const GLAB_LIST: &str = r#"[
        {"iid":437,"title":"Draft: feat","state":"opened","draft":true,"author":{"username":"volod","avatar_url":"https://gitlab.example.com/a.png"},"source_branch":"feat/a","target_branch":"main","sha":"fedcba9876543210","updated_at":"2026-10-21T08:00:00.000Z","web_url":"https://gitlab.example.com/g/p/-/merge_requests/437","has_conflicts":true,"user_notes_count":3},
        {"iid":436,"title":"old","state":"merged","draft":false,"author":{"username":"kasia","avatar_url":null},"source_branch":"fix/b","target_branch":"main","sha":"0011223344","updated_at":"2026-10-01T08:00:00.000Z","web_url":"https://gitlab.example.com/g/p/-/merge_requests/436","has_conflicts":true}
    ]"#;

    #[test]
    fn gitlab_list_marks_your_open_merge_requests() {
        let pipelines = json!({ "data": { "project": { "mergeRequests": { "nodes": [{ "iid": "437", "headPipeline": { "status": "RUNNING", "path": "/g/p/-/pipelines/5" } }] } } } });
        let prs = gitlab_list(
            &serde_json::from_str(GLAB_LIST).unwrap(),
            &pipelines,
            "gitlab.example.com",
            Some("volod"),
            "/repo",
        );
        assert_eq!(
            (prs[0].head.as_str(), prs[0].conflicts, prs[0].draft),
            ("fedcba9", true, true)
        );
        assert_eq!(
            prs[0].review.as_ref().map(|review| review.state),
            Some(ReviewState::Yours)
        );
        assert_eq!(
            prs[0]
                .pipeline
                .as_ref()
                .map(|pipeline| pipeline.url.as_str()),
            Some("https://gitlab.example.com/g/p/-/pipelines/5")
        );
        assert_eq!(
            (
                prs[1].state,
                prs[1].conflicts,
                prs[1].author_avatar_url.is_none()
            ),
            (PrState::Merged, false, true)
        );
    }

    #[test]
    fn checks_map_buckets_and_job_states() {
        let gh = json!([{ "name": "build", "bucket": "pass", "link": "https://x/1" }, { "name": "lint", "bucket": "fail", "link": "" }, { "name": "e2e", "bucket": "pending" }, { "name": "deploy", "bucket": "skipping" }]);
        let statuses: Vec<_> = github_checks(&gh)
            .into_iter()
            .map(|check| (check.status, check.url))
            .collect();
        assert_eq!(
            statuses,
            [
                (CheckStatus::Passed, Some("https://x/1".into())),
                (CheckStatus::Failed, None),
                (CheckStatus::Running, None),
                (CheckStatus::Skipped, None),
            ]
        );
        let glab = json!([{ "name": "test", "status": "failed", "web_url": "https://g/j/1" }, { "name": "build", "status": "running" }, { "name": "deploy", "status": "manual" }]);
        let statuses: Vec<_> = gitlab_jobs(&glab)
            .into_iter()
            .map(|check| check.status)
            .collect();
        assert_eq!(
            statuses,
            [
                CheckStatus::Failed,
                CheckStatus::Running,
                CheckStatus::Skipped
            ]
        );
    }

    #[test]
    fn signed_in_accounts_reads_gh_and_glab_status() {
        let gh = "github.com\n  ✓ Logged in to github.com account zaxovaiko (keyring)\n  - Active account: true\n";
        assert_eq!(signed_in_accounts(gh), ["zaxovaiko"]);
        let glab = "gitlab.com\n  x gitlab.com: API call failed\ngitlab.blurify.com\n  ✓ Logged in to gitlab.blurify.com as volod (/config.yml)\n";
        assert_eq!(signed_in_accounts(glab), ["volod"]);
        assert!(signed_in_accounts("You are not logged into any GitHub hosts.").is_empty());
    }

    #[test]
    fn encode_escapes_branch_segments() {
        assert_eq!(encode("feat#1 x"), "feat%231%20x");
    }
}
