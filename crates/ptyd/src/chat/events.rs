//! ACP messages to chat events, a port of packages/plugins/chat/main/acpEvents.ts. They come over JSON-RPC from
//! the agent's process, so every field is read defensively from the raw JSON

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use treeix_proto::chat::{
    ChatCommand, ChatContent, ChatEvent, ChatOption, ChatRole, Cost, OptionCategory, OptionValue,
    PermissionOption, PlanEntry, PlanPriority, ToolCall, ToolCallPatch, ToolKind, ToolLocation,
    ToolOutput, ToolStatus, TurnUsage,
};

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn nullable_text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn num(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as u64)
        })
        .unwrap_or(0)
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// One of the snake_case names of a proto enum, or None
fn named<T: DeserializeOwned>(value: &Value) -> Option<T> {
    value
        .is_string()
        .then(|| serde_json::from_value(value.clone()).ok())
        .flatten()
}

fn present(value: &Value) -> Option<&Value> {
    (!value.is_null()).then_some(value)
}

fn chat_content(value: &Value) -> Option<ChatContent> {
    match (value["type"].as_str(), &value["text"]) {
        (Some("text"), Value::String(text)) => Some(ChatContent::Text { text: text.clone() }),
        (Some("image"), _) => Some(ChatContent::Image {
            mime_type: value["mimeType"].as_str()?.to_owned(),
            data: value["data"].as_str()?.to_owned(),
        }),
        _ => None,
    }
}

fn tool_output(value: &Value) -> Option<ToolOutput> {
    match value["type"].as_str()? {
        "content" => match chat_content(&value["content"])? {
            ChatContent::Text { text } => Some(ToolOutput::Text { text }),
            ChatContent::Image { mime_type, data } => Some(ToolOutput::Image { mime_type, data }),
        },
        "diff" => Some(ToolOutput::Diff {
            path: value["path"].as_str()?.to_owned(),
            old_text: nullable_text(&value["oldText"]),
            new_text: value["newText"].as_str()?.to_owned(),
        }),
        "terminal" => Some(ToolOutput::Terminal {
            terminal_id: value["terminalId"].as_str()?.to_owned(),
        }),
        _ => None,
    }
}

fn tool_outputs(value: &Value) -> Vec<ToolOutput> {
    list(value).iter().filter_map(tool_output).collect()
}

fn tool_locations(value: &Value) -> Vec<ToolLocation> {
    list(value)
        .iter()
        .filter_map(|location| {
            Some(ToolLocation {
                path: location["path"].as_str()?.to_owned(),
                line: location["line"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok()),
            })
        })
        .collect()
}

fn plan_entries(value: &Value) -> Vec<PlanEntry> {
    list(value)
        .iter()
        .map(|item| PlanEntry {
            content: text(&item["content"]),
            priority: named(&item["priority"]).unwrap_or(PlanPriority::Medium),
            status: named(&item["status"])
                .filter(|status| *status != ToolStatus::Failed)
                .unwrap_or(ToolStatus::Pending),
        })
        .collect()
}

/// claude-agent-acp stamps a subagent's updates with the Agent tool call that started it
fn parent_of(update: &Value) -> Option<String> {
    update["_meta"]["claudeCode"]["parentToolUseId"]
        .as_str()
        .filter(|parent| !parent.is_empty())
        .map(str::to_owned)
}

fn tool_call_event(update: &Value) -> Option<ChatEvent> {
    Some(ChatEvent::ToolCall {
        call: ToolCall {
            id: update["toolCallId"].as_str()?.to_owned(),
            title: text(&update["title"]),
            kind: named(&update["kind"]).unwrap_or(ToolKind::Other),
            status: named(&update["status"]).unwrap_or(ToolStatus::Pending),
            output: tool_outputs(&update["content"]),
            locations: tool_locations(&update["locations"]),
            raw_input: update["rawInput"].clone(),
        },
        parent: parent_of(update),
    })
}

