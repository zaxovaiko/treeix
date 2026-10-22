//! Jira through Atlassian's `acli` (signed in by the user, never a token of ours). Port of jira/main/acli.ts

use super::{Ticket, TicketDetail, TicketKind, TicketSource};
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

const LIST_LIMIT: &str = "200";
// Search only allows the fields it can print; view takes any field
const SEARCH_FIELDS: &str = "key,summary,status,issuetype,priority,assignee,labels";
const DETAIL_FIELDS: &str =
    "key,summary,status,issuetype,priority,assignee,labels,project,updated,description";

/// Refuses anything but `PROJ-123`, since the key goes into acli's arguments
pub fn checked_key(key: &str) -> Result<&str, String> {
    let valid = key.split_once('-').is_some_and(|(project, number)| {
        project.starts_with(|c: char| c.is_ascii_uppercase())
            && project
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
    });
    if valid {
        Ok(key)
    } else {
        Err(format!("Not a work item key: {key}"))
    }
}

/// `acli jira workitem search --jql <jql> --json`
pub fn search(jql: &str) -> Result<Vec<Ticket>, String> {
    let raw = acli(&[
        "jira",
        "workitem",
        "search",
        "--jql",
        jql,
        "--fields",
        SEARCH_FIELDS,
        "--limit",
        LIST_LIMIT,
        "--json",
    ])?;
    let site = site();
    // acli prints null when nothing matches
    let issues = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    Ok(issues
        .iter()
        .map(|issue| to_ticket(issue, site.as_deref()))
        .collect())
}

