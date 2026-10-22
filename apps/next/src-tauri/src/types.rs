//! The webview's view of the proto types: camelCase JSON matching apps/next/src/ipc/api.ts.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::{InvokeResponseBody, IpcResponse};
use treeix_proto as proto;

/// One channel message: `[u8 kind: 0 snapshot, 1 data][u64 LE seq][payload]`, delivered as a raw ArrayBuffer
#[derive(Type)]
pub struct Frame(Vec<u8>);

impl Frame {
    pub fn snapshot(seq: u64, bytes: &[u8]) -> Self {
        Self::new(0, seq, bytes)
    }

    pub fn data(seq: u64, bytes: &[u8]) -> Self {
        Self::new(1, seq, bytes)
    }

    fn new(kind: u8, seq: u64, bytes: &[u8]) -> Self {
        let mut frame = Vec::with_capacity(9 + bytes.len());
        frame.push(kind);
        frame.extend_from_slice(&seq.to_le_bytes());
        frame.extend_from_slice(bytes);
        Self(frame)
    }
}

impl IpcResponse for Frame {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub proto: u32,
    pub build: String,
    pub daemon_pid: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    Shell,
    Claude,
    Codex,
    Routine,
}

impl From<proto::SessionKind> for SessionKind {
    fn from(kind: proto::SessionKind) -> Self {
        match kind {
            proto::SessionKind::Shell => Self::Shell,
            proto::SessionKind::Claude => Self::Claude,
            proto::SessionKind::Codex => Self::Codex,
            proto::SessionKind::Routine => Self::Routine,
        }
    }
}

impl From<SessionKind> for proto::SessionKind {
    fn from(kind: SessionKind) -> Self {
        match kind {
            SessionKind::Shell => Self::Shell,
            SessionKind::Claude => Self::Claude,
            SessionKind::Codex => Self::Codex,
            SessionKind::Routine => Self::Routine,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Running,
    Needs,
    Done,
    Idle,
    Exited,
    Error,
    Restored,
    Crashed,
}

impl From<proto::SessionStatus> for SessionStatus {
    fn from(status: proto::SessionStatus) -> Self {
        match status {
            proto::SessionStatus::Running => Self::Running,
            proto::SessionStatus::Needs => Self::Needs,
            proto::SessionStatus::Done => Self::Done,
            proto::SessionStatus::Idle => Self::Idle,
            proto::SessionStatus::Exited => Self::Exited,
            proto::SessionStatus::Error => Self::Error,
            proto::SessionStatus::Restored => Self::Restored,
            proto::SessionStatus::Crashed => Self::Crashed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub kind: SessionKind,
    pub cwd: String,
    pub title: String,
    pub status: SessionStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u64,
    pub command: Vec<String>,
    pub seq: u64,
    pub agent_session: Option<String>,
    pub routine: Option<String>,
}

impl From<proto::SessionInfo> for SessionInfo {
    fn from(info: proto::SessionInfo) -> Self {
        Self {
            id: info.id,
            kind: info.kind.into(),
            cwd: info.cwd,
            title: info.title,
            status: info.status.into(),
            pid: info.pid,
            exit_code: info.exit_code,
            cols: info.cols,
            rows: info.rows,
            created_at: info.created_at,
            command: info.command,
            seq: info.seq,
            agent_session: info.agent_session,
            routine: info.routine,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    pub kind: SessionKind,
    pub cwd: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub title: Option<String>,
    pub routine: Option<String>,
}

impl From<CreateSession> for proto::CreateSession {
    fn from(opts: CreateSession) -> Self {
        Self {
            kind: opts.kind.into(),
            cwd: opts.cwd,
            command: opts.command,
            env: opts.env,
            cols: opts.cols,
            rows: opts.rows,
            title: opts.title,
            routine: opts.routine,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct Attached {
    pub seq: u64,
    pub info: SessionInfo,
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DaemonState {
    Connected,
    Disconnected,
}

/// Everything the daemon pushes except PTY bytes, emitted as the `session-event` app event
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    Status {
        session: String,
        status: SessionStatus,
    },
    Exit {
        session: String,
        code: Option<i32>,
    },
    Title {
        session: String,
        title: String,
    },
    Cwd {
        session: String,
        cwd: String,
    },
    Notify {
        session: String,
        title: String,
        body: String,
    },
    Bell {
        session: String,
    },
    Created {
        info: SessionInfo,
    },
    Removed {
        session: String,
    },
    Daemon {
        state: DaemonState,
    },
}

impl SessionEvent {
    /// None for Data, which goes to the session's channel instead
    pub fn from_proto(event: proto::Event) -> Option<Self> {
        Some(match event {
            proto::Event::Data { .. } => return None,
            proto::Event::Status { session, status } => Self::Status {
                session,
                status: status.into(),
            },
            proto::Event::Exit { session, code } => Self::Exit { session, code },
            proto::Event::Title { session, title } => Self::Title { session, title },
            proto::Event::Cwd { session, cwd } => Self::Cwd { session, cwd },
            proto::Event::Notify {
                session,
                title,
                body,
            } => Self::Notify {
                session,
                title,
                body,
            },
            proto::Event::Bell { session } => Self::Bell { session },
            proto::Event::Created(info) => Self::Created { info: info.into() },
            proto::Event::Removed { session } => Self::Removed { session },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_header_is_kind_then_le_seq() {
        let Frame(bytes) = Frame::data(0x0102, b"hi");
        assert_eq!(bytes, [1, 0x02, 0x01, 0, 0, 0, 0, 0, 0, b'h', b'i']);
    }

    #[test]
    fn events_match_the_ts_union() {
        let event = SessionEvent::from_proto(proto::Event::Status {
            session: "s".into(),
            status: proto::SessionStatus::Needs,
        });
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"status","session":"s","status":"needs"}"#
        );
        let daemon = SessionEvent::Daemon {
            state: DaemonState::Disconnected,
        };
        assert_eq!(
            serde_json::to_string(&daemon).unwrap(),
            r#"{"type":"daemon","state":"disconnected"}"#
        );
    }
}
