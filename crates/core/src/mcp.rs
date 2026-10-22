//! Treeix's MCP server for the agents it runs: streamable HTTP (rmcp + axum) on 127.0.0.1, every request
//! carrying a bearer token compared in constant time. Port of apps/desktop/src/main/mcp.ts

use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::future::Future;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::Arc;

const SERVER_NAME: &str = "treeix";
const INSTRUCTIONS: &str = "Tools of Treeix, the app this session runs in.";

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// A tool the app offers agents; `run` gets the call's arguments
#[derive(Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments
    pub input_schema: Value,
    pub run: Arc<dyn Fn(Value) -> ToolFuture + Send + Sync>,
}

/// A running server; dropping it stops it
pub struct McpServer {
    pub port: u16,
    pub token: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl McpServer {
    /// Binds 127.0.0.1:`port`, or any free port when that one is taken (agents set up outside Treeix then
    /// need setting up again)
    pub async fn start(tools: Vec<McpTool>, port: u16, token: String) -> Result<Self, String> {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Err(e) if e.kind() == ErrorKind::AddrInUse && port != 0 => {
                tokio::net::TcpListener::bind(("127.0.0.1", 0)).await
            }
            bound => bound,
        }
        .map_err(|e| format!("MCP server: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let handler = Handler {
            tools: Arc::new(tools),
        };
        let config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_sse_keep_alive(None)
            // Web pages send an Origin; agents don't, so no page can reach these tools through a rebound DNS name
            .enforce_origin_validation();
        let service = StreamableHttpService::new(
            move || Ok(handler.clone()),
            Arc::new(LocalSessionManager::default()),
            config,
        );
        let expected = format!("Bearer {token}");
        let router = axum::Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn(move |request: Request, next: Next| {
                let authorized = request
                    .headers()
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|given| token_matches(&expected, given));
                async move {
                    if authorized {
                        next.run(request).await
                    } else {
                        StatusCode::UNAUTHORIZED.into_response()
                    }
                }
            }));
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("MCP server stopped: {e}");
            }
        });
        Ok(Self { port, token, task })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    /// Env for an agent's process: the URL and token, plus `claude --mcp-config "$TREEIX_CLAUDE_MCP"` and
    /// `codex -c "$TREEIX_CODEX_MCP"`, which reach this server without any setup
    pub fn env(&self) -> Vec<(String, String)> {
        let url = self.url();
        let authorization = format!("Bearer {}", self.token);
        let claude = json!({ "mcpServers": { SERVER_NAME: {
            "type": "http", "url": url, "headers": { "Authorization": authorization }
        } } });
        let codex = format!(
            "mcp_servers.{SERVER_NAME}={{url={},http_headers={{\"Authorization\"={}}}}}",
            toml_string(&url),
            toml_string(&authorization)
        );
        vec![
            ("TREEIX_MCP_URL".into(), url),
            ("TREEIX_MCP_TOKEN".into(), self.token.clone()),
            ("TREEIX_CLAUDE_MCP".into(), claude.to_string()),
            ("TREEIX_CODEX_MCP".into(), codex),
        ]
    }
}

#[derive(Clone)]
struct Handler {
    tools: Arc<Vec<McpTool>>,
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self.tools.iter().map(|tool| {
            let schema = match &tool.input_schema {
                Value::Object(schema) => schema.clone(),
                _ => Default::default(),
            };
            Tool::new(tool.name.clone(), tool.description.clone(), schema)
        });
        Ok(ListToolsResult::with_all_items(tools.collect()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let Some(tool) = self.tools.iter().find(|tool| tool.name == request.name) else {
            let missing = format!("No tool named {}", request.name);
            return Ok(CallToolResult::error(vec![ContentBlock::text(missing)]).into());
        };
        let args = Value::Object(request.arguments.unwrap_or_default());
        Ok(match (tool.run)(args).await {
            Ok(text) => CallToolResult::success(vec![ContentBlock::text(text)]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e)]),
        }
        .into())
    }
}

