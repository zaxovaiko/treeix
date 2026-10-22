//! Notion through its API with the personal access token from the keyring. Port of the Electron notion plugin's api and properties modules

use super::{Ticket, TicketDetail, TicketKind, TicketSource};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::time::Duration;

const API: &str = "https://api.notion.com/v1";
const VERSION: &str = "2026-03-11";
const TIMEOUT: Duration = Duration::from_secs(30);
pub const NO_TOKEN: &str = "No Notion token: add a personal access token in Settings > Notion";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotionDatabase {
    pub id: String,
    pub title: String,
}

/// Notion's error message, a rejected token turned into the fix
pub fn failure(status: u16, reply: &Value) -> String {
    if status == 401 {
        return "Notion rejected the token: make a new personal access token in Settings > Notion"
            .into();
    }
    match reply["message"].as_str() {
        Some(message) if !message.is_empty() => message.into(),
        _ => format!("Notion answered {status}"),
    }
}

async fn notion(
    token: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    if token.is_empty() {
        return Err(NO_TOKEN.into());
    }
    let mut request = reqwest::Client::new()
        .request(method.clone(), format!("{API}{path}"))
        .bearer_auth(token)
        .header("Notion-Version", VERSION)
        .timeout(TIMEOUT);
    if let Some(body) = body {
        request = request.json(&body);
    }
    // Without the URL, which holds nothing secret but is noise
    let response = request
        .send()
        .await
        .map_err(|e| format!("Notion: {}", e.without_url()))?;
    let status = response.status();
    let reply: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(failure(status.as_u16(), &reply));
    }
    if !reply.is_object() {
        return Err(format!("Notion {method} {path} answered no object"));
    }
    Ok(reply)
}

fn plain_text(value: &Value) -> String {
    value
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["plain_text"].as_str())
                .collect()
        })
        .unwrap_or_default()
}

fn properties(value: &Value) -> impl Iterator<Item = (&String, &Value)> {
    value.as_object().into_iter().flatten()
}

/// The text of a page's title property
pub fn page_title(props: &Value) -> String {
    properties(props)
        .find(|(_, property)| property["type"] == "title")
        .map(|(_, property)| plain_text(&property["title"]))
        .unwrap_or_default()
}

/// A page's select and multi-select values, which say what it is about, like its project
pub fn page_labels(props: &Value) -> Vec<String> {
    properties(props)
        .flat_map(|(_, property)| match property["type"].as_str() {
            Some("select") => vec![&property["select"]],
            Some("multi_select") => property["multi_select"]
                .as_array()
                .map(|all| all.iter().collect())
                .unwrap_or_default(),
            _ => vec![],
        })
        .filter_map(|option| option["name"].as_str().map(str::to_string))
        .collect()
}

/// Databases the token can see, for picking the tickets one in Settings
pub async fn databases(token: &str) -> Result<Vec<NotionDatabase>, String> {
    let reply = notion(
        token,
        reqwest::Method::POST,
        "/search",
        Some(
            json!({ "filter": { "property": "object", "value": "data_source" }, "page_size": 100 }),
        ),
    )
    .await?;
    Ok(reply["results"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|source| {
            let id = source["id"].as_str()?.to_string();
            let title = plain_text(&source["title"]);
            Some(NotionDatabase {
                title: if title.is_empty() {
                    "Untitled".into()
                } else {
                    title
                },
                id,
            })
        })
        .collect())
}

/// The person a token acts for: a personal token is the person, an integration names its owner
fn person(me: &Value) -> Option<&str> {
    if me["type"] == "person" {
        return me["id"].as_str();
    }
    me["bot"]["owner"]["user"]["id"].as_str()
}

