//! A short name for a chat from its first message, by Claude's smallest model, the way Claude Code names its
//! sessions (port of the Electron app's title.ts)

use super::Chat;
use crate::server::Daemon;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use treeix_proto::chat::ChatEvent;

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MESSAGE: usize = 2000;
// No MCP servers, hooks or settings to load: a bare one-shot answers in about 3s instead of 12s
const COMMAND: &str = "exec claude -p --model haiku --no-session-persistence --tools '' --strict-mcp-config --setting-sources ''";
const PROMPT: &str = "Name a coding chat that starts with the message below, like a short task title: 2 to 5 words, same language as the message, no quotes, no trailing punctuation. Reply with the name only.\n\nMessage:\n";

/// Set when the daemon was started from an agent; passed on, `claude` would think it is a nested session
fn is_agent_variable(name: &str) -> bool {
    name.starts_with("CLAUDE")
        || name.starts_with("MCP_")
        || name.starts_with("CODEX_")
        || name == "ANTHROPIC_BASE_URL"
        || name == "AI_AGENT"
}

/// The model's first line without the quotes or full stop it sometimes adds
fn bare_name(output: &str) -> String {
    output
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches(['"', '\'', '`'])
        .trim_end_matches(['"', '\'', '`', '.'])
        .to_owned()
}

async fn run(message: &str) -> Result<String, String> {
    let mut command = tokio::process::Command::new(super::agent::login_shell());
    command
        .arg("-lc")
        .arg(COMMAND)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (name, _) in std::env::vars().filter(|(name, _)| is_agent_variable(name)) {
        command.env_remove(name);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let input: String = PROMPT
        .chars()
        .chain(message.chars().take(MAX_MESSAGE))
        .collect();
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("claude exited with {}", output.status));
    }
    Ok(bare_name(&String::from_utf8_lossy(&output.stdout)))
}

/// Names the chat unless the agent named it first
pub(crate) async fn name(daemon: Arc<Daemon>, chat: Arc<Chat>, message: String) {
    match run(&message).await {
        Ok(title) if !title.is_empty() && chat.info().title.is_empty() => {
            chat.emit(&daemon, ChatEvent::Title { title });
        }
        Ok(_) => {}
        Err(e) => tracing::info!("naming chat {}: {e}", chat.id),
    }
}

#[cfg(test)]
mod tests {
    use super::bare_name;

    #[test]
    fn bare_name_takes_the_first_line_without_quotes_or_full_stop() {
        assert_eq!(
            bare_name("  \"Fix login redirect.\"\nmore\n"),
            "Fix login redirect"
        );
        assert_eq!(bare_name("`Add dark mode`"), "Add dark mode");
        assert_eq!(bare_name(""), "");
    }
}