/// Constant time, so the token can't be guessed byte by byte from response timing
pub fn token_matches(expected: &str, given: &str) -> bool {
    use subtle::ConstantTimeEq;
    expected.len() == given.len() && bool::from(expected.as_bytes().ct_eq(given.as_bytes()))
}

/// 32 random bytes as hex
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|e| format!("no random token: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Plain lines of what a terminal shows; full-screen apps redraw in place, so theirs read rough
pub fn screen_text(output: &str, lines: usize) -> String {
    let plain = strip_escapes(output);
    let rows: Vec<&str> = plain
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            line.rsplit('\r').next().unwrap_or("").trim_end()
        })
        .collect();
    let kept: Vec<&str> = rows
        .iter()
        .enumerate()
        .filter(|&(index, line)| !line.is_empty() || index > 0 && !rows[index - 1].is_empty())
        .map(|(_, line)| *line)
        .collect();
    kept[kept.len().saturating_sub(lines)..]
        .join("\n")
        .trim()
        .to_string()
}

/// Drops OSC strings, CSI sequences and other two-byte escapes
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next_if_eq(&'\\');
                        break;
                    }
                }
            }
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpAgent {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpInstallState {
    Installed,
    /// Registered with an old command or URL
    Outdated,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpInstall {
    pub agent: McpAgent,
    pub state: McpInstallState,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpInstallResult {
    pub installed: Vec<McpAgent>,
    /// Agent and the error
    pub failed: Vec<(McpAgent, String)>,
}

fn toml_string(value: &str) -> String {
    Value::from(value).to_string()
}

fn codex_config(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map_or_else(|| home.join(".codex"), PathBuf::from)
        .join("config.toml")
}

/// Byte range of the `[mcp_servers.treeix]` table in Codex's config.toml, up to the next table
fn codex_section(config: &str) -> Option<std::ops::Range<usize>> {
    let header = format!("[mcp_servers.{SERVER_NAME}]\n");
    let start = (config.starts_with(&header).then_some(0))
        .or_else(|| config.find(&format!("\n{header}")).map(|at| at + 1))?;
    let body = start + header.len();
    let end = config[body..]
        .match_indices("\n[")
        .next()
        .map_or(config.len(), |(at, _)| body + at + 1);
    Some(start..end)
}

/// Whether Claude Code and Codex, when set up on this machine, reach `server` from any terminal
pub fn install_status(home: &Path, server: &McpServer) -> Vec<McpInstall> {
    let mut found = Vec::new();
    if let Ok(claude) = std::fs::read_to_string(home.join(".claude.json")) {
        // Claude rewrites the file as it runs; a torn read shows as not set up
        let entry = serde_json::from_str::<Value>(&claude)
            .ok()
            .and_then(|config| config.get("mcpServers")?.get(SERVER_NAME).cloned());
        let state = match entry {
            None => McpInstallState::Missing,
            Some(entry)
                if entry.get("url").and_then(Value::as_str) == Some(&server.url())
                    && entry
                        .get("headers")
                        .is_some_and(|headers| headers.to_string().contains(&server.token)) =>
            {
                McpInstallState::Installed
            }
            Some(_) => McpInstallState::Outdated,
        };
        found.push(McpInstall {
            agent: McpAgent::Claude,
            state,
        });
    }
    let path = codex_config(home);
    let config = std::fs::read_to_string(&path).unwrap_or_default();
    // Codex keeps its folder from the first run, before any config.toml
    if !config.is_empty() || path.parent().is_some_and(Path::is_dir) {
        let state = match codex_section(&config).map(|range| &config[range]) {
            None => McpInstallState::Missing,
            Some(section) if section.contains(&server.url()) && section.contains(&server.token) => {
                McpInstallState::Installed
            }
            Some(_) => McpInstallState::Outdated,
        };
        found.push(McpInstall {
            agent: McpAgent::Codex,
            state,
        });
    }
    found
}

/// Registers `server` with every installed agent (user scope), replacing an older entry. The token goes into
/// those files: anything running as the user can read it there, as it can read Treeix's own data
pub fn install(home: &Path, server: &McpServer) -> McpInstallResult {
    let url = server.url();
    let authorization = format!("Bearer {}", server.token);
    let mut result = McpInstallResult::default();
    let mut record = |agent, outcome: Result<bool, String>| match outcome {
        Ok(true) => result.installed.push(agent),
        // Not installed: nothing to set up
        Ok(false) => {}
        Err(e) => result.failed.push((agent, e)),
    };
    record(McpAgent::Claude, {
        let _ = agent_cli(
            home,
            "claude",
            &["mcp", "remove", "--scope", "user", SERVER_NAME],
        );
        let header = format!("Authorization: {authorization}");
        let add = [
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "http",
            SERVER_NAME,
            &url,
            "--header",
            &header,
        ];
        agent_cli(home, "claude", &add)
    });
    record(
        McpAgent::Codex,
        agent_cli(home, "codex", &["--version"]).and_then(|found| {
            if !found {
                return Ok(false);
            }
            let path = codex_config(home);
            let config = std::fs::read_to_string(&path).unwrap_or_default();
            let table = format!(
                "[mcp_servers.{SERVER_NAME}]\nurl = {}\nhttp_headers = {{ Authorization = {} }}\n",
                toml_string(&url),
                toml_string(&authorization)
            );
            let updated = match codex_section(&config) {
                Some(range) => format!(
                    "{}{table}\n{}",
                    &config[..range.start],
                    &config[range.end..]
                ),
                None if config.is_empty() => table,
                None if config.ends_with('\n') => format!("{config}\n{table}"),
                None => format!("{config}\n\n{table}"),
            };
            let write = || -> std::io::Result<()> {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(&path, updated)
            };
            write()
                .map(|()| true)
                .map_err(|e| format!("{}: {e}", path.display()))
        }),
    );
    result
}

/// Runs an agent's CLI; false when it is not installed
fn agent_cli(home: &Path, name: &str, args: &[&str]) -> Result<bool, String> {
    let mut command = Command::new(program(name, home));
    command.args(args).stdin(Stdio::null());
    // Set when Treeix itself runs inside an agent; passed on, `claude` thinks it is a nested session
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key.starts_with("CLAUDE") || key.starts_with("MCP_") || key == "AI_AGENT" {
            command.env_remove(key.as_ref());
        }
    }
    match command.output() {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{name}: {e}")),
        Ok(out) if out.status.success() => Ok(true),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map_or_else(|| format!("{name} failed ({})", out.status), str::to_owned))
        }
    }
}

