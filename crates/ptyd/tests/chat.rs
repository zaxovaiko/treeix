//! Chats against tests/support/fake_acp_agent.rs through a real daemon

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use treeix_proto::chat::{
    ChatAgent, ChatContent, ChatCreate, ChatEntry, ChatEvent, ChatInfo, ChatPreset, ChatRole,
    ChatStatus, StopReason, TurnUsage,
};
use treeix_proto::{Event, Request, Response};
use treeix_ptyd::client::Client;

struct Setup {
    dir: tempfile::TempDir,
    work: PathBuf,
    client: Client,
}

impl Setup {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let work = std::fs::canonicalize(dir.path()).unwrap().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let _server = treeix_ptyd::spawn_in_process(dir.path().into());
        let client = connect(dir.path()).await;
        Self { dir, work, client }
    }

    fn log(&self) -> PathBuf {
        self.dir.path().join("agent.log")
    }

    fn spec(&self, env: &[(&str, &str)]) -> ChatCreate {
        let mut env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        env.push(("FAKE_ACP_LOG".into(), self.log().to_string_lossy().into()));
        ChatCreate {
            agent: ChatAgent::Claude,
            cwd: self.work.to_string_lossy().into(),
            command: vec![env!("CARGO_BIN_EXE_fake-acp-agent").into()],
            env,
            resume: None,
            instructions: None,
            preset: ChatPreset::default(),
            directories: vec![],
        }
    }

    async fn create(&mut self, spec: ChatCreate) -> ChatInfo {
        match self
            .client
            .request(Request::ChatCreate(Box::new(spec)))
            .await
            .unwrap()
        {
            Response::Chat(info) => info,
            other => panic!("{other:?}"),
        }
    }

    /// Created and attached from seq 0, once the agent is up
    async fn started(&mut self, spec: ChatCreate) -> String {
        let info = self.create(spec).await;
        assert_eq!(info.status, ChatStatus::Starting);
        self.info_until(&info.id, |info| info.status != ChatStatus::Starting)
            .await;
        self.attach(&info.id, 0).await;
        info.id
    }

    async fn attach(&mut self, chat: &str, from_seq: u64) -> ChatInfo {
        let req = Request::ChatAttach {
            chat: chat.into(),
            from_seq,
        };
        match self.client.request(req).await.unwrap() {
            Response::Chat(info) => info,
            other => panic!("{other:?}"),
        }
    }

    async fn ok(&mut self, req: Request) {
        match self.client.request(req).await.unwrap() {
            Response::Ok => {}
            other => panic!("{other:?}"),
        }
    }

    async fn prompt(&mut self, chat: &str, text: &str) {
        self.ok(Request::ChatPrompt {
            chat: chat.into(),
            content: vec![ChatContent::Text { text: text.into() }],
        })
        .await;
    }

    async fn next(&mut self) -> Event {
        tokio::time::timeout(Duration::from_secs(30), self.client.next_event())
            .await
            .expect("timed out waiting for an event")
            .unwrap()
            .expect("the daemon hung up")
    }

    /// Entries of `chat` up to and including the first that matches
    async fn until(&mut self, chat: &str, done: impl Fn(&ChatEvent) -> bool) -> Vec<ChatEntry> {
        let mut entries = Vec::new();
        loop {
            if let Event::Chat { chat: id, entry } = self.next().await
                && id == chat
            {
                let last = done(&entry.event);
                entries.push(entry);
                if last {
                    return entries;
                }
            }
        }
    }

    async fn info_until(&mut self, chat: &str, done: impl Fn(&ChatInfo) -> bool) -> ChatInfo {
        loop {
            if let Event::ChatChanged(info) = self.next().await
                && info.id == chat
                && done(&info)
            {
                return info;
            }
        }
    }

    async fn list(&mut self) -> Vec<ChatInfo> {
        match self.client.request(Request::ChatList).await.unwrap() {
            Response::Chats(list) => list,
            other => panic!("{other:?}"),
        }
    }

    /// What the agent got, one JSON per message
    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(self.log())
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|m| m["method"] == method)
            .map(|m| m["params"].clone())
            .collect()
    }

    fn answers(&self, method: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|m| m["answer"] == method)
            .map(|m| m["value"].clone())
            .collect()
    }
}

