//! The app side of Claude's status hooks (ptyd watches the files): the settings that make Claude write
//! `input|working|done` and its statusline JSON into `$TREEIX_AGENT_STATUS`. Port of the Electron terminal plugin's
//! hooks.ts and the usage-limits plugin's claudeStatus.ts

use serde_json::{Map, Value, json};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Each session's last statusline input is kept as `usage-<session>`
pub const USAGE_PREFIX: &str = "usage-";
/// The newest statusline input that carried rate limits, any session's
pub const LATEST: &str = "latest.json";
const BRIDGE: &str = "statusline.sh";

/// Where hooks report; ptyd sets `TREEIX_AGENT_STATUS` to the same folder
pub fn status_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-status")
}

/// Claude runs hooks without a terminal, so they write the status to a file named after the session; a failed
/// write must never show as a hook error
fn report(status: &str) -> Value {
    let command = format!(
        r#"[ -n "$TREEIX_SESSION" ] && printf {status} > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION" 2>/dev/null; true"#
    );
    json!({ "hooks": [{ "type": "command", "command": command }] })
}

/// Tools that wait for the user, a question or a plan to approve, report input; the rest report work. The
/// tool's JSON comes on stdin
const TOOL_REPORT: &str = r#"[ -n "$TREEIX_SESSION" ] && { if grep -Eq '"tool_name": ?"(AskUserQuestion|ExitPlanMode)"'; then printf input; else printf working; fi > "$TREEIX_AGENT_STATUS/$TREEIX_SESSION"; } 2>/dev/null; true"#;

/// `settings` (Claude `--settings` JSON, or anything unreadable) with hooks that report when it needs the user,
/// works again, or ends its turn
pub fn with_status_hooks(settings: &str) -> String {
    let mut parsed: Map<String, Value> = match serde_json::from_str(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let working = report("working");
    parsed.insert(
        "hooks".into(),
        json!({
            // Not idle_prompt: Claude's reminder a minute after its turn ended is no question
            "Notification": [with_matcher("permission_prompt|elicitation_dialog", report("input"))],
            "UserPromptSubmit": [working],
            "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": TOOL_REPORT }] }],
            "PostToolUse": [with_matcher("*", working)],
            "Stop": [report("done")],
        }),
    );
    Value::Object(parsed).to_string()
}

fn with_matcher(matcher: &str, mut hook: Value) -> Value {
    hook["matcher"] = matcher.into();
    hook
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Claude hands the statusline command its session state, rate limits included. The bridge keeps the newest
/// input with limits in `status_file`, each session's own as `usage-<session>`, then runs the user's statusline
pub fn bridge_script(status_file: &Path) -> String {
    let file = status_file.to_string_lossy();
    let tmp = shell_quote(&format!("{file}.tmp"));
    let file = shell_quote(&file);
    format!(
        r#"#!/bin/sh
umask 077
input=$(cat)
case "$input" in
  *'"rate_limits"'*) printf '%s' "$input" > {tmp} && mv -f {tmp} {file} ;;
esac
if [ -n "$TREEIX_AGENT_STATUS" ] && [ -n "$TREEIX_SESSION" ]; then
  printf '%s' "$input" > "$TREEIX_AGENT_STATUS/{USAGE_PREFIX}$TREEIX_SESSION" 2>/dev/null
fi
if [ -n "$TREEIX_PREVIOUS_STATUSLINE" ]; then
  printf '%s' "$input" | sh -c "$TREEIX_PREVIOUS_STATUSLINE"
fi
"#
    )
}

#[derive(Debug, PartialEq)]
pub struct StatusLine {
    pub command: String,
    pub padding: Option<f64>,
}

/// The command statusline from the user's Claude settings, which the bridge keeps showing
pub fn user_status_line(settings: &Value) -> Option<StatusLine> {
    let line = settings.get("statusLine")?;
    let command = line.get("command")?.as_str()?;
    (!command.trim().is_empty()).then(|| StatusLine {
        command: command.to_owned(),
        padding: line.get("padding").and_then(Value::as_f64),
    })
}

/// Writes the bridge into `status_dir` and returns the `--settings` JSON for a claude session (statusline and
/// hooks) and the env the bridge reads. `claude_dir` is `~/.claude`
pub fn claude_settings(
    status_dir: &Path,
    claude_dir: &Path,
) -> Result<(String, Vec<(String, String)>), String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(status_dir)
        .map_err(|e| e.to_string())?;
    let script = status_dir.join(BRIDGE);
    // Renamed into place: a running claude may start the old one meanwhile
    let tmp = status_dir.join(format!("{BRIDGE}.tmp"));
    fs::write(&tmp, bridge_script(&status_dir.join(LATEST))).map_err(|e| e.to_string())?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &script).map_err(|e| e.to_string())?;
    let script = script.to_string_lossy();
    let user: Value = fs::read_to_string(claude_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let previous = user_status_line(&user).filter(|line| !line.command.contains(&*script));
    let padding = previous
        .as_ref()
        .and_then(|line| line.padding)
        .unwrap_or(0.0);
    let settings = json!({
        "statusLine": { "type": "command", "command": shell_quote(&script), "padding": padding }
    });
    let env = vec![(
        "TREEIX_PREVIOUS_STATUSLINE".to_owned(),
        previous.map(|line| line.command).unwrap_or_default(),
    )];
    Ok((with_status_hooks(&settings.to_string()), env))
}

