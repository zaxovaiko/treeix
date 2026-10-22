//! An ACP agent for the chat tests, newline-delimited JSON-RPC over stdio.
//! FAKE_ACP_NAME: its agentInfo name. FAKE_ACP_CONFIGURED: config options (model, effort) instead of modes.
//! FAKE_ACP_LOG: a file it appends every message it gets to, one JSON per line.
//! Prompts: "crash" asks a permission and dies, "files" tries the fs methods, anything else runs one tool call
//! behind a permission.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Agent {
    out: Mutex<()>,
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, Sender<Value>>>,
    cancelled: AtomicBool,
    config: Mutex<(String, String)>,
    log: Option<Mutex<std::fs::File>>,
}

impl Agent {
    fn send(&self, message: Value) {
        let _guard = self.out.lock().unwrap();
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{message}").unwrap();
        stdout.flush().unwrap();
    }

    fn log(&self, message: &Value) {
        if let Some(log) = &self.log {
            writeln!(log.lock().unwrap(), "{message}").unwrap();
        }
    }

    fn update(&self, session: &str, update: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": session, "update": update } }));
    }

    /// Asks the client and waits for its answer: `result`, or the error under `error`
    fn ask(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1000;
        let (tx, rx) = channel();
        self.waiting.lock().unwrap().insert(id, tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let answer = rx.recv().unwrap();
        self.log(&json!({ "answer": method, "value": answer }));
        answer
    }

    fn config_options(&self) -> Value {
        let (model, effort) = self.config.lock().unwrap().clone();
        let efforts: &[&str] = if model == "opus" {
            &["low", "high", "max"]
        } else {
            &["low", "high"]
        };
        let values = |list: &[&str]| -> Value {
            list.iter()
                .map(|v| json!({ "value": v, "name": v }))
                .collect()
        };
        json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": model, "options": values(&["sonnet", "opus"]) },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": effort, "options": values(efforts) }
        ])
    }

    fn session_setup(&self) -> Value {
        if std::env::var_os("FAKE_ACP_CONFIGURED").is_some() {
            json!({ "configOptions": self.config_options() })
        } else {
            json!({ "modes": { "currentModeId": "ask", "availableModes": [{ "id": "ask", "name": "Ask" }, { "id": "code", "name": "Code" }] } })
        }
    }

    fn handle(&self, method: &str, params: &Value) -> Result<Value, Value> {
        let session = params["sessionId"].as_str().unwrap_or("s1");
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true },
                    "mcpCapabilities": { "http": true },
                    "sessionCapabilities": { "additionalDirectories": {} }
                },
                "agentInfo": { "name": std::env::var("FAKE_ACP_NAME").unwrap_or_else(|_| "fake-agent".into()), "version": "1" }
            })),
            "session/new" => {
                // Named at once, so the tests never run the real title one-shot
                self.update(
                    "s1",
                    json!({ "sessionUpdate": "session_info_update", "title": "Fake chat" }),
                );
                let mut response = self.session_setup();
                response["sessionId"] = json!("s1");
                Ok(response)
            }
            "session/load" if session == "gone" => {
                Err(json!({ "code": -32002, "message": "Resource not found" }))
            }
            "session/load" => {
                for n in 0..=5000 {
                    self.update(session, json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": n.to_string() } }));
                }
                self.update(
                    session,
                    json!({ "sessionUpdate": "current_mode_update", "currentModeId": "code" }),
                );
                Ok(self.session_setup())
            }
            "session/set_mode" => Ok(json!({})),
            "session/set_config_option" => {
                let value = params["value"].as_str().unwrap_or_default().to_owned();
                {
                    let mut config = self.config.lock().unwrap();
                    match params["configId"].as_str() {
                        Some("model") => config.0 = value,
                        Some("effort") => config.1 = value,
                        _ => return Err(json!({ "code": -32602, "message": "no such option" })),
                    }
                }
                Ok(json!({ "configOptions": self.config_options() }))
            }
            "session/prompt" => Ok(self.prompt(session, params)),
            _ => Err(json!({ "code": -32601, "message": "Method not found" })),
        }
    }

    fn permission(&self, session: &str) -> Value {
        self.ask(
            "session/request_permission",
            json!({
                "sessionId": session,
                "toolCall": { "toolCallId": "t1", "title": "Run bun test" },
                "options": [
                    { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                ]
            }),
        )
    }

    fn prompt(&self, session: &str, params: &Value) -> Value {
        self.cancelled.store(false, Ordering::SeqCst);
        let blocks = params["prompt"].as_array().cloned().unwrap_or_default();
        let last = blocks
            .last()
            .and_then(|b| b["text"].as_str())
            .unwrap_or_default();
        let cwd = std::env::current_dir().unwrap();
        match last {
            "crash" => {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1000;
                self.send(json!({ "jsonrpc": "2.0", "id": id, "method": "session/request_permission", "params": {
                    "sessionId": session,
                    "toolCall": { "toolCallId": "t1", "title": "Run bun test" },
                    "options": [{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]
                } }));
                std::thread::sleep(std::time::Duration::from_millis(200));
                eprintln!("crashed");
                std::process::exit(1);
            }
            "files" => {
                let path = |name: &str| cwd.join(name).to_string_lossy().into_owned();
                let write = |path: String, content: &str| {
                    self.ask(
                        "fs/write_text_file",
                        json!({ "sessionId": session, "path": path, "content": content }),
                    )
                };
                write(path("n.txt"), "one\ntwo");
                write(path("n.txt"), "three\nfour");
                self.ask(
                    "fs/read_text_file",
                    json!({ "sessionId": session, "path": path("n.txt"), "line": 2, "limit": 1 }),
                );
                write(path("../outside.txt"), "x");
                json!({ "stopReason": "end_turn" })
            }
            _ => {
                self.update(session, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hello" } }));
                self.update(session, json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Run bun test", "kind": "execute", "status": "pending" }));
                let answer = self.permission(session);
                let outcome = &answer["result"]["outcome"];
                if outcome["outcome"] == "cancelled" {
                    while !self.cancelled.load(Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    return json!({ "stopReason": "cancelled" });
                }
                let status = if outcome["optionId"] == "allow" {
                    "completed"
                } else {
                    "failed"
                };
                self.update(session, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": status }));
                json!({ "stopReason": "end_turn", "usage": { "inputTokens": 1, "outputTokens": 2, "totalTokens": 3 } })
            }
        }
    }
}

fn main() {
    let agent = Arc::new(Agent {
        config: Mutex::new(("sonnet".into(), "high".into())),
        log: std::env::var_os("FAKE_ACP_LOG").map(|path| {
            Mutex::new(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .unwrap(),
            )
        }),
        ..Default::default()
    });
    for line in std::io::stdin().lock().lines() {
        let Ok(message) = serde_json::from_str::<Value>(&line.unwrap()) else {
            continue;
        };
        let method = message["method"].as_str().map(str::to_owned);
        let Some(method) = method else {
            // An answer to one of our requests
            if let Some(tx) = message["id"]
                .as_u64()
                .and_then(|id| agent.waiting.lock().unwrap().remove(&id))
            {
                let _ = tx.send(message);
            }
            continue;
        };
        agent.log(&message);
        if method == "session/cancel" {
            agent.cancelled.store(true, Ordering::SeqCst);
            continue;
        }
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let agent = agent.clone();
        std::thread::spawn(move || {
            let reply = match agent.handle(&method, &message["params"]) {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
            };
            agent.send(reply);
        });
    }
}