async fn connect(dir: &Path) -> Client {
    Client::connect(&dir.join("ptyd.sock"))
        .await
        .expect("connect")
}

fn events(entries: &[ChatEntry]) -> Vec<&ChatEvent> {
    entries.iter().map(|entry| &entry.event).collect()
}

fn is_turn_end(event: &ChatEvent) -> bool {
    matches!(event, ChatEvent::TurnEnd { .. })
}

fn permission_id(event: &ChatEvent) -> Option<String> {
    match event {
        ChatEvent::Permission { request_id, .. } => Some(request_id.clone()),
        _ => None,
    }
}

fn text(role: ChatRole, text: &str) -> ChatEvent {
    ChatEvent::MessageChunk {
        role,
        content: ChatContent::Text { text: text.into() },
        parent: None,
    }
}

fn mode_of(event: &ChatEvent) -> Option<&str> {
    match event {
        ChatEvent::Options { options } => options
            .iter()
            .find(|o| o.id == "mode")
            .map(|o| o.current_value.as_str()),
        _ => None,
    }
}

#[tokio::test]
async fn a_turn_streams_asks_permission_and_ends() {
    let mut t = Setup::new().await;
    let chat = t.started(t.spec(&[])).await;
    let start = t.until(&chat, |e| mode_of(e).is_some()).await;
    assert!(events(&start).contains(&&ChatEvent::Title {
        title: "Fake chat".into()
    }));
    assert_eq!(mode_of(&start.last().unwrap().event), Some("ask"));

    t.prompt(&chat, "hi").await;
    let asked = t.until(&chat, |e| permission_id(e).is_some()).await;
    let request = permission_id(&asked.last().unwrap().event).unwrap();
    assert_eq!(
        t.list().await[0].status,
        ChatStatus::Needs,
        "a permission request waits"
    );
    t.ok(Request::ChatAnswer {
        chat: chat.clone(),
        request: request.clone(),
        option: Some("allow".into()),
    })
    .await;
    let turn = [asked, t.until(&chat, is_turn_end).await].concat();
    let kinds: Vec<String> = events(&turn)
        .iter()
        .map(|e| {
            serde_json::to_value(e).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "turn_start",
            "message_chunk",
            "message_chunk",
            "tool_call",
            "permission",
            "permission_settled",
            "tool_call_update",
            "turn_end"
        ]
    );
    assert_eq!(turn[1].event, text(ChatRole::User, "hi"));
    assert_eq!(turn[2].event, text(ChatRole::Agent, "Hello"));
    assert_eq!(
        turn.last().unwrap().event,
        ChatEvent::TurnEnd {
            stop_reason: StopReason::EndTurn,
            usage: Some(TurnUsage {
                input: 1,
                output: 2,
                ..Default::default()
            })
        }
    );
    assert!(turn.windows(2).all(|w| w[1].seq == w[0].seq + 1));
    assert_eq!(t.list().await[0].status, ChatStatus::Idle);
    assert_eq!(
        t.answers("session/request_permission")[0]["result"]["outcome"]["optionId"],
        "allow"
    );

    let set = Request::ChatSetOption {
        chat: chat.clone(),
        option: "mode".into(),
        value: "code".into(),
    };
    t.ok(set).await;
    let options = t.until(&chat, |e| mode_of(e).is_some()).await;
    assert_eq!(mode_of(&options.last().unwrap().event), Some("code"));
    assert_eq!(t.requests("session/set_mode")[0]["modeId"], "code");

    t.ok(Request::ChatClose { chat: chat.clone() }).await;
    assert!(t.list().await.is_empty());
    assert!(!t.dir.path().join(format!("chats/{chat}.jsonl")).exists());
}

#[tokio::test]
async fn a_gone_conversation_starts_a_new_one_and_folders_reach_the_agent() {
    let mut t = Setup::new().await;
    let mut spec = t.spec(&[]);
    spec.resume = Some("gone".into());
    spec.directories = vec!["/elsewhere".into()];
    let info = t.create(spec).await;
    let info = t
        .info_until(&info.id, |info| info.status == ChatStatus::Idle)
        .await;
    assert_eq!(info.agent_session.as_deref(), Some("s1"));
    assert!(info.capabilities.load && info.capabilities.images);
    let new = &t.requests("session/new")[0];
    assert_eq!(
        new["additionalDirectories"],
        serde_json::json!(["/elsewhere"])
    );
}

