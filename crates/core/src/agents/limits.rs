//! Plan limits (5-hour and weekly windows) of Claude (statusline, LimitBar, the Claude desktop app) and Codex
//! (rollout rate_limits). Port of packages/plugins/usage-limits/main

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub used_percent: f64,
    /// Unix millis; None when unknown or already reset
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLimits {
    pub five_hour: Option<LimitWindow>,
    pub weekly: Option<LimitWindow>,
    /// When the numbers were captured, unix millis
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub claude: Option<AgentLimits>,
    pub codex: Option<AgentLimits>,
}

// LimitBar's Claude Code status line bridge caches the subscription windows here
const LIMIT_BAR: &str = "Library/Application Support/LimitBar/claude/latest.json";
// The Claude desktop app samples plan usage every few minutes while it runs
const CLAUDE_DESKTOP_USAGE: &str = "Library/Application Support/Claude/plan-usage-history.json";
const TAIL_BYTES: u64 = 256 * 1024;
const RECENT_ROLLOUTS: usize = 5;
const FIVE_HOURS_MIN: f64 = 300.0;
const WEEK_MIN: f64 = 10_080.0;

fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// A window whose reset time has passed starts over at 0%
pub fn to_window(
    used_percent: Option<f64>,
    resets_at_seconds: Option<f64>,
    now: u64,
) -> Option<LimitWindow> {
    let used = used_percent?;
    let resets_at = resets_at_seconds.map(|s| (s * 1000.0) as u64);
    Some(match resets_at {
        Some(at) if at <= now => LimitWindow {
            used_percent: 0.0,
            resets_at: None,
        },
        _ => LimitWindow {
            used_percent: used.round(),
            resets_at,
        },
    })
}

/// LimitBar's snapshot: camelCase windows, seconds
pub fn parse_claude_limits(raw: &Value, now: u64) -> Option<AgentLimits> {
    raw.as_object()?;
    let window = |value: Option<&Value>| {
        let value = value.filter(|v| v.is_object())?;
        to_window(
            num(value.get("usedPercent")),
            num(value.get("resetsAt")),
            now,
        )
    };
    Some(AgentLimits {
        five_hour: window(raw.get("fiveHour")),
        weekly: window(raw.get("weekly")),
        updated_at: num(raw.get("capturedAt")).map(|s| (s * 1000.0).round() as u64),
    })
}

/// Claude Code's status line input: `rate_limits` windows with 0-100 `used_percentage` and epoch-second `resets_at`
pub fn parse_status_line_limits(raw: &Value, updated_at: u64, now: u64) -> Option<AgentLimits> {
    let limits = raw.get("rate_limits").filter(|l| l.is_object())?;
    let window = |value: Option<&Value>| {
        let value = value.filter(|v| v.is_object())?;
        to_window(
            num(value.get("used_percentage")),
            num(value.get("resets_at")),
            now,
        )
    };
    Some(AgentLimits {
        five_hour: window(limits.get("five_hour")),
        weekly: window(limits.get("seven_day")),
        updated_at: Some(updated_at),
    })
}

/// Newest sample of the Claude desktop app's usage history: `t` in ms, `u.fh`/`u.sd` percents, no reset times
pub fn parse_desktop_usage(raw: &Value) -> Option<AgentLimits> {
    let latest = raw
        .get("samples")?
        .as_array()?
        .iter()
        .rfind(|s| s.is_object())?;
    let usage = latest.get("u").filter(|u| u.is_object())?;
    let updated_at = num(latest.get("t"))?;
    let window = |percent: Option<f64>| {
        percent.map(|p| LimitWindow {
            used_percent: p.round(),
            resets_at: None,
        })
    };
    Some(AgentLimits {
        five_hour: window(num(usage.get("fh"))),
        weekly: window(num(usage.get("sd"))),
        updated_at: Some(updated_at as u64),
    })
}

/// Newest reading wins; a window without a reset time borrows one from an older reading that hasn't reset yet
pub fn newest_limits(candidates: &[Option<AgentLimits>], now: u64) -> Option<AgentLimits> {
    let mut sorted: Vec<AgentLimits> = candidates.iter().flatten().copied().collect();
    sorted.sort_by_key(|l| std::cmp::Reverse(l.updated_at.unwrap_or(0)));
    let newest = *sorted.first()?;
    let reset_for = |window: Option<LimitWindow>, pick: fn(&AgentLimits) -> Option<LimitWindow>| {
        let mut window = window?;
        if window.resets_at.is_none() {
            window.resets_at = sorted
                .iter()
                .filter_map(|l| pick(l)?.resets_at)
                .find(|&at| at > now);
        }
        Some(window)
    };
    Some(AgentLimits {
        five_hour: reset_for(newest.five_hour, |l| l.five_hour),
        weekly: reset_for(newest.weekly, |l| l.weekly),
        updated_at: newest.updated_at,
    })
}