fn tool_call_update_event(update: &Value) -> Option<ChatEvent> {
    Some(ChatEvent::ToolCallUpdate {
        id: update["toolCallId"].as_str()?.to_owned(),
        patch: ToolCallPatch {
            title: nullable_text(&update["title"]),
            kind: present(&update["kind"]).map(|kind| named(kind).unwrap_or(ToolKind::Other)),
            status: present(&update["status"])
                .map(|status| named(status).unwrap_or(ToolStatus::Pending)),
            output: present(&update["content"]).map(tool_outputs),
            locations: present(&update["locations"]).map(tool_locations),
            raw_input: update.get("rawInput").cloned(),
        },
    })
}

/// Maps one ACP `session/update` notification payload (the `update` field) to zero or more chat events
pub fn from_session_update(update: &Value) -> Vec<ChatEvent> {
    let event = match update["sessionUpdate"].as_str().unwrap_or_default() {
        kind @ ("agent_message_chunk" | "user_message_chunk") => chat_content(&update["content"])
            .map(|content| ChatEvent::MessageChunk {
                role: if kind == "agent_message_chunk" {
                    ChatRole::Agent
                } else {
                    ChatRole::User
                },
                content,
                parent: parent_of(update),
            }),
        "agent_thought_chunk" => match chat_content(&update["content"]) {
            Some(ChatContent::Text { text }) => Some(ChatEvent::ThoughtChunk {
                text,
                parent: parent_of(update),
            }),
            _ => None,
        },
        "tool_call" => tool_call_event(update),
        "tool_call_update" => tool_call_update_event(update),
        "plan" => Some(ChatEvent::Plan {
            entries: plan_entries(&update["entries"]),
        }),
        "plan_update" => Some(ChatEvent::Plan {
            entries: plan_entries(&update["plan"]["entries"]),
        }),
        "usage_update" => {
            let cost = &update["cost"];
            Some(ChatEvent::Usage {
                used: num(&update["used"]),
                size: num(&update["size"]),
                cost: match (cost["amount"].as_f64(), cost["currency"].as_str()) {
                    (Some(amount), Some(currency)) => Some(Cost {
                        amount,
                        currency: currency.to_owned(),
                    }),
                    _ => None,
                },
            })
        }
        "session_info_update" => update["title"]
            .as_str()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(|title| ChatEvent::Title {
                title: title.to_owned(),
            }),
        "available_commands_update" => Some(ChatEvent::Commands {
            commands: list(&update["availableCommands"])
                .iter()
                .map(|command| ChatCommand {
                    name: text(&command["name"]),
                    description: text(&command["description"]),
                })
                .collect(),
        }),
        "config_option_update" => Some(ChatEvent::Options {
            options: options_from(&json!({ "configOptions": update["configOptions"] })),
        }),
        _ => None,
    };
    event.into_iter().collect()
}

/// A select option's values, either flat or grouped
fn select_values(value: &Value) -> Vec<OptionValue> {
    list(value)
        .iter()
        .flat_map(|item| {
            if item["options"].is_array() {
                return select_values(&item["options"]);
            }
            item["value"]
                .as_str()
                .map(|value| OptionValue {
                    value: value.to_owned(),
                    name: text(&item["name"]),
                    description: nullable_text(&item["description"]),
                })
                .into_iter()
                .collect()
        })
        .collect()
}

/// A prompt response's `usage`, which agents may leave out
pub fn turn_usage(usage: &Value) -> Option<TurnUsage> {
    usage.is_object().then(|| TurnUsage {
        input: num(&usage["inputTokens"]),
        cache_read: num(&usage["cachedReadTokens"]),
        cache_write: num(&usage["cachedWriteTokens"]),
        output: num(&usage["outputTokens"]),
        thought: num(&usage["thoughtTokens"]),
    })
}