#[tokio::test]
async fn cancel_settles_the_permission_and_ends_the_turn_cancelled() {
    let mut t = Setup::new().await;
    let chat = t.started(t.spec(&[])).await;
    t.prompt(&chat, "hi").await;
    t.until(&chat, |e| permission_id(e).is_some()).await;
    t.ok(Request::ChatCancel { chat: chat.clone() }).await;
    let rest = t.until(&chat, is_turn_end).await;
    assert!(matches!(rest[0].event, ChatEvent::PermissionSettled { .. }));
    assert_eq!(
        rest.last().unwrap().event,
        ChatEvent::TurnEnd {
            stop_reason: StopReason::Cancelled,
            usage: None
        }
    );
    assert_eq!(t.requests("session/cancel").len(), 1);
    assert_eq!(t.list().await[0].status, ChatStatus::Idle);
}

#[tokio::test]
async fn an_agent_that_dies_settles_its_permission_and_disconnects() {
    let mut t = Setup::new().await;
    let chat = t.started(t.spec(&[])).await;
    t.prompt(&chat, "crash").await;
    let rest = t
        .until(&chat, |e| matches!(e, ChatEvent::Disconnected { .. }))
        .await;
    let rest = events(&rest);
    assert!(
        rest.iter()
            .any(|e| matches!(e, ChatEvent::PermissionSettled { .. }))
    );
    assert_eq!(
        rest.last().unwrap(),
        &&ChatEvent::Disconnected {
            message: "The agent stopped: crashed".into()
        }
    );
    assert_eq!(t.list().await[0].status, ChatStatus::Disconnected);
}

#[tokio::test]
async fn a_long_replay_keeps_its_newest_entries_and_the_options() {
    let mut t = Setup::new().await;
    let mut spec = t.spec(&[]);
    spec.resume = Some("s0".into());
    let chat = t.create(spec).await.id;
    let info = t
        .info_until(&chat, |info| info.status == ChatStatus::Idle)
        .await;
    assert_eq!(info.agent_session.as_deref(), Some("s0"));
    t.attach(&chat, 0).await;
    let log = t.until(&chat, |e| mode_of(e).is_some()).await;
    assert_eq!(log.len(), 5000);
    assert_eq!(log[0].seq, log.last().unwrap().seq - 4999);
    let last_user = log.iter().rev().find_map(|entry| match &entry.event {
        ChatEvent::MessageChunk {
            role: ChatRole::User,
            content: ChatContent::Text { text },
            ..
        } => Some(text.as_str()),
        _ => None,
    });
    assert_eq!(last_user, Some("5000"));
}

#[tokio::test]
async fn file_access_stays_inside_the_folder() {
    let mut t = Setup::new().await;
    let chat = t.started(t.spec(&[])).await;
    t.prompt(&chat, "files").await;
    t.until(&chat, is_turn_end).await;
    let writes = t.answers("fs/write_text_file");
    assert_eq!(writes[0]["result"], serde_json::json!({}));
    assert_eq!(writes[1]["result"], serde_json::json!({}));
    assert_eq!(writes[2]["error"]["message"], "Outside the session folder");
    assert_eq!(
        t.answers("fs/read_text_file")[0]["result"]["content"],
        "four"
    );
    assert_eq!(
        std::fs::read_to_string(t.work.join("n.txt")).unwrap(),
        "three\nfour"
    );
    assert!(!t.work.join("../outside.txt").exists());
}

