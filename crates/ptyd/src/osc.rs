//! Finds the OSC sequences alacritty ignores (7 cwd, 9 and 777 notifications, 9;4 progress) in raw PTY output.

use std::mem;
use treeix_proto::ProgressState;

const MAX_PAYLOAD: usize = 4096;

#[derive(Default)]
enum State {
    #[default]
    Ground,
    Esc,
    Osc(Vec<u8>),
    OscEsc(Vec<u8>),
}

#[derive(Debug, PartialEq)]
pub enum Osc {
    Cwd(String),
    Notify {
        title: String,
        body: String,
    },
    /// ConEmu's `9;4;<state>;<percent>`, which Windows Terminal, Ghostty and agents use
    Progress {
        state: ProgressState,
        percent: u8,
    },
}

/// Keeps its state between chunks, so a sequence split across reads is still found
#[derive(Default)]
pub struct OscScanner {
    state: State,
}

impl OscScanner {
    pub fn scan(&mut self, mut bytes: &[u8], found: &mut Vec<Osc>) {
        while let Some(&first) = bytes.first() {
            self.state = match mem::take(&mut self.state) {
                State::Ground => match bytes.iter().position(|&b| b == 0x1b) {
                    Some(i) => {
                        bytes = &bytes[i + 1..];
                        State::Esc
                    }
                    None => return,
                },
                State::Esc => {
                    bytes = &bytes[1..];
                    match first {
                        b']' => State::Osc(Vec::new()),
                        0x1b => State::Esc,
                        _ => State::Ground,
                    }
                }
                State::Osc(mut payload) => {
                    let end = bytes
                        .iter()
                        .position(|b| matches!(b, 0x07 | 0x1b | 0x18 | 0x1a));
                    let take = end.unwrap_or(bytes.len());
                    payload.extend_from_slice(&bytes[..take]);
                    let terminator = end.map(|i| bytes[i]);
                    bytes = &bytes[(take + 1).min(bytes.len())..];
                    match terminator {
                        _ if payload.len() > MAX_PAYLOAD => State::Ground,
                        None => State::Osc(payload),
                        Some(0x07) => {
                            found.extend(parse(&payload));
                            State::Ground
                        }
                        Some(0x1b) => State::OscEsc(payload),
                        Some(_) => State::Ground,
                    }
                }
                State::OscEsc(payload) => {
                    if first == b'\\' {
                        bytes = &bytes[1..];
                        found.extend(parse(&payload));
                        State::Ground
                    } else {
                        State::Esc
                    }
                }
            };
        }
    }
}

fn parse(payload: &[u8]) -> Option<Osc> {
    let text = std::str::from_utf8(payload).ok()?;
    let (code, rest) = text.split_once(';')?;
    match code {
        "7" => cwd_from_url(rest).map(Osc::Cwd),
        "9" if rest.starts_with("4;") => progress(&rest[2..]),
        "9" => Some(Osc::Notify {
            title: String::new(),
            body: rest.to_owned(),
        }),
        "777" => {
            let mut parts = rest.splitn(3, ';');
            (parts.next()? == "notify").then(|| Osc::Notify {
                title: parts.next().unwrap_or_default().to_owned(),
                body: parts.next().unwrap_or_default().to_owned(),
            })
        }
        _ => None,
    }
}

/// `<state>;<percent>`: 0 off, 1 normal, 2 error, 3 indeterminate, 4 paused; a missing percent is 0
fn progress(args: &str) -> Option<Osc> {
    let (state, percent) = args.split_once(';').unwrap_or((args, ""));
    let state = match state {
        "0" => ProgressState::Off,
        "1" => ProgressState::Normal,
        "2" => ProgressState::Error,
        "3" => ProgressState::Indeterminate,
        "4" => ProgressState::Paused,
        _ => return None,
    };
    let percent = percent.parse::<u16>().map_or(0, |p| p.min(100) as u8);
    Some(Osc::Progress { state, percent })
}

/// `file://host/path` with percent escapes
fn cwd_from_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_chunks(chunks: &[&[u8]]) -> Vec<Osc> {
        let mut scanner = OscScanner::default();
        let mut found = Vec::new();
        for chunk in chunks {
            scanner.scan(chunk, &mut found);
        }
        found
    }

    #[test]
    fn finds_cwd_and_notifications_across_chunks() {
        let found = scan_chunks(&[
            b"text\x1b[31mred\x1b]7;file://mac/Users/me/My%20Dir",
            b"\x07more\x1b]9;build done\x1b",
            b"\\\x1b]777;notify;Claude;needs you\x07\x1b]9;4;1;50\x07\x1b]0;title\x07",
        ]);
        assert_eq!(
            found,
            vec![
                Osc::Cwd("/Users/me/My Dir".into()),
                Osc::Notify {
                    title: String::new(),
                    body: "build done".into()
                },
                Osc::Notify {
                    title: "Claude".into(),
                    body: "needs you".into()
                },
                Osc::Progress {
                    state: ProgressState::Normal,
                    percent: 50
                },
            ]
        );
    }

    #[test]
    fn reads_progress_states_and_drops_unknown_ones() {
        let found =
            scan_chunks(&[b"\x1b]9;4;3\x07\x1b]9;4;2;250\x07\x1b]9;4;0;\x07\x1b]9;4;7;1\x07"]);
        assert_eq!(
            found,
            vec![
                Osc::Progress {
                    state: ProgressState::Indeterminate,
                    percent: 0
                },
                Osc::Progress {
                    state: ProgressState::Error,
                    percent: 100
                },
                Osc::Progress {
                    state: ProgressState::Off,
                    percent: 0
                },
            ]
        );
    }

    #[test]
    fn drops_oversized_and_cancelled() {
        let long = [b'x'; MAX_PAYLOAD + 10];
        let found = scan_chunks(&[b"\x1b]9;", &long, b"\x07\x1b]9;a\x18\x1b]9;ok\x07"]);
        assert_eq!(
            found,
            vec![Osc::Notify {
                title: String::new(),
                body: "ok".into()
            }]
        );
    }
}
