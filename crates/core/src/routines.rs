//! Routines shared by ptyd (the engine) and the app (the editor): the wire types from treeix_proto and the
//! schedule's cron, read in local time.

pub use treeix_proto::routines::*;

use croner::Cron;
use jiff::{Timestamp, Zoned, tz::TimeZone};
use std::str::FromStr;

/// The schedule after `after_ms` (unix ms, exclusive) in the system time zone; Err names what is wrong with `cron`
pub fn next_fire(cron: &str, after_ms: u64) -> Result<u64, String> {
    next_fire_in(cron, after_ms, TimeZone::system())
}

fn next_fire_in(cron: &str, after_ms: u64, tz: TimeZone) -> Result<u64, String> {
    let cron = Cron::from_str(cron).map_err(|e| format!("invalid schedule: {e}"))?;
    let after = i64::try_from(after_ms).map_err(|e| e.to_string())?;
    let after = Zoned::new(
        Timestamp::from_millisecond(after).map_err(|e| e.to_string())?,
        tz,
    );
    let next = cron
        .find_next_occurrence(&after, false)
        .map_err(|e| format!("invalid schedule: {e}"))?;
    u64::try_from(next.timestamp().as_millisecond()).map_err(|e| e.to_string())
}

/// The next `count` fire times after `after_ms`, for the editor's preview
pub fn next_fires(cron: &str, after_ms: u64, count: usize) -> Result<Vec<u64>, String> {
    let mut times = Vec::with_capacity(count);
    let mut after = after_ms;
    for _ in 0..count {
        after = next_fire(cron, after)?;
        times.push(after);
    }
    Ok(times)
}

/// `routine/<name>-<YYYYMMDD-HHMM>` in local time: a fresh branch for a `NewWorktree` run
pub fn run_branch(name: &str, at_ms: u64) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let stamp = i64::try_from(at_ms)
        .ok()
        .and_then(|ms| Timestamp::from_millisecond(ms).ok())
        .map(|at| {
            at.to_zoned(TimeZone::system())
                .strftime("%Y%m%d-%H%M")
                .to_string()
        })
        .unwrap_or_default();
    format!(
        "routine/{}-{stamp}",
        if slug.is_empty() { "run" } else { slug }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_york() -> TimeZone {
        TimeZone::get("America/New_York").unwrap()
    }

    fn at(zoned: &str) -> u64 {
        zoned.parse::<Zoned>().unwrap().timestamp().as_millisecond() as u64
    }

    #[test]
    fn the_repeated_hour_in_autumn_fires_once() {
        let tz = new_york();
        let first = next_fire_in(
            "30 1 * * *",
            at("2026-10-31T12:00-04:00[America/New_York]"),
            tz.clone(),
        )
        .unwrap();
        assert_eq!(first, at("2026-11-01T01:30-04:00[America/New_York]"));
        let second = next_fire_in("30 1 * * *", first, tz).unwrap();
        assert_eq!(second, at("2026-11-02T01:30-05:00[America/New_York]"));
    }

    #[test]
    fn the_skipped_hour_in_spring_still_fires_that_day() {
        let tz = new_york();
        let next = next_fire_in(
            "30 2 * * *",
            at("2026-03-07T12:00-05:00[America/New_York]"),
            tz.clone(),
        )
        .unwrap();
        let day = |ms: u64| {
            Timestamp::from_millisecond(ms as i64)
                .unwrap()
                .to_zoned(tz.clone())
                .date()
        };
        assert_eq!(day(next).to_string(), "2026-03-08");
        let after = next_fire_in("30 2 * * *", next, tz.clone()).unwrap();
        assert_eq!(day(after).to_string(), "2026-03-09");
    }

    #[test]
    fn run_branches_are_slugs_of_the_name() {
        let branch = run_branch("Review: PRs & CI!", 0);
        assert!(branch.starts_with("routine/review-prs-ci-"), "{branch}");
        assert!(crate::git::check_branch_name(&branch), "{branch}");
        assert!(run_branch("", 0).starts_with("routine/run-"));
    }

    #[test]
    fn weekday_mornings_skip_the_weekend() {
        // Friday 2026-10-23 10:00 UTC
        let friday = 1_792_749_600_000;
        let next = next_fire_in("0 9 * * 1-5", friday, TimeZone::UTC).unwrap();
        // Monday 2026-10-26 09:00 UTC
        assert_eq!(next, 1_793_005_200_000);
    }

    #[test]
    fn bad_patterns_say_so() {
        assert!(
            next_fire("every day", 0)
                .unwrap_err()
                .starts_with("invalid schedule")
        );
    }
}
