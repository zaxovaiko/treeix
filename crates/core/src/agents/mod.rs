//! Agents (Claude Code, Codex): hook settings, transcripts, codex rollouts, listening ports, token usage and
//! plan limits. Port of the Electron app's terminal, agent-usage and usage-limits plugins. Owner: A3

pub mod codex;
pub mod hooks;
pub mod limits;
pub mod ports;
pub mod transcripts;
pub mod usage;

use serde_json::Value;

/// A JSONL line as an object; anything else is None
fn parse_line(line: &str) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str(line) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// A non-negative finite number, else 0
fn count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .map_or(0, |n| n.max(0.0) as u64)
}

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

/// Unix millis of an RFC 3339 timestamp
fn timestamp_ms(timestamp: &str) -> Option<u64> {
    let at: jiff::Timestamp = timestamp.parse().ok()?;
    u64::try_from(at.as_millisecond()).ok()
}

/// YYYY-MM-DD in the local time zone
fn local_day(millis: i64) -> Option<String> {
    let at = jiff::Timestamp::from_millisecond(millis).ok()?;
    Some(at.to_zoned(jiff::tz::TimeZone::system()).date().to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Agent ids end up in file names: uuids and the like only
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
