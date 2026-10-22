//! Chat commands: the app's side of the chats ptyd runs over ACP. Each attach is a channel of `ChatEntry`s
//! starting at `from_seq`; chat info changes go to every window as `ChatsEvent`. Owner: A4

use super::Result;
use crate::daemon::Daemon;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use treeix_proto::chat::{
    ChatAgent, ChatContent, ChatCreate, ChatEntry, ChatId, ChatInfo, ChatPreset,
};
use treeix_proto::{Request, Response};

/// A chat the user starts; the app adds the adapter command, env and instructions
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewChat {
    pub agent: ChatAgent,
    pub cwd: String,
    /// Conversation to resume, like a History record's agent session
    pub resume: Option<String>,
    pub preset: Option<ChatPreset>,
}

/// A chat was created, changed (status, title, agent session) or closed, in any window
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatsEvent {
    Changed { info: ChatInfo },
    Removed { chat: ChatId },
}

/// Chat events from ptyd: entries go to the channels attached to that chat, the rest to every window
pub(crate) fn on_chat_event(app: &AppHandle, event: treeix_proto::Event) {
    let event = match event {
        treeix_proto::Event::Chat { chat, entry } => return RELAY.send(app, chat, &entry),
        treeix_proto::Event::ChatChanged(info) => ChatsEvent::Changed { info },
        treeix_proto::Event::ChatRemoved { chat } => {
            RELAY.lock().remove(&chat);
            ChatsEvent::Removed { chat }
        }
        _ => return,
    };
    if let Err(e) = event.emit(app) {
        tracing::warn!("chats event not sent: {e}");
    }
}

struct Viewer {
    channel: Channel<ChatEntry>,
    webview: String,
    next_seq: u64,
}

/// ptyd streams each chat once per app; the relay fans it out to the attached channels
#[derive(Default)]
struct Relay {
    viewers: Mutex<HashMap<ChatId, Vec<Viewer>>>,
    // ponytail: one lock for every chat's attach and detach, per chat if attaching ever gets slow
    attaching: tokio::sync::Mutex<()>,
}

static RELAY: LazyLock<Relay> = LazyLock::new(Relay::default);

impl Relay {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ChatId, Vec<Viewer>>> {
        self.viewers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn send(&self, app: &AppHandle, chat: ChatId, entry: &ChatEntry) {
        let mut viewers = self.lock();
        let Some(list) = viewers.get_mut(&chat) else {
            return;
        };
        list.retain_mut(|viewer| {
            if entry.seq < viewer.next_seq {
                return true;
            }
            viewer.next_seq = entry.seq + 1;
            viewer.channel.send(entry.clone()).is_ok()
        });
        if list.is_empty() {
            viewers.remove(&chat);
            drop(viewers);
            let daemon = app.state::<Arc<Daemon>>().inner().clone();
            tauri::async_runtime::spawn(
                async move { RELAY.detach_if_unwatched(&daemon, chat).await },
            );
        }
    }

    async fn detach_if_unwatched(&self, daemon: &Daemon, chat: ChatId) {
        let _attaching = self.attaching.lock().await;
        if self.lock().contains_key(&chat) {
            return;
        }
        if let Err(e) = super::ok(daemon, Request::ChatDetach { chat }).await {
            tracing::warn!("chat detach: {e}");
        }
    }

    /// A reloaded webview's channels never take another entry; its chats nobody else watches stop streaming
    async fn drop_webview(&self, daemon: &Daemon, label: &str) {
        let _attaching = self.attaching.lock().await;
        let mut unwatched = Vec::new();
        self.lock().retain(|chat, list| {
            list.retain(|v| v.webview != label);
            if list.is_empty() {
                unwatched.push(chat.clone());
            }
            !list.is_empty()
        });
        for chat in unwatched {
            if let Err(e) = super::ok(daemon, Request::ChatDetach { chat }).await {
                tracing::warn!("chat detach: {e}");
            }
        }
    }

    /// A new daemon connection streams no chat: each watched one replays from the oldest entry a channel lacks
    async fn reattach(&self, daemon: &Daemon) {
        let _attaching = self.attaching.lock().await;
        let watched: Vec<(ChatId, u64)> = self
            .lock()
            .iter()
            .filter_map(|(chat, list)| Some((chat.clone(), list.iter().map(|v| v.next_seq).min()?)))
            .collect();
        for (chat, from_seq) in watched {
            let attach = Request::ChatAttach {
                chat: chat.clone(),
                from_seq,
            };
            if let Err(e) = daemon.request(attach).await.and_then(|r| match r {
                Response::Chat(_) => Ok(()),
                other => Err(super::unexpected(other)),
            }) {
                tracing::warn!("chat reattach: {e}");
                self.lock().remove(&chat);
            }
        }
    }

    /// ptyd replays a chat from one seq per app: a channel joining a watched chat stops the stream first, so
    /// every entry after that is the new replay, in order, and each channel drops what it has seen
    async fn attach(
        &self,
        daemon: &Daemon,
        chat: ChatId,
        from_seq: u64,
        channel: Channel<ChatEntry>,
        webview: String,
    ) -> Result<ChatInfo> {
        let _attaching = self.attaching.lock().await;
        let watched = self
            .lock()
            .get(&chat)
            .map(|list| list.iter().map(|v| v.next_seq).min());
        if watched.is_some() {
            super::ok(daemon, Request::ChatDetach { chat: chat.clone() }).await?;
        }
        let replay_from = watched
            .flatten()
            .map_or(from_seq, |seen| seen.min(from_seq));
        let id = channel.id();
        self.lock().entry(chat.clone()).or_default().push(Viewer {
            channel,
            webview,
            next_seq: from_seq,
        });
        let attached = daemon
            .request(Request::ChatAttach {
                chat: chat.clone(),
                from_seq: replay_from,
            })
            .await;
        match attached {
            Ok(Response::Chat(info)) => Ok(info),
            other => {
                let mut viewers = self.lock();
                if let Some(list) = viewers.get_mut(&chat) {
                    list.retain(|v| v.channel.id() != id);
                    if list.is_empty() {
                        viewers.remove(&chat);
                    }
                }
                Err(other.map_or_else(|e| e, super::unexpected))
            }
        }
    }