#[tokio::test]
async fn instructions_go_to_the_system_prompt_where_the_agent_takes_one() {
    let mut t = Setup::new().await;
    let mut spec = t.spec(&[("FAKE_ACP_NAME", "@agentclientprotocol/claude-agent-acp")]);
    spec.instructions = Some("Be brief".into());
    let chat = t.started(spec).await;
    t.prompt(&chat, "files").await;
    t.until(&chat, is_turn_end).await;
    assert_eq!(
        t.requests("session/new")[0]["_meta"]["systemPrompt"]["append"],
        "Be brief"
    );
    assert_eq!(
        t.requests("session/prompt")[0]["prompt"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn other_agents_get_instructions_before_the_first_message() {
    let mut t = Setup::new().await;
    let mut spec = t.spec(&[]);
    spec.instructions = Some("Be brief".into());
    let chat = t.started(spec).await;
    t.prompt(&chat, "files").await;
    t.until(&chat, is_turn_end).await;
    t.prompt(&chat, "files").await;
    t.until(&chat, is_turn_end).await;
    let new = &t.requests("session/new")[0];
    assert!(new["_meta"].is_null());
    let prompts = t.requests("session/prompt");
    assert_eq!(prompts[0]["prompt"][0]["text"], "Be brief");
    assert_eq!(prompts[0]["prompt"][1]["text"], "files");
    assert_eq!(prompts[1]["prompt"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_preset_sets_the_mode_and_reports_what_the_agent_lacks() {
    let mut t = Setup::new().await;
    let mut spec = t.spec(&[]);
    spec.preset = ChatPreset {
        model: Some("opus".into()),
        effort: None,
        mode: Some("code".into()),
    };
    let chat = t.started(spec).await;
    let start = t.until(&chat, |e| mode_of(e) == Some("code")).await;
    assert!(events(&start).contains(&&ChatEvent::Error {
        message: "This agent offers no model \"opus\"; using its default".into()
    }));
    assert_eq!(t.requests("session/set_mode")[0]["modeId"], "code");
}

#[tokio::test]
async fn a_preset_sets_the_model_before_the_effort_it_offers() {
    let mut t = Setup::new().await;
    let mut spec = t.spec(&[("FAKE_ACP_CONFIGURED", "1")]);
    spec.preset = ChatPreset {
        model: Some("opus".into()),
        effort: Some("max".into()),
        mode: None,
    };
    let chat = t.started(spec).await;
    let current = |e: &ChatEvent, id: &str| match e {
        ChatEvent::Options { options } => options
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.current_value.clone()),
        _ => None,
    };
    let start = t
        .until(&chat, |e| current(e, "effort").as_deref() == Some("max"))
        .await;
    let last = &start.last().unwrap().event;
    assert_eq!(current(last, "model").as_deref(), Some("opus"));
    assert!(
        !events(&start)
            .iter()
            .any(|e| matches!(e, ChatEvent::Error { .. }))
    );
    let set: Vec<Value> = t.requests("session/set_config_option");
    assert_eq!(
        (&set[0]["configId"], &set[1]["configId"]),
        (&"model".into(), &"effort".into())
    );
}

#[tokio::test]
async fn a_chat_survives_a_daemon_restart_and_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let server = treeix_ptyd::spawn_in_process(dir.path().into());
    let mut t = Setup {
        work: std::fs::canonicalize(dir.path()).unwrap(),
        client: connect(dir.path()).await,
        dir,
    };
    let chat = t.started(t.spec(&[])).await;
    t.prompt(&chat, "files").await;
    let before = t.until(&chat, is_turn_end).await;
    let seq = before.last().unwrap().seq;

    t.ok(Request::Shutdown).await;
    server.join().unwrap().unwrap();
    let _server = treeix_ptyd::spawn_in_process(t.dir.path().into());
    t.client = connect(t.dir.path()).await;

    let info = t.list().await.remove(0);
    assert_eq!((info.status, info.seq), (ChatStatus::Disconnected, seq + 1));
    t.attach(&chat, 0).await;
    let replayed = t.until(&chat, is_turn_end).await;
    assert_eq!(replayed.len() as u64, seq + 1);
    assert!(events(&replayed).contains(&&text(ChatRole::User, "files")));

    t.prompt(&chat, "files").await;
    let after = t.until(&chat, is_turn_end).await;
    assert_eq!(after[0].seq, seq + 1);
    assert_eq!(t.requests("session/load")[0]["sessionId"], "s1");
    assert!(
        after.len() < 10,
        "the replayed conversation is not logged again: {:?}",
        events(&after)
    );
    assert_eq!(t.list().await[0].status, ChatStatus::Idle);
}