/// Config options (select only) or legacy session modes, both surfaced as `ChatOption`s
pub fn options_from(response: &Value) -> Vec<ChatOption> {
    let config = list(&response["configOptions"]);
    if !config.is_empty() {
        return config
            .iter()
            .filter(|option| option["type"] == "select")
            .map(|option| ChatOption {
                id: text(&option["id"]),
                name: text(&option["name"]),
                category: match option["category"].as_str() {
                    Some("model") => OptionCategory::Model,
                    Some("mode") => OptionCategory::Mode,
                    Some("thought_level") => OptionCategory::Effort,
                    _ => OptionCategory::Other,
                },
                current_value: text(&option["currentValue"]),
                values: select_values(&option["options"]),
            })
            .collect();
    }
    let modes = &response["modes"];
    if !modes["availableModes"].is_array() {
        return Vec::new();
    }
    vec![ChatOption {
        id: "mode".into(),
        name: "Mode".into(),
        category: OptionCategory::Mode,
        current_value: text(&modes["currentModeId"]),
        values: list(&modes["availableModes"])
            .iter()
            .map(|mode| OptionValue {
                value: text(&mode["id"]),
                name: text(&mode["name"]),
                description: nullable_text(&mode["description"]),
            })
            .collect(),
    }]
}

/// Maps a `session/request_permission` request's params to a `permission` chat event; None when it has no option
/// to pick, so it is answered as cancelled
pub fn from_permission_request(request_id: &str, params: &Value) -> Option<ChatEvent> {
    let subject = &params["subject"]["toolCall"];
    let tool_call = &params["toolCall"];
    let title = [&params["title"], &tool_call["title"], &subject["title"]]
        .into_iter()
        .map(text)
        .find(|title| !title.is_empty())
        .unwrap_or_default();
    let options: Vec<PermissionOption> = list(&params["options"])
        .iter()
        .filter_map(|option| {
            Some(PermissionOption {
                id: option["optionId"].as_str()?.to_owned(),
                name: text(&option["name"]),
                kind: named(&option["kind"])?,
            })
        })
        .collect();
    (!options.is_empty()).then(|| ChatEvent::Permission {
        request_id: request_id.to_owned(),
        title,
        tool_call_id: nullable_text(&tool_call["toolCallId"])
            .or_else(|| nullable_text(&subject["toolCallId"])),
        options,
    })
}