/// Finds the newest `rate_limits` payload in Codex rollout lines
pub fn parse_codex_limits<'a>(
    lines: impl DoubleEndedIterator<Item = &'a str>,
    now: u64,
) -> Option<AgentLimits> {
    lines
        .rev()
        .filter(|l| l.contains("\"rate_limits\""))
        .find_map(|line| {
            let event: Value = serde_json::from_str(line).ok()?;
            let limits = event
                .get("payload")?
                .get("rate_limits")
                .filter(|l| l.is_object())?;
            let windows: Vec<&Value> = ["primary", "secondary"]
                .iter()
                .filter_map(|key| limits.get(key).filter(|w| w.is_object()))
                .collect();
            let by_length = |minutes: f64| {
                let window = windows
                    .iter()
                    .find(|w| num(w.get("window_minutes")) == Some(minutes))?;
                to_window(
                    num(window.get("used_percent")),
                    num(window.get("resets_at")),
                    now,
                )
            };
            Some(AgentLimits {
                five_hour: by_length(FIVE_HOURS_MIN),
                weekly: by_length(WEEK_MIN),
                updated_at: event
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(super::timestamp_ms),
            })
        })
}

fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let at = fs::metadata(path).ok()?.modified().ok()?;
    Some(at.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Treeix's status line bridge, LimitBar's cache and the Claude desktop app; whichever saw usage last
fn read_claude(home: &Path, status_file: &Path, now: u64) -> Option<AgentLimits> {
    let status = mtime_ms(status_file)
        .and_then(|at| parse_status_line_limits(&read_json(status_file), at, now));
    newest_limits(
        &[
            status,
            parse_claude_limits(&read_json(&home.join(LIMIT_BAR)), now),
            parse_desktop_usage(&read_json(&home.join(CLAUDE_DESKTOP_USAGE))),
        ],
        now,
    )
}

fn newest_names(dir: &Path) -> Vec<PathBuf> {
    let mut names: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    names.sort_by(|a, b| b.cmp(a));
    names
}

/// Rollouts live in sessions/YYYY/MM/DD; only the newest day folders are read. Codex compresses finished
/// rollouts, and older ones once on upgrade
fn recent_rollouts(sessions: &Path, limit: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for year in newest_names(sessions) {
        for month in newest_names(&year) {
            for day in newest_names(&month) {
                let mut day_files: Vec<(u64, PathBuf)> = newest_names(&day)
                    .into_iter()
                    .filter(|p| {
                        let name = p.to_string_lossy();
                        name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
                    })
                    .map(|p| (mtime_ms(&p).unwrap_or(0), p))
                    .collect();
                day_files.sort_by_key(|f| std::cmp::Reverse(f.0));
                files.extend(day_files.into_iter().map(|(_, p)| p));
                if files.len() >= limit {
                    files.truncate(limit);
                    return files;
                }
            }
        }
    }
    files
}

/// The end of a rollout, or all of a compressed one.
/// ponytail: re-read each call, cache by mtime and size if polling shows up in a profile
fn tail(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    if path.extension().is_some_and(|e| e == "zst") {
        zstd::stream::read::Decoder::new(file)
            .ok()?
            .read_to_end(&mut bytes)
            .ok()?;
    } else {
        let size = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES)))
            .ok()?;
        file.read_to_end(&mut bytes).ok()?;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_codex(home: &Path, now: u64) -> Option<AgentLimits> {
    recent_rollouts(&home.join(".codex/sessions"), RECENT_ROLLOUTS)
        .iter()
        .find_map(|path| parse_codex_limits(tail(path)?.lines(), now))
}

