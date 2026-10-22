//! "Your tickets" in the Open worktree dialog: Jira through `acli`, Notion through its API. Owner: A5

pub mod acli;
pub mod notion;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TicketSource {
    Jira,
    Notion,
}

/// Picks the branch prefix: bugs get `fix/`, the rest `feat/`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TicketKind {
    Task,
    Bug,
    Story,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    /// `TRX-47` for Jira, the page id for Notion
    pub key: String,
    pub source: TicketSource,
    pub kind: TicketKind,
    pub title: String,
    pub status: String,
    /// Browser link
    pub url: Option<String>,
    /// Jira project key or Notion database title
    pub project: Option<String>,
    /// RFC 3339
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TicketError {
    pub source: TicketSource,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TicketList {
    pub tickets: Vec<Ticket>,
    /// A source that failed (signed out, no database); the other still lists
    pub errors: Vec<TicketError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TicketDetail {
    pub ticket: Ticket,
    /// Markdown, what the agent's first prompt quotes
    pub description: String,
}
