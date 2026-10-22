//! Schedule triggers and sleep. A minute tick fires routines whose `next_fire` passed. Sleep shows as the wall
//! clock running ahead of the monotonic one (neither `Instant` on macOS nor CLOCK_MONOTONIC on Linux advances
//! while suspended), so no IOKit / logind / pmset: on wake, schedules that came due while asleep run once
//! (`WhileAsleep::CatchUp`, cause CatchUp) or are recorded Skipped. Owner: R6

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use treeix_core::routines::next_fire;
use treeix_proto::routines::{Routine, RoutineId, RunCause, Trigger, WhileAsleep};

/// A gap between the clocks past this is sleep; less is drift and a busy machine
const SLEEP_GAP: Duration = Duration::from_secs(60);

/// A run the tick wants started
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub routine: RoutineId,
    /// Unix ms it was due
    pub due_at: u64,
    pub cause: RunCause,
    /// Came due while asleep and the routine skips those
    pub skip: bool,
}

/// Wall and monotonic clocks at the last tick
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub wall: SystemTime,
    pub mono: Instant,
}

impl Clock {
    pub fn now() -> Self {
        Self {
            wall: SystemTime::now(),
            mono: Instant::now(),
        }
    }

    pub fn wall_ms(&self) -> u64 {
        self.wall
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }

    /// How long the computer slept since `self`, when it did for over a minute
    pub fn slept(&self, now: &Clock) -> Option<Duration> {
        let wall = now.wall.duration_since(self.wall).ok()?;
        let gap = wall.saturating_sub(now.mono.saturating_duration_since(self.mono));
        (gap > SLEEP_GAP).then_some(gap)
    }
}

/// The schedule routines due in `(last_ms, now_ms]`, one per routine however many fire times passed;
/// `asleep` marks the window as slept through
pub fn due(routines: &[Routine], last_ms: u64, now_ms: u64, asleep: bool) -> Vec<Due> {
    routines
        .iter()
        .filter(|r| r.enabled)
        .filter_map(|routine| {
            let Trigger::Schedule { cron } = &routine.trigger else {
                return None;
            };
            let mut after = last_ms.max(routine.created_at);
            let mut due_at = None;
            while let Ok(next) = next_fire(cron, after) {
                if next > now_ms {
                    break;
                }
                due_at = Some(next);
                after = next;
                if !asleep {
                    break;
                }
            }
            Some(Due {
                routine: routine.id.clone(),
                due_at: due_at?,
                cause: if asleep {
                    RunCause::CatchUp
                } else {
                    RunCause::Schedule
                },
                skip: asleep && routine.asleep == WhileAsleep::Skip,
            })
        })
        .collect()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use treeix_proto::chat::ChatAgent;
    use treeix_proto::routines::{Budget, RoutinePermission, RoutinePlace, RoutineResult};

    pub const MINUTE: u64 = 60_000;
    /// 2026-10-22 09:00 UTC, a quarter hour in every time zone
    pub const T0: u64 = 1_792_659_600_000;

    pub fn routine(id: &str, cron: &str, asleep: WhileAsleep) -> Routine {
        Routine {
            id: id.into(),
            name: id.into(),
            enabled: true,
            agent: ChatAgent::Claude,
            prompt: "go".into(),
            trigger: Trigger::Schedule { cron: cron.into() },
            repo: Some("/tmp".into()),
            place: RoutinePlace::Root,
            permission: RoutinePermission::ReadOnly,
            allowed_tools: vec![],
            budget: Budget::default(),
            result: RoutineResult::Local,
            may_comment: false,
            asleep,
            created_at: 0,
        }
    }

    #[test]
    fn a_fire_time_on_the_window_edge_belongs_to_the_window_it_ends() {
        let routines = [routine("q", "*/15 * * * *", WhileAsleep::CatchUp)];
        let due_now = due(&routines, T0 - MINUTE, T0, false);
        assert_eq!(due_now.len(), 1);
        assert_eq!(due_now[0].due_at, T0);
        assert_eq!(due_now[0].cause, RunCause::Schedule);
        assert!(due(&routines, T0, T0 + MINUTE, false).is_empty());
        assert!(due(&routines, T0 + MINUTE, T0 + 14 * MINUTE, false).is_empty());
    }

    #[test]
    fn disabled_and_unscheduled_routines_never_come_due() {
        let mut off = routine("off", "* * * * *", WhileAsleep::CatchUp);
        off.enabled = false;
        let mut hook = routine("hook", "* * * * *", WhileAsleep::CatchUp);
        hook.trigger = Trigger::Webhook { token: "t".into() };
        assert!(due(&[off, hook], T0, T0 + 10 * MINUTE, false).is_empty());
    }

    #[test]
    fn a_routine_does_not_fire_for_times_before_it_existed() {
        let mut new = routine("new", "*/15 * * * *", WhileAsleep::CatchUp);
        new.created_at = T0 + MINUTE;
        assert!(due(&[new], T0 - MINUTE, T0 + 2 * MINUTE, false).is_empty());
    }

    #[test]
    fn a_long_sleep_catches_up_once_at_the_last_missed_time_or_skips() {
        let routines = [
            routine("catch", "*/15 * * * *", WhileAsleep::CatchUp),
            routine("skip", "*/15 * * * *", WhileAsleep::Skip),
        ];
        let woke = T0 + 120 * MINUTE + 30_000;
        let missed = due(&routines, T0, woke, true);
        assert_eq!(missed.len(), 2);
        for due in &missed {
            assert_eq!(due.due_at, T0 + 120 * MINUTE);
            assert_eq!(due.cause, RunCause::CatchUp);
            assert_eq!(due.skip, due.routine == "skip");
        }
    }

    #[test]
    fn sleep_is_the_wall_clock_running_ahead_of_the_monotonic_one() {
        let before = Clock::now();
        let busy = Clock {
            wall: before.wall + Duration::from_secs(50),
            mono: before.mono + Duration::from_secs(20),
        };
        assert_eq!(before.slept(&busy), None);
        let woke = Clock {
            wall: before.wall + Duration::from_secs(7200),
            mono: before.mono + Duration::from_secs(20),
        };
        assert_eq!(before.slept(&woke), Some(Duration::from_secs(7180)));
        let set_back = Clock {
            wall: before.wall - Duration::from_secs(7200),
            mono: before.mono + Duration::from_secs(20),
        };
        assert_eq!(before.slept(&set_back), None);
    }
}