/// The freshest numbers of each agent; `status_file` is where the statusline bridge writes Claude's
pub fn usage_limits(home: &Path, status_file: &Path) -> UsageLimits {
    let now = super::now_ms();
    UsageLimits {
        claude: read_claude(home, status_file, now),
        codex: read_codex(home, now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: u64 = 1_789_590_000_000;

    fn window(used_percent: f64, resets_at: Option<u64>) -> Option<LimitWindow> {
        Some(LimitWindow {
            used_percent,
            resets_at,
        })
    }

    #[test]
    fn to_window_resets_expired_windows() {
        assert_eq!(
            to_window(Some(35.4), Some(1_789_598_400.0), NOW),
            window(35.0, Some(1_789_598_400_000))
        );
        assert_eq!(
            to_window(Some(80.0), Some(1_789_500_000.0), NOW),
            window(0.0, None)
        );
        assert_eq!(to_window(None, Some(1.0), NOW), None);
    }

    #[test]
    fn parse_claude_limits_reads_the_limit_bar_snapshot() {
        let limits = parse_claude_limits(
            &json!({ "capturedAt": 1_789_590_351.7, "fiveHour": { "resetsAt": 1_789_598_400, "usedPercent": 35 }, "weekly": { "resetsAt": 1_789_758_000, "usedPercent": 28.000000000000004 } }),
            NOW,
        )
        .unwrap();
        assert_eq!(limits.five_hour.unwrap().used_percent, 35.0);
        assert_eq!(limits.weekly.unwrap().used_percent, 28.0);
        assert_eq!(limits.updated_at, Some(1_789_590_351_700));
        assert_eq!(parse_claude_limits(&json!("nope"), NOW), None);
    }

    #[test]
    fn parse_codex_limits_takes_the_newest_rate_limits_event_and_matches_windows_by_length() {
        let event = |used: u64| {
            json!({
                "timestamp": "2026-09-16T19:40:00.000Z", "type": "event_msg",
                "payload": { "type": "token_count", "rate_limits": {
                    "primary": { "used_percent": used, "window_minutes": 300, "resets_at": 1_789_597_950 },
                    "secondary": { "used_percent": 5, "window_minutes": 10_080, "resets_at": 1_789_922_495 }
                } }
            })
            .to_string()
        };
        let lines = [
            event(10),
            r#"{"type":"other"}"#.into(),
            event(25),
            "not json".into(),
            String::new(),
        ];
        let limits = parse_codex_limits(lines.iter().map(String::as_str), NOW).unwrap();
        assert_eq!(limits.five_hour, window(25.0, Some(1_789_597_950_000)));
        assert_eq!(limits.weekly.unwrap().used_percent, 5.0);
        assert_eq!(
            parse_codex_limits([r#"{"type":"other"}"#].into_iter(), NOW),
            None
        );
    }

    #[test]
    fn parse_status_line_limits_reads_claude_code_status_line_rate_limits() {
        let input = json!({
            "model": { "display_name": "Opus" },
            "rate_limits": { "five_hour": { "used_percentage": 8.4, "resets_at": 1_789_598_400 }, "seven_day": { "used_percentage": 33, "resets_at": 1_789_758_000 } }
        });
        assert_eq!(
            parse_status_line_limits(&input, 1_789_589_000_000, NOW),
            Some(AgentLimits {
                five_hour: window(8.0, Some(1_789_598_400_000)),
                weekly: window(33.0, Some(1_789_758_000_000)),
                updated_at: Some(1_789_589_000_000),
            })
        );
        assert_eq!(
            parse_status_line_limits(&json!({ "model": {} }), 1, NOW),
            None
        );
    }

    #[test]
    fn parse_desktop_usage_takes_the_newest_sample_and_newest_limits_borrows_reset_times() {
        let desktop = parse_desktop_usage(&json!({
            "version": 2,
            "samples": [{ "t": 1, "org": "o", "u": { "fh": 3, "sd": 30 } }, { "t": 1_789_589_500_000_u64, "org": "o", "u": { "fh": 10.2, "sd": 33 } }]
        }));
        assert_eq!(
            desktop,
            Some(AgentLimits {
                five_hour: window(10.0, None),
                weekly: window(33.0, None),
                updated_at: Some(1_789_589_500_000),
            })
        );
        assert_eq!(parse_desktop_usage(&json!({ "samples": [] })), None);

        let older = AgentLimits {
            five_hour: window(4.0, Some(1_789_598_400_000)),
            weekly: window(32.0, Some(1_789_500_000_000)),
            updated_at: Some(1_789_580_000_000),
        };
        assert_eq!(
            newest_limits(&[Some(older), desktop, None], NOW),
            Some(AgentLimits {
                five_hour: window(10.0, Some(1_789_598_400_000)),
                // The older weekly reset already passed, so it isn't borrowed
                weekly: window(33.0, None),
                updated_at: Some(1_789_589_500_000),
            })
        );
        assert_eq!(newest_limits(&[None], NOW), None);
    }

    #[test]
    fn usage_limits_reads_the_newest_codex_rollout_compressed_or_not() {
        let home = tempfile::tempdir().unwrap();
        let day = home.path().join(".codex/sessions/2026/10/22");
        fs::create_dir_all(&day).unwrap();
        let resets = super::super::now_ms() / 1000 + 3600;
        let event = json!({ "payload": { "rate_limits": { "primary": { "used_percent": 42, "window_minutes": 300, "resets_at": resets } } } });
        let compressed = zstd::encode_all(event.to_string().as_bytes(), 0).unwrap();
        fs::write(day.join("rollout-a.jsonl.zst"), compressed).unwrap();
        let limits = usage_limits(home.path(), &home.path().join("missing.json"));
        assert_eq!(limits.codex.unwrap().five_hour.unwrap().used_percent, 42.0);
        assert_eq!(limits.claude, None);
    }
}