/// A GUI app started from Finder has a bare PATH: Homebrew's and the user's bin dirs are tried after it
pub(crate) fn program(name: &str, home: &Path) -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from))
        .chain([".local/bin", ".bun/bin", ".npm-global/bin"].map(|dir| home.join(dir)))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| name.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_must_match_exactly() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "ab"));
        assert!(!token_matches("abc", ""));
    }

    #[test]
    fn new_tokens_are_random_hex() {
        let token = new_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(token, new_token().unwrap());
    }

    #[test]
    fn screen_text_drops_escapes_keeps_what_a_carriage_return_overwrote_last_and_the_tail() {
        let output = "\x1b]0;title\x07\x1b[32m$ \x1b[0mls\r\nfiles\r\nprogress 10%\rprogress 100%\r\n\r\n\r\n$ ";
        assert_eq!(screen_text(output, 60), "$ ls\nfiles\nprogress 100%\n\n$");
        assert_eq!(screen_text(output, 1), "$");
    }

    #[test]
    fn codex_section_runs_to_the_next_table() {
        let config = "model = \"o3\"\n\n[mcp_servers.treeix]\nurl = \"x\"\n\n[other]\na = 1\n";
        let range = codex_section(config).unwrap();
        assert_eq!(&config[range], "[mcp_servers.treeix]\nurl = \"x\"\n\n");
        assert_eq!(
            codex_section("[mcp_servers.treeix]\nurl = \"x\"\n"),
            Some(0..31)
        );
        assert_eq!(codex_section("[mcp_servers.treeixx]\n"), None);
    }

    fn echo_tool() -> McpTool {
        McpTool {
            name: "echo".into(),
            description: "Says it back".into(),
            input_schema: json!({ "type": "object", "properties": { "text": { "type": "string" } } }),
            run: Arc::new(|args| {
                Box::pin(async move {
                    match args.get("text").and_then(Value::as_str) {
                        Some(text) => Ok(text.to_string()),
                        None => Err("text is required".into()),
                    }
                })
            }),
        }
    }

    async fn post(server: &McpServer, auth: Option<&str>, body: Value) -> reqwest::Response {
        let mut request = reqwest::Client::new()
            .post(server.url())
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(auth) = auth {
            request = request.header("Authorization", auth);
        }
        request.send().await.unwrap()
    }

    #[tokio::test]
    async fn tools_answer_over_http_with_the_token_only() {
        let server = McpServer::start(vec![echo_tool()], 0, "secret".into())
            .await
            .unwrap();
        let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });
        assert_eq!(post(&server, None, list.clone()).await.status(), 401);
        assert_eq!(
            post(&server, Some("Bearer wrong!"), list.clone())
                .await
                .status(),
            401
        );

        let listed: Value = post(&server, Some("Bearer secret"), list)
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(listed["result"]["tools"][0]["name"], "echo");
        assert_eq!(listed["result"]["tools"][0]["description"], "Says it back");

        let call = |arguments: Value| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "echo", "arguments": arguments } });
        let called: Value = post(
            &server,
            Some("Bearer secret"),
            call(json!({ "text": "hi" })),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(called["result"]["content"][0]["text"], "hi");
        assert_eq!(called["result"]["isError"], false);
        let failed: Value = post(&server, Some("Bearer secret"), call(json!({})))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(failed["result"]["content"][0]["text"], "text is required");
        assert_eq!(failed["result"]["isError"], true);
    }

    #[tokio::test]
    async fn a_taken_port_falls_back_to_a_free_one() {
        let first = McpServer::start(Vec::new(), 0, "a".into()).await.unwrap();
        let second = McpServer::start(Vec::new(), first.port, "b".into())
            .await
            .unwrap();
        assert_ne!(first.port, second.port);
    }

    #[test]
    fn env_reaches_the_server_from_claude_and_codex() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let server = runtime
            .block_on(McpServer::start(Vec::new(), 0, "tok".into()))
            .unwrap();
        let env: std::collections::HashMap<_, _> = server.env().into_iter().collect();
        let url = server.url();
        assert_eq!(env["TREEIX_MCP_URL"], url);
        assert_eq!(env["TREEIX_MCP_TOKEN"], "tok");
        let claude: Value = serde_json::from_str(&env["TREEIX_CLAUDE_MCP"]).unwrap();
        assert_eq!(claude["mcpServers"]["treeix"]["url"], url.as_str());
        assert_eq!(
            claude["mcpServers"]["treeix"]["headers"]["Authorization"],
            "Bearer tok"
        );
        assert_eq!(
            env["TREEIX_CODEX_MCP"],
            format!(
                "mcp_servers.treeix={{url=\"{url}\",http_headers={{\"Authorization\"=\"Bearer tok\"}}}}"
            )
        );
    }

    #[test]
    fn install_status_compares_url_and_token() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let server = runtime
            .block_on(McpServer::start(Vec::new(), 0, "tok".into()))
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        // The codex config is looked up under CODEX_HOME when set
        assert!(std::env::var_os("CODEX_HOME").is_none());
        assert!(install_status(home.path(), &server).is_empty());

        let claude = json!({ "mcpServers": { "treeix": {
            "type": "http", "url": server.url(), "headers": { "Authorization": "Bearer tok" }
        } } });
        std::fs::write(home.path().join(".claude.json"), claude.to_string()).unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::write(
            home.path().join(".codex/config.toml"),
            "[mcp_servers.treeix]\nurl = \"http://127.0.0.1:1/mcp\"\n",
        )
        .unwrap();
        assert_eq!(
            install_status(home.path(), &server),
            [
                McpInstall {
                    agent: McpAgent::Claude,
                    state: McpInstallState::Installed
                },
                McpInstall {
                    agent: McpAgent::Codex,
                    state: McpInstallState::Outdated
                },
            ]
        );
    }
}