/// The session's cost so far, from the statusline JSON Claude wrote to `<status_dir>/usage-<session>`
pub fn claude_cost(status_dir: &Path, session: &str) -> Option<f64> {
    if !super::safe_id(session) {
        return None;
    }
    let text = fs::read_to_string(status_dir.join(format!("{USAGE_PREFIX}{session}"))).ok()?;
    let input: Value = serde_json::from_str(&text).ok()?;
    input.get("cost")?.get("total_cost_usd")?.as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn sh(script: &str, input: &str, env: &[(&str, &Path)]) -> String {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
    }

    #[test]
    fn with_status_hooks_keeps_other_settings_and_reports_input_on_notifications() {
        let settings: Value = serde_json::from_str(&with_status_hooks(
            r#"{"statusLine":{"type":"command","command":"x"}}"#,
        ))
        .unwrap();
        assert_eq!(settings["statusLine"]["command"], "x");
        let notification = &settings["hooks"]["Notification"][0];
        assert!(
            notification["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("printf input")
        );
        assert!(
            !notification["matcher"]
                .as_str()
                .unwrap()
                .contains("idle_prompt")
        );
        assert!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("printf done")
        );
        let broken: Value = serde_json::from_str(&with_status_hooks("not json")).unwrap();
        assert_eq!(broken["hooks"]["PreToolUse"][0]["matcher"], "*");
    }

    #[test]
    fn a_question_or_a_plan_to_approve_reports_input_other_tools_report_work() {
        let settings: Value = serde_json::from_str(&with_status_hooks("{}")).unwrap();
        let command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_owned();
        let folder = tempfile::tempdir().unwrap();
        let run = |input: &str| {
            Command::new("sh")
                .args(["-c", &command])
                .env("TREEIX_SESSION", "s")
                .env("TREEIX_AGENT_STATUS", folder.path())
                .stdin(Stdio::piped())
                .spawn()
                .and_then(|mut child| {
                    child.stdin.take().unwrap().write_all(input.as_bytes())?;
                    child.wait()
                })
                .unwrap();
            fs::read_to_string(folder.path().join("s")).unwrap()
        };
        assert_eq!(
            run(r#"{"tool_name":"AskUserQuestion","tool_input":{}}"#),
            "input"
        );
        assert_eq!(
            run(r#"{"session_id": "x", "tool_name": "ExitPlanMode"}"#),
            "input"
        );
        assert_eq!(
            run(r#"{"tool_name":"Bash","tool_input":{"command":"echo AskUserQuestion"}}"#),
            "working"
        );
    }

    #[test]
    fn user_status_line_picks_the_command_status_line_only() {
        let line = json!({ "statusLine": { "type": "command", "command": "bunx ccstatusline", "padding": 2 } });
        assert_eq!(
            user_status_line(&line),
            Some(StatusLine {
                command: "bunx ccstatusline".into(),
                padding: Some(2.0)
            })
        );
        assert_eq!(
            user_status_line(&json!({ "statusLine": { "command": "  " } })),
            None
        );
        assert_eq!(user_status_line(&Value::Null), None);
    }

    #[test]
    fn bridge_keeps_inputs_with_rate_limits_and_still_runs_the_previous_status_line() {
        let folder = tempfile::Builder::new()
            .prefix("treeix bridge's ")
            .tempdir()
            .unwrap();
        let status_file = folder.path().join("latest.json");
        let script = folder.path().join("statusline.sh");
        fs::write(&script, bridge_script(&status_file)).unwrap();
        let run = |input: &str, previous: &str| {
            let quoted = shell_quote(&script.to_string_lossy());
            sh(
                &format!(
                    "TREEIX_PREVIOUS_STATUSLINE={} sh {quoted}",
                    shell_quote(previous)
                ),
                input,
                &[],
            )
        };
        assert_eq!(run(r#"{"model":{}}"#, ""), "");
        assert!(!status_file.exists());
        let with_limits = r#"{"rate_limits":{"five_hour":{"used_percentage":8}}}"#;
        assert_eq!(
            run(with_limits, r#"cat; echo " shown""#),
            format!("{with_limits} shown\n")
        );
        assert_eq!(fs::read_to_string(&status_file).unwrap(), with_limits);
    }

    #[test]
    fn bridge_keeps_each_treeix_session_its_own_input_for_its_cost() {
        let folder = tempfile::Builder::new()
            .prefix("treeix bridge ")
            .tempdir()
            .unwrap();
        let script = folder.path().join("statusline.sh");
        fs::write(&script, bridge_script(&folder.path().join("latest.json"))).unwrap();
        let input = r#"{"cost":{"total_cost_usd":1.25}}"#;
        sh(
            &format!(
                "TREEIX_SESSION=abc sh {}",
                shell_quote(&script.to_string_lossy())
            ),
            input,
            &[("TREEIX_AGENT_STATUS", folder.path())],
        );
        assert_eq!(
            fs::read_to_string(folder.path().join("usage-abc")).unwrap(),
            input
        );
        assert_eq!(claude_cost(folder.path(), "abc"), Some(1.25));
        assert_eq!(claude_cost(folder.path(), "../abc"), None);
    }

    #[test]
    fn claude_settings_chains_the_users_status_line() {
        let status = tempfile::tempdir().unwrap();
        let claude = tempfile::tempdir().unwrap();
        fs::write(
            claude.path().join("settings.json"),
            r#"{"statusLine":{"type":"command","command":"ccline","padding":1}}"#,
        )
        .unwrap();
        let (settings, env) = claude_settings(status.path(), claude.path()).unwrap();
        let settings: Value = serde_json::from_str(&settings).unwrap();
        assert!(
            settings["statusLine"]["command"]
                .as_str()
                .unwrap()
                .ends_with("statusline.sh'")
        );
        assert_eq!(settings["statusLine"]["padding"], 1.0);
        assert!(settings["hooks"]["Stop"].is_array());
        assert_eq!(
            env,
            [("TREEIX_PREVIOUS_STATUSLINE".to_owned(), "ccline".to_owned())]
        );
        assert!(status.path().join("statusline.sh").is_file());
    }
}
