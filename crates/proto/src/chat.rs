//! Chats over ACP (Agent Client Protocol). ptyd runs the agent so a chat outlives the app. These are also the
//! webview's types (`specta` feature), shaped like the Electron SDK's (packages/sdk/src/chat.ts).
//! Tagged enums can't go through postcard, so fields holding them travel as JSON (`as_json`).

use serde::{Deserialize, Serialize};

pub type ChatId = String;

/// Serde `with` module: the field is a JSON string on the wire
pub mod as_json {
    use serde::de::{DeserializeOwned, Error as _};
    use serde::ser::Error as _;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(value: &T, s: S) -> Result<S::Ok, S::Error> {
        serde_json::to_string(value)
            .map_err(S::Error::custom)?
            .serialize(s)
    }

    pub fn deserialize<'de, T: DeserializeOwned, D: Deserializer<'de>>(
        d: D,
    ) -> Result<T, D::Error> {
        serde_json::from_str(&String::deserialize(d)?).map_err(D::Error::custom)
    }
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatAgent {
    Claude,
    Codex,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatStatus {
    /// The agent process is starting or loading the conversation
    Starting,
    Idle,
    /// A turn is running
    Running,
    /// A permission request waits for an answer
    Needs,
    /// The agent exited or the connection broke; a prompt starts it again, resuming the conversation
    Disconnected,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ChatCapabilities {
    pub images: bool,
    /// Can resume a past conversation
    pub load: bool,
    pub list: bool,
}

/// A live chat in ptyd
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInfo {
    pub id: ChatId,
    pub agent: ChatAgent,
    pub cwd: String,
    pub title: String,
    pub status: ChatStatus,
    /// The agent's conversation id, which `claude --resume` / `codex resume` take
    pub agent_session: Option<String>,
    pub capabilities: ChatCapabilities,
    /// Unix millis
    pub created_at: u64,
    /// Seq the next event gets; attach from 0 replays the whole log
    pub seq: u64,
}

/// Model, effort and mode a new conversation starts with, by option value
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ChatPreset {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
}

/// What ptyd starts: the app resolves the adapter command, env (MCP token) and instructions
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatCreate {
    pub agent: ChatAgent,
    pub cwd: String,
    /// The ACP adapter command line
    pub command: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Conversation to resume
    pub resume: Option<String>,
    /// Added to the system prompt where the agent takes one, else put before the first message
    pub instructions: Option<String>,
    pub preset: ChatPreset,
    /// More folders the agent loads instructions, skills and subagents from
    pub directories: Vec<String>,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatContent {
    Text {
        text: String,
    },
    /// Base64 `data`
    #[serde(rename_all = "camelCase")]
    Image {
        mime_type: String,
        data: String,
    },
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolOutput {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        mime_type: String,
        data: String,
    },
    /// `old_text` is None for a new file
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    #[serde(rename_all = "camelCase")]
    Terminal {
        terminal_id: String,
    },
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolLocation {
    pub path: String,
    pub line: Option<u32>,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub title: String,
    pub kind: ToolKind,
    pub status: ToolStatus,
    pub output: Vec<ToolOutput>,
    pub locations: Vec<ToolLocation>,
    /// The tool's arguments as the agent sent them
    pub raw_input: serde_json::Value,
}

/// A tool call update: None leaves the field as it was
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallPatch {
    pub title: Option<String>,
    pub kind: Option<ToolKind>,
    pub status: Option<ToolStatus>,
    pub output: Option<Vec<ToolOutput>>,
    pub locations: Option<Vec<ToolLocation>>,
    pub raw_input: Option<serde_json::Value>,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanPriority {
    High,
    Medium,
    Low,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub priority: PlanPriority,
    /// Pending, in progress or completed (`Failed` never appears)
    pub status: ToolStatus,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OptionCategory {
    Mode,
    Model,
    Effort,
    Other,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OptionValue {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

/// A setting of the conversation the agent offers, like model, effort or mode
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOption {
    pub id: String,
    pub name: String,
    pub category: OptionCategory,
    pub current_value: String,
    pub values: Vec<OptionValue>,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatCommand {
    pub name: String,
    pub description: String,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionOption {
    pub id: String,
    pub name: String,
    pub kind: PermissionKind,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

/// Tokens one turn spent, as the agent reports them; `input` excludes the cached part
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub thought: u64,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cost {
    pub amount: f64,
    pub currency: String,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Agent,
}

/// What a chat's log holds. `parent` is the id of the tool call whose subagent said or ran it
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    MessageChunk {
        role: ChatRole,
        content: ChatContent,
        parent: Option<String>,
    },
    ThoughtChunk {
        text: String,
        parent: Option<String>,
    },
    ToolCall {
        call: ToolCall,
        parent: Option<String>,
    },
    ToolCallUpdate {
        id: String,
        patch: ToolCallPatch,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    /// Context window: `used` of `size` tokens
    Usage {
        used: u64,
        size: u64,
        cost: Option<Cost>,
    },
    /// A title the agent made for the chat
    Title {
        title: String,
    },
    Options {
        options: Vec<ChatOption>,
    },
    /// Slash commands the agent offers
    Commands {
        commands: Vec<ChatCommand>,
    },
    #[serde(rename_all = "camelCase")]
    Permission {
        request_id: String,
        title: String,
        tool_call_id: Option<String>,
        options: Vec<PermissionOption>,
    },
    /// Answered, from any window, or cancelled with the turn
    #[serde(rename_all = "camelCase")]
    PermissionSettled {
        request_id: String,
    },
    TurnStart,
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        stop_reason: StopReason,
        usage: Option<TurnUsage>,
    },
    Error {
        message: String,
    },
    /// The agent's process or connection ended; the next prompt starts it again
    Disconnected {
        message: String,
    },
}

/// One event as the chat's log keeps it
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatEntry {
    pub seq: u64,
    /// Unix millis
    pub at: u64,
    pub event: ChatEvent,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_match_the_electron_json() {
        let event = ChatEvent::Permission {
            request_id: "r".into(),
            title: "Run ls".into(),
            tool_call_id: None,
            options: vec![PermissionOption {
                id: "a".into(),
                name: "Allow".into(),
                kind: PermissionKind::AllowOnce,
            }],
        };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"permission","requestId":"r","title":"Run ls","toolCallId":null,"options":[{"id":"a","name":"Allow","kind":"allow_once"}]}"#
        );
    }

    #[test]
    fn tagged_fields_survive_postcard() {
        #[derive(Debug, PartialEq, Serialize, Deserialize)]
        struct Frame(#[serde(with = "as_json")] Vec<ChatContent>);
        let frame = Frame(vec![ChatContent::Text { text: "hi".into() }]);
        let bytes = postcard::to_stdvec(&frame).unwrap();
        assert_eq!(postcard::from_bytes::<Frame>(&bytes).unwrap(), frame);
    }
}