pub fn detail(key: &str) -> Result<TicketDetail, String> {
    let raw = acli(&[
        "jira",
        "workitem",
        "view",
        checked_key(key)?,
        "--fields",
        DETAIL_FIELDS,
        "--json",
    ])?;
    let description = adf_to_markdown(&raw["fields"]["description"]);
    Ok(TicketDetail {
        ticket: to_ticket(&raw, site().as_deref()),
        description,
    })
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// Jira REST issue JSON, which `acli --json` prints
pub fn to_ticket(issue: &Value, site: Option<&str>) -> Ticket {
    let fields = &issue["fields"];
    let key = text(&issue["key"]).to_string();
    let kind = match text(&fields["issuetype"]["name"]).to_lowercase().as_str() {
        "bug" => TicketKind::Bug,
        "story" => TicketKind::Story,
        _ => TicketKind::Task,
    };
    // Search can't return the project, so the key prefix stands in
    let project = non_empty(text(&fields["project"]["name"]))
        .or_else(|| key.split_once('-').map(|(prefix, _)| prefix.to_string()));
    Ticket {
        url: site
            .filter(|_| !key.is_empty())
            .map(|site| format!("https://{site}/browse/{key}")),
        title: text(&fields["summary"]).to_string(),
        status: text(&fields["status"]["name"]).to_string(),
        updated_at: non_empty(text(&fields["updated"])),
        source: TicketSource::Jira,
        kind,
        project,
        key,
    }
}

/// The signed-in site from `acli jira auth status`, e.g. team.atlassian.net; acli's JSON only links internal hosts
pub fn parse_site(status: &str) -> Option<String> {
    let rest = &status[status.find("Site:")? + "Site:".len()..];
    rest.split_whitespace().next().map(str::to_string)
}

fn site() -> Option<String> {
    static SITE: OnceLock<String> = OnceLock::new();
    if let Some(site) = SITE.get() {
        return Some(site.clone());
    }
    let site = parse_site(&run(&["jira", "auth", "status"]).ok()?)?;
    Some(SITE.get_or_init(|| site).clone())
}

/// acli's message, made to read as one line with a sign-in hint that runs
pub fn failure(stderr: &str) -> String {
    let first = stderr.trim().lines().next().unwrap_or_default();
    let first = first.trim_start_matches(['✗', '×', '✕']).trim_start();
    let first = match first.get(..6) {
        Some(lead) if lead.eq_ignore_ascii_case("error:") => first[6..].trim_start(),
        _ => first,
    };
    let line = ["'acli [product] auth login'", "acli [product] auth login"]
        .iter()
        .find(|hint| first.contains(*hint))
        .map_or_else(
            || first.to_string(),
            |hint| first.replacen(hint, "acli jira auth login --web in a terminal", 1),
        );
    let mut chars = line.chars();
    chars
        .next()
        .map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

// ponytail: no timeout; acli gives up on its own network timeouts
fn run(args: &[&str]) -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let out = Command::new(crate::mcp::program("acli", &home))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                "Atlassian CLI not found. Install it with: brew tap atlassian/homebrew-acli && brew install acli".to_string()
            }
            _ => format!("acli: {e}"),
        })?;
    if !out.status.success() {
        let message = failure(&String::from_utf8_lossy(&out.stderr));
        return Err(if message.is_empty() {
            format!("acli failed ({})", out.status)
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn acli(args: &[&str]) -> Result<Value, String> {
    serde_json::from_str(&run(args)?).map_err(|e| format!("acli printed no JSON: {e}"))
}

/// Markdown from Atlassian Document Format; images and macros are left out, the text is what an agent reads
pub fn adf_to_markdown(doc: &Value) -> String {
    if let Some(text) = doc.as_str() {
        return tidy(text);
    }
    children(doc)
        .iter()
        .map(|block| tidy(&convert(block)))
        .filter(|block| !block.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn tidy(markdown: &str) -> String {
    let mut out = markdown.trim().to_string();
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    out
}

fn children(node: &Value) -> &[Value] {
    node["content"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn inline(node: &Value) -> String {
    children(node).iter().map(convert).collect()
}

fn indent(block: &str, prefix: &str) -> String {
    block
        .trim_end()
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn list(node: &Value, marker: impl Fn(usize, &Value) -> String) -> String {
    let items: Vec<String> = children(node)
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let head = marker(index, item);
            let mut body = inline(item).trim().to_string();
            // Paragraphs inside an item would otherwise split the list
            while body.contains("\n\n") {
                body = body.replace("\n\n", "\n");
            }
            match body.split_once('\n') {
                Some((first, rest)) => {
                    format!("{head}{first}\n{}", indent(rest, &" ".repeat(head.len())))
                }
                None => format!("{head}{body}"),
            }
        })
        .collect();
    format!("{}\n\n", items.join("\n"))
}

fn plain(node: &Value) -> String {
    if node["type"] == "text" {
        return text(&node["text"]).to_string();
    }
    let separator = if node["type"] == "paragraph" {
        "\n"
    } else {
        ""
    };
    children(node)
        .iter()
        .map(plain)
        .collect::<Vec<_>>()
        .join(separator)
}

fn link_label(url: &str) -> &str {
    url.split_once("/browse/")
        .map(|(_, key)| key.split(['?', '#', '/']).next().unwrap_or(key))
        .filter(|key| checked_key(key).is_ok())
        .unwrap_or(url)
}

fn marked(node: &Value) -> String {
    let mut value = text(&node["text"]).to_string();
    for mark in node["marks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        value = match text(&mark["type"]) {
            "code" => format!("`{value}`"),
            "strong" => format!("**{value}**"),
            "em" => format!("*{value}*"),
            "strike" => format!("~~{value}~~"),
            "link" if !text(&mark["attrs"]["href"]).is_empty() => {
                format!("[{value}]({})", text(&mark["attrs"]["href"]))
            }
            _ => value,
        };
    }
    value
}

fn convert(node: &Value) -> String {
    let attrs = &node["attrs"];
    match text(&node["type"]) {
        "text" => marked(node),
        "hardBreak" => "  \n".into(),
        "mention" => format!("@{}", text(&attrs["text"]).trim_start_matches('@')),
        "emoji" => {
            non_empty(text(&attrs["text"])).unwrap_or_else(|| text(&attrs["shortName"]).to_string())
        }
        "status" => format!("**[{}]**", text(&attrs["text"])),
        "inlineCard" | "blockCard" | "embedCard" => {
            let url = text(&attrs["url"]);
            match (url.is_empty(), node["type"] == "inlineCard") {
                (true, _) => String::new(),
                (false, true) => format!("[{}]({url})", link_label(url)),
                (false, false) => format!("[{}]({url})\n\n", link_label(url)),
            }
        }
        "paragraph" | "mediaSingle" | "mediaGroup" => format!("{}\n\n", inline(node)),
        "heading" => {
            let level = attrs["level"].as_u64().unwrap_or(3).clamp(1, 6) as usize;
            format!("{} {}\n\n", "#".repeat(level), inline(node).trim())
        }
        "rule" => "---\n\n".into(),
        "bulletList" => list(node, |_, _| "- ".into()),
        "orderedList" => {
            let start = attrs["order"].as_u64().unwrap_or(1).max(1) as usize;
            list(node, |index, _| format!("{}. ", start + index))
        }
        "taskList" => list(node, |_, item| {
            if item["attrs"]["state"] == "DONE" {
                "- [x] ".into()
            } else {
                "- [ ] ".into()
            }
        }),
        "codeBlock" => format!("```{}\n{}\n```\n\n", text(&attrs["language"]), plain(node)),
        "blockquote" | "panel" => format!("{}\n\n", indent(&inline(node), "> ")),
        "table" => table(node),
        "media" | "mediaInline" | "extension" | "inlineExtension" => String::new(),
        _ => inline(node),
    }
}

fn table(node: &Value) -> String {
    let rows: Vec<Vec<String>> = children(node)
        .iter()
        .map(|row| {
            children(row)
                .iter()
                .map(|cell| {
                    inline(cell)
                        .trim()
                        .split('\n')
                        .filter(|line| !line.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ")
                        .replace('|', "\\|")
                })
                .collect()
        })
        .collect();
    let Some(width) = rows.iter().map(Vec::len).max() else {
        return String::new();
    };
    let line = |cells: &Vec<String>| {
        let cells: Vec<&str> = (0..width)
            .map(|index| cells.get(index).map_or("", String::as_str))
            .collect();
        format!("| {} |", cells.join(" | "))
    };
    let mut lines = vec![line(&rows[0]), format!("|{}", " --- |".repeat(width))];
    lines.extend(rows[1..].iter().map(line));
    format!("{}\n\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_ticket_reads_jira_issue_json_and_builds_the_browse_link() {
        let issue = json!({
            "key": "OPN-412",
            "self": "https://team.atlassian.net/rest/api/3/issue/10001",
            "fields": {
                "summary": "Rate limit behind proxy",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Bug" },
                "priority": { "name": "High" },
                "assignee": null,
                "project": { "name": "Openora" },
                "updated": "2026-09-17T10:00:00.000+0000"
            }
        });
        assert_eq!(
            to_ticket(&issue, Some("team.atlassian.net")),
            Ticket {
                key: "OPN-412".into(),
                source: TicketSource::Jira,
                kind: TicketKind::Bug,
                title: "Rate limit behind proxy".into(),
                status: "In Progress".into(),
                url: Some("https://team.atlassian.net/browse/OPN-412".into()),
                project: Some("Openora".into()),
                updated_at: Some("2026-09-17T10:00:00.000+0000".into()),
            }
        );
    }

    #[test]
    fn to_ticket_falls_back_to_the_key_prefix_and_parse_site_reads_auth_status() {
        let ticket = to_ticket(
            &json!({ "key": "BF-324", "fields": { "summary": "x" } }),
            None,
        );
        assert_eq!(ticket.project.as_deref(), Some("BF"));
        assert_eq!(ticket.url, None);
        assert_eq!(ticket.kind, TicketKind::Task);
        assert_eq!(
            parse_site(
                "✓ Authenticated\n  Site: studiosoftware.atlassian.net\n  Authentication Type: oauth_global"
            )
            .as_deref(),
            Some("studiosoftware.atlassian.net")
        );
        assert_eq!(parse_site("✗ Not signed in"), None);
    }

    #[test]
    fn the_sign_in_hint_names_a_command_that_runs() {
        assert_eq!(
            failure("✗ Error: unauthorized: use 'acli [product] auth login' to authenticate\n"),
            "Unauthorized: use acli jira auth login --web in a terminal to authenticate"
        );
    }

    #[test]
    fn checked_key_refuses_anything_but_a_work_item_key() {
        assert_eq!(checked_key("BF-324"), Ok("BF-324"));
        assert_eq!(checked_key("A_B2-1"), Ok("A_B2-1"));
        for bad in ["bf-1", "BF-", "BF-1a", "-1", "BF-1 --web", "BF--1"] {
            assert!(checked_key(bad).is_err(), "{bad}");
        }
    }

    fn p(content: Vec<Value>) -> Value {
        json!({ "type": "paragraph", "content": content })
    }
    fn t(text: &str) -> Value {
        json!({ "type": "text", "text": text })
    }
    fn marked_text(text: &str, marks: Value) -> Value {
        json!({ "type": "text", "text": text, "marks": marks })
    }

    #[test]
    fn adf_to_markdown_keeps_blocks_apart_and_renders_marks_lists_tasks_tables_and_code() {
        let item = |content: Vec<Value>| json!({ "type": "listItem", "content": content });
        let cell = |kind: &str, text: &str| json!({ "type": kind, "content": [p(vec![t(text)])] });
        let doc = json!({ "type": "doc", "content": [
            { "type": "heading", "attrs": { "level": 2 }, "content": [t("Context")] },
            p(vec![
                t("See "),
                marked_text("spec", json!([{ "type": "link", "attrs": { "href": "https://x.atlassian.net/wiki/spaces/B/pages/42/Wallet+Balance" } }])),
                t(" and "),
                marked_text("code", json!([{ "type": "code" }])),
            ]),
            { "type": "bulletList", "content": [
                item(vec![p(vec![t("one")])]),
                item(vec![p(vec![t("two")]), json!({ "type": "bulletList", "content": [item(vec![p(vec![t("nested")])])] })]),
            ] },
            { "type": "taskList", "content": [
                { "type": "taskItem", "attrs": { "state": "DONE" }, "content": [t("done")] },
                { "type": "taskItem", "attrs": { "state": "TODO" }, "content": [t("todo")] },
            ] },
            { "type": "table", "content": [
                { "type": "tableRow", "content": [cell("tableHeader", "A"), cell("tableHeader", "B")] },
                { "type": "tableRow", "content": [cell("tableCell", "1"), cell("tableCell", "x|y")] },
            ] },
            { "type": "codeBlock", "attrs": { "language": "mermaid" }, "content": [t("graph TD\n  A-->B")] },
            { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "alt": "shot.png", "id": "f1" } }] },
            { "type": "inlineCard", "attrs": { "url": "https://x.atlassian.net/browse/BF-1" } },
        ] });
        assert_eq!(
            adf_to_markdown(&doc),
            [
                "## Context",
                "",
                "See [spec](https://x.atlassian.net/wiki/spaces/B/pages/42/Wallet+Balance) and `code`",
                "",
                "- one",
                "- two",
                "  - nested",
                "",
                "- [x] done",
                "- [ ] todo",
                "",
                "| A | B |",
                "| --- | --- |",
                "| 1 | x\\|y |",
                "",
                "```mermaid",
                "graph TD",
                "  A-->B",
                "```",
                "",
                "[BF-1](https://x.atlassian.net/browse/BF-1)",
            ]
            .join("\n")
        );
    }
}