/// Chat prompt content as ACP `ContentBlock`s for `session/prompt`
pub fn to_prompt_blocks(content: &[ChatContent]) -> Value {
    content
        .iter()
        .map(|item| match item {
            ChatContent::Text { text } => json!({ "type": "text", "text": text }),
            ChatContent::Image { mime_type, data } => {
                json!({ "type": "image", "mimeType": mime_type, "data": data })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The events as the webview gets them, to compare with the Electron tests' literals
    fn events(update: Value) -> Value {
        serde_json::to_value(from_session_update(&update)).unwrap()
    }

    #[test]
    fn message_and_thought_chunks() {
        assert_eq!(
            events(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hi" } })
            ),
            json!([{ "type": "message_chunk", "role": "agent", "content": { "type": "text", "text": "Hi" }, "parent": null }])
        );
        assert_eq!(
            events(
                json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "Fix it" } })
            ),
            json!([{ "type": "message_chunk", "role": "user", "content": { "type": "text", "text": "Fix it" }, "parent": null }])
        );
        assert_eq!(
            events(
                json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "Hmm" } })
            ),
            json!([{ "type": "thought_chunk", "text": "Hmm", "parent": null }])
        );
    }

    #[test]
    fn tool_calls_with_diffs_and_updates_as_patches() {
        assert_eq!(
            events(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "Edit Pricing.tsx",
                "kind": "edit",
                "status": "pending",
                "content": [{ "type": "diff", "path": "/repo/Pricing.tsx", "oldText": "a", "newText": "b" }],
                "locations": [{ "path": "/repo/Pricing.tsx", "line": 3 }],
                "rawInput": { "file_path": "/repo/Pricing.tsx" }
            })),
            json!([{
                "type": "tool_call",
                "call": {
                    "id": "t1",
                    "title": "Edit Pricing.tsx",
                    "kind": "edit",
                    "status": "pending",
                    "output": [{ "type": "diff", "path": "/repo/Pricing.tsx", "oldText": "a", "newText": "b" }],
                    "locations": [{ "path": "/repo/Pricing.tsx", "line": 3 }],
                    "rawInput": { "file_path": "/repo/Pricing.tsx" }
                },
                "parent": null
            }])
        );
        assert_eq!(
            from_session_update(&json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "ok" } }]
            })),
            [ChatEvent::ToolCallUpdate {
                id: "t1".into(),
                patch: ToolCallPatch {
                    status: Some(ToolStatus::Completed),
                    output: Some(vec![ToolOutput::Text { text: "ok".into() }]),
                    ..Default::default()
                }
            }]
        );
    }

    #[test]
    fn plan_usage_commands_options_and_unknown_updates() {
        assert_eq!(
            events(
                json!({ "sessionUpdate": "plan", "entries": [{ "content": "Read", "priority": "high", "status": "completed" }] })
            ),
            json!([{ "type": "plan", "entries": [{ "content": "Read", "priority": "high", "status": "completed" }] }])
        );
        assert_eq!(
            events(
                json!({ "sessionUpdate": "usage_update", "used": 48000, "size": 200000, "cost": { "amount": 0.04, "currency": "USD" } })
            ),
            json!([{ "type": "usage", "used": 48000, "size": 200000, "cost": { "amount": 0.04, "currency": "USD" } }])
        );
        assert_eq!(
            events(
                json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "name": "compact", "description": "Summarize" }] })
            ),
            json!([{ "type": "commands", "commands": [{ "name": "compact", "description": "Summarize" }] }])
        );
        assert_eq!(
            events(json!({ "sessionUpdate": "something_new" })),
            json!([])
        );
        assert_eq!(events(Value::Null), json!([]));
    }

    #[test]
    fn config_options_and_legacy_modes_both_become_options() {
        let options = |response| serde_json::to_value(options_from(&response)).unwrap();
        assert_eq!(
            options(json!({
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "opus",
                    "options": [
                        { "value": "opus", "name": "Opus" },
                        { "value": "sonnet", "name": "Sonnet", "description": "Faster" }
                    ]
                }]
            })),
            json!([{
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": "opus",
                "values": [
                    { "value": "opus", "name": "Opus", "description": null },
                    { "value": "sonnet", "name": "Sonnet", "description": "Faster" }
                ]
            }])
        );
        assert_eq!(
            options(json!({
                "modes": {
                    "currentModeId": "ask",
                    "availableModes": [{ "id": "ask", "name": "Ask" }, { "id": "code", "name": "Code" }]
                }
            })),
            json!([{
                "id": "mode",
                "name": "Mode",
                "category": "mode",
                "currentValue": "ask",
                "values": [
                    { "value": "ask", "name": "Ask", "description": null },
                    { "value": "code", "name": "Code", "description": null }
                ]
            }])
        );
    }

    #[test]
    fn config_options_flatten_grouped_select_values_and_skip_entries_without_a_value() {
        let options = options_from(&json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "opus",
                "options": [
                    {
                        "group": "g1",
                        "name": "Anthropic",
                        "options": [{ "value": "opus", "name": "Opus" }, { "value": "sonnet", "name": "Sonnet" }]
                    },
                    { "group": "g2", "name": "Other", "options": [{ "name": "No value" }] }
                ]
            }]
        }));
        assert_eq!(
            serde_json::to_value(options).unwrap(),
            json!([{
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": "opus",
                "values": [
                    { "value": "opus", "name": "Opus", "description": null },
                    { "value": "sonnet", "name": "Sonnet", "description": null }
                ]
            }])
        );
    }

    fn permission(id: &str, params: Value) -> Value {
        serde_json::to_value(from_permission_request(id, &params)).unwrap()
    }

    #[test]
    fn permission_requests_drop_options_with_an_unknown_kind() {
        assert_eq!(
            permission(
                "r3",
                json!({
                    "toolCall": { "toolCallId": "t1", "title": "Run bun test" },
                    "options": [
                        { "optionId": "a", "name": "Allow once", "kind": "allow_once" },
                        { "optionId": "x", "name": "Mystery", "kind": "something_else" }
                    ]
                })
            ),
            json!({ "type": "permission", "requestId": "r3", "title": "Run bun test", "toolCallId": "t1", "options": [{ "id": "a", "name": "Allow once", "kind": "allow_once" }] })
        );
    }

    #[test]
    fn permission_requests_keep_option_order_and_the_tool_call_link() {
        assert_eq!(
            permission(
                "r1",
                json!({
                    "toolCall": { "toolCallId": "t1", "title": "Run bun test" },
                    "options": [
                        { "optionId": "a", "name": "Allow once", "kind": "allow_once" },
                        { "optionId": "d", "name": "Reject", "kind": "reject_once" }
                    ]
                })
            ),
            json!({
                "type": "permission",
                "requestId": "r1",
                "title": "Run bun test",
                "toolCallId": "t1",
                "options": [
                    { "id": "a", "name": "Allow once", "kind": "allow_once" },
                    { "id": "d", "name": "Reject", "kind": "reject_once" }
                ]
            })
        );
    }

    #[test]
    fn permission_requests_read_title_and_tool_call_id_from_the_newer_subject_shape() {
        assert_eq!(
            permission(
                "r2",
                json!({
                    "title": "Delete file",
                    "subject": { "toolCall": { "toolCallId": "t2", "title": "rm old.txt" } },
                    "options": [{ "optionId": "a", "name": "Allow once", "kind": "allow_once" }]
                })
            ),
            json!({ "type": "permission", "requestId": "r2", "title": "Delete file", "toolCallId": "t2", "options": [{ "id": "a", "name": "Allow once", "kind": "allow_once" }] })
        );
    }

    #[test]
    fn prompt_blocks() {
        assert_eq!(
            to_prompt_blocks(&[
                ChatContent::Text { text: "Hi".into() },
                ChatContent::Image {
                    mime_type: "image/png".into(),
                    data: "AAAA".into()
                }
            ]),
            json!([{ "type": "text", "text": "Hi" }, { "type": "image", "mimeType": "image/png", "data": "AAAA" }])
        );
    }

    #[test]
    fn a_permission_request_with_no_option_to_pick_maps_to_none() {
        assert_eq!(
            from_permission_request(
                "r4",
                &json!({ "toolCall": { "toolCallId": "t1", "title": "Run bun test" }, "options": [{ "optionId": "x", "name": "Mystery", "kind": "something_else" }] })
            ),
            None
        );
        assert_eq!(
            from_permission_request("r5", &json!({ "title": "Run bun test", "options": [] })),
            None
        );
    }

    #[test]
    fn turn_usage_reads_a_prompt_response_usage_missing_counts_as_zero() {
        assert_eq!(
            turn_usage(
                &json!({ "totalTokens": 9, "inputTokens": 1, "outputTokens": 2, "cachedReadTokens": 6 })
            ),
            Some(TurnUsage {
                input: 1,
                cache_read: 6,
                cache_write: 0,
                output: 2,
                thought: 0
            })
        );
        assert_eq!(turn_usage(&Value::Null), None);
    }

    #[test]
    fn a_subagents_updates_carry_the_call_that_started_it() {
        let meta = json!({ "claudeCode": { "parentToolUseId": "agent1" } });
        assert_eq!(
            events(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hi" }, "_meta": meta })
            ),
            json!([{ "type": "message_chunk", "role": "agent", "content": { "type": "text", "text": "Hi" }, "parent": "agent1" }])
        );
        assert_eq!(
            events(
                json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "Hmm" }, "_meta": meta })
            ),
            json!([{ "type": "thought_chunk", "text": "Hmm", "parent": "agent1" }])
        );
        let [ChatEvent::ToolCall { call, parent }] = &from_session_update(
            &json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "grep", "_meta": meta }),
        )[..] else {
            panic!("not one tool call")
        };
        assert_eq!(
            (call.id.as_str(), parent.as_deref()),
            ("t1", Some("agent1"))
        );
    }

    #[test]
    fn the_agent_names_the_session() {
        assert_eq!(
            events(
                json!({ "sessionUpdate": "session_info_update", "title": "  Fix login redirect " })
            ),
            json!([{ "type": "title", "title": "Fix login redirect" }])
        );
        assert_eq!(
            events(json!({ "sessionUpdate": "session_info_update", "title": " " })),
            json!([])
        );
    }
}