    async fn detach(&self, daemon: &Daemon, chat: ChatId, channel: u32) -> Result<()> {
        let _attaching = self.attaching.lock().await;
        let unwatched = {
            let mut viewers = self.lock();
            let Some(list) = viewers.get_mut(&chat) else {
                return Ok(());
            };
            list.retain(|v| v.channel.id() != channel);
            let empty = list.is_empty();
            if empty {
                viewers.remove(&chat);
            }
            empty
        };
        if unwatched {
            super::ok(daemon, Request::ChatDetach { chat }).await?;
        }
        Ok(())
    }
}

fn adapter(agent: ChatAgent) -> Vec<String> {
    let package = match agent {
        ChatAgent::Claude => "@agentclientprotocol/claude-agent-acp@0.85.1",
        ChatAgent::Codex => "@zed-industries/codex-acp@0.16.0",
    };
    ["npx", "-y", package].map(str::to_owned).to_vec()
}

/// The skip-permissions setting of an agent, as the mode its adapter starts in
fn skip_mode(agent: ChatAgent) -> Option<String> {
    let settings = treeix_core::settings::load(&treeix_proto::data_dir()).agents;
    let mode = match agent {
        ChatAgent::Claude if settings.skip_permissions_claude => "bypassPermissions",
        ChatAgent::Codex if settings.skip_permissions_codex => "full-access",
        _ => return None,
    };
    Some(mode.into())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_create(
    app: AppHandle,
    daemon: State<'_, Arc<Daemon>>,
    chat: NewChat,
) -> Result<ChatInfo> {
    let NewChat {
        agent,
        cwd,
        resume,
        preset,
    } = chat;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let directories = treeix_core::git::projects::agent_directories(Path::new(&cwd), &home)
        .into_iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    let mut preset = preset.unwrap_or_default();
    if preset.mode.is_none() && resume.is_none() {
        preset.mode = skip_mode(agent);
    }
    let create = ChatCreate {
        agent,
        cwd,
        command: adapter(agent),
        env: super::mcp::agent_env(&app),
        resume,
        instructions: None,
        preset,
        directories,
    };
    match daemon
        .request(Request::ChatCreate(Box::new(create)))
        .await?
    {
        Response::Chat(info) => Ok(info),
        other => Err(super::unexpected(other)),
    }
}

/// Starts a turn and returns; the turn streams to attached channels
#[tauri::command]
#[specta::specta]
pub async fn chat_prompt(
    daemon: State<'_, Arc<Daemon>>,
    chat: ChatId,
    content: Vec<ChatContent>,
) -> Result<()> {
    super::ok(&daemon, Request::ChatPrompt { chat, content }).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_cancel(daemon: State<'_, Arc<Daemon>>, chat: ChatId) -> Result<()> {
    super::ok(&daemon, Request::ChatCancel { chat }).await
}

/// `option` None rejects the permission request
#[tauri::command]
#[specta::specta]
pub async fn chat_answer(
    daemon: State<'_, Arc<Daemon>>,
    chat: ChatId,
    request: String,
    option: Option<String>,
) -> Result<()> {
    let answer = Request::ChatAnswer {
        chat,
        request,
        option,
    };
    super::ok(&daemon, answer).await
}

/// Model, effort or mode, by the option's id and one of its values
#[tauri::command]
#[specta::specta]
pub async fn chat_set_option(
    daemon: State<'_, Arc<Daemon>>,
    chat: ChatId,
    option: String,
    value: String,
) -> Result<()> {
    let set = Request::ChatSetOption {
        chat,
        option,
        value,
    };
    super::ok(&daemon, set).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_list(daemon: State<'_, Arc<Daemon>>) -> Result<Vec<ChatInfo>> {
    match daemon.request(Request::ChatList).await? {
        Response::Chats(list) => Ok(list),
        other => Err(super::unexpected(other)),
    }
}

/// The log from `from_seq` on, then each new entry, as one channel message each; seqs never repeat on a channel
#[tauri::command]
#[specta::specta]
pub async fn chat_attach(
    webview: tauri::Webview,
    daemon: State<'_, Arc<Daemon>>,
    chat: ChatId,
    from_seq: u64,
    channel: Channel<ChatEntry>,
) -> Result<ChatInfo> {
    let label = webview.label().into();
    RELAY.attach(&daemon, chat, from_seq, channel, label).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_detach(daemon: State<'_, Arc<Daemon>>, chat: ChatId, channel: u32) -> Result<()> {
    RELAY.detach(&daemon, chat, channel).await
}

/// Stops the agent and drops the chat
#[tauri::command]
#[specta::specta]
pub async fn chat_close(daemon: State<'_, Arc<Daemon>>, chat: ChatId) -> Result<()> {
    super::ok(&daemon, Request::ChatClose { chat }).await
}

pub(crate) async fn drop_webview_chats(daemon: &Daemon, label: &str) {
    RELAY.drop_webview(daemon, label).await;
}

pub(crate) async fn reattach_chats(daemon: &Daemon) {
    RELAY.reattach(daemon).await;
}