/// The query filter for open pages assigned to `me`, from the data source's schema
pub fn open_and_mine(schema: &Value, me: &str) -> Result<Value, String> {
    let mut people = None;
    let mut done = vec![];
    for (name, property) in properties(schema) {
        match property["type"].as_str() {
            Some("people") if people.is_none() => people = Some(name),
            Some("status") => {
                let status = &property["status"];
                let complete: Vec<&Value> = status["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|group| group["name"] == "Complete")
                    .flat_map(|group| group["option_ids"].as_array().into_iter().flatten())
                    .collect();
                done.extend(
                    status["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|option| complete.contains(&&option["id"]))
                        .filter_map(|option| option["name"].as_str())
                        .map(|option| json!({ "property": name, "status": { "does_not_equal": option } })),
                );
            }
            _ => {}
        }
    }
    let people =
        people.ok_or("The Notion database has no person property to assign tickets with")?;
    let mut and = vec![json!({ "property": people, "people": { "contains": me } })];
    and.extend(done);
    Ok(json!({ "and": and }))
}

fn to_ticket(page: &Value, project: Option<&str>) -> Ticket {
    let props = &page["properties"];
    let status = properties(props)
        .find(|(_, property)| property["type"] == "status")
        .and_then(|(_, property)| property["status"]["name"].as_str())
        .unwrap_or_default();
    let bug = page_labels(props)
        .iter()
        .any(|label| label.to_lowercase().contains("bug"));
    Ticket {
        key: page["id"].as_str().unwrap_or_default().to_string(),
        source: TicketSource::Notion,
        kind: if bug {
            TicketKind::Bug
        } else {
            TicketKind::Task
        },
        title: page_title(props),
        status: status.to_string(),
        url: page["url"].as_str().map(str::to_string),
        project: project.map(str::to_string),
        updated_at: page["last_edited_time"].as_str().map(str::to_string),
    }
}

fn checked_id(id: &str) -> Result<&str, String> {
    let hex = id.chars().filter(|c| *c != '-').count();
    if hex == 32 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        Ok(id)
    } else {
        Err(format!("Not a Notion id: {id}"))
    }
}

/// Open pages of `database` assigned to the token's person, newest first
pub async fn my_tickets(token: &str, database: &str) -> Result<Vec<Ticket>, String> {
    let database = checked_id(database)?;
    let me = notion(token, reqwest::Method::GET, "/users/me", None).await?;
    let me = person(&me)
        .ok_or("The Notion token belongs to no person")?
        .to_string();
    let schema = notion(
        token,
        reqwest::Method::GET,
        &format!("/data_sources/{database}"),
        None,
    )
    .await?;
    let filter = open_and_mine(&schema["properties"], &me)?;
    let project = plain_text(&schema["title"]);
    let reply = notion(
        token,
        reqwest::Method::POST,
        &format!("/data_sources/{database}/query"),
        Some(json!({
            "filter": filter,
            "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }],
            "page_size": 100,
        })),
    )
    .await?;
    let project = (!project.is_empty()).then_some(project.as_str());
    Ok(reply["results"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|page| to_ticket(page, project))
        .collect())
}

/// The page's body as markdown
pub async fn detail(token: &str, page: &str) -> Result<TicketDetail, String> {
    let page = checked_id(page)?;
    let (meta_path, body_path) = (format!("/pages/{page}"), format!("/pages/{page}/markdown"));
    let (meta, body) = tokio::try_join!(
        notion(token, reqwest::Method::GET, &meta_path, None),
        notion(token, reqwest::Method::GET, &body_path, None),
    )?;
    Ok(TicketDetail {
        ticket: to_ticket(&meta, None),
        description: body["markdown"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_turns_a_rejected_token_into_the_fix_and_keeps_notions_message() {
        assert!(
            failure(401, &json!({ "message": "API token is invalid." }))
                .starts_with("Notion rejected the token")
        );
        assert_eq!(
            failure(404, &json!({ "message": "Could not find data source." })),
            "Could not find data source."
        );
        assert_eq!(failure(502, &Value::Null), "Notion answered 502");
    }

    #[test]
    fn page_title_and_labels_read_notions_property_values() {
        let props = json!({
            "Name": { "type": "title", "title": [{ "plain_text": "Fix " }, { "plain_text": "login" }] },
            "Project": { "type": "select", "select": { "name": "Treeix" } },
            "Tags": { "type": "multi_select", "multi_select": [{ "name": "bug" }, { "name": "ui" }] },
            "Empty": { "type": "select", "select": null },
            "Done": { "type": "checkbox", "checkbox": true }
        });
        assert_eq!(page_title(&props), "Fix login");
        assert_eq!(page_labels(&props), ["Treeix", "bug", "ui"]);
        assert_eq!(page_title(&Value::Null), "");
    }

    #[test]
    fn open_and_mine_filters_on_the_person_and_leaves_out_complete_statuses() {
        let schema = json!({
            "Assignee": { "type": "people", "people": {} },
            "Status": { "type": "status", "status": {
                "options": [{ "id": "a", "name": "To do" }, { "id": "b", "name": "Done" }, { "id": "c", "name": "Won't do" }],
                "groups": [{ "name": "To-do", "option_ids": ["a"] }, { "name": "Complete", "option_ids": ["b", "c"] }]
            } }
        });
        assert_eq!(
            open_and_mine(&schema, "u1").unwrap(),
            json!({ "and": [
                { "property": "Assignee", "people": { "contains": "u1" } },
                { "property": "Status", "status": { "does_not_equal": "Done" } },
                { "property": "Status", "status": { "does_not_equal": "Won't do" } },
            ] })
        );
        assert!(open_and_mine(&json!({}), "u1").is_err());
    }

    #[test]
    fn person_reads_a_personal_token_or_an_integrations_owner() {
        assert_eq!(person(&json!({ "type": "person", "id": "p" })), Some("p"));
        assert_eq!(
            person(
                &json!({ "type": "bot", "id": "b", "bot": { "owner": { "user": { "id": "o" } } } })
            ),
            Some("o")
        );
        assert_eq!(
            person(&json!({ "type": "bot", "bot": { "owner": { "workspace": true } } })),
            None
        );
    }

    #[test]
    fn checked_id_refuses_paths() {
        assert!(checked_id("1f2e3d4c-5b6a-7980-1a2b-3c4d5e6f7a8b").is_ok());
        assert!(checked_id("1f2e3d4c5b6a79801a2b3c4d5e6f7a8b").is_ok());
        assert!(checked_id("../users/me").is_err());
    }
}
