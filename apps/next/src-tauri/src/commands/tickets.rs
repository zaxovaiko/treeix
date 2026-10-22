//! "Your tickets" for the Open worktree dialog: Jira (acli) and Notion, each only while its feature is on.
//! Owner: A5

use super::Result;
use super::files::blocking;
use treeix_core::secrets::{self, Secret};
use treeix_core::settings::Settings;
use treeix_core::tickets::notion::{self, NotionDatabase};
use treeix_core::tickets::{TicketDetail, TicketError, TicketList, TicketSource, acli};

async fn settings() -> Result<Settings> {
    blocking(|| Ok(treeix_core::settings::load(&treeix_proto::data_dir()))).await
}

/// Never sent to the webview
async fn notion_token() -> Result<String> {
    blocking(|| secrets::get(&treeix_proto::data_dir(), Secret::NotionToken))
        .await?
        .ok_or_else(|| notion::NO_TOKEN.to_string())
}

async fn notion_tickets(database: Option<String>) -> Result<Vec<treeix_core::tickets::Ticket>> {
    let database = database.ok_or("Pick the tickets database in Settings > Notion")?;
    notion::my_tickets(&notion_token().await?, &database).await
}

/// Jira items matching the settings' JQL plus the Notion database's pages; a failing source lands in `errors`
#[tauri::command]
#[specta::specta]
pub async fn my_tickets() -> Result<TicketList> {
    let settings = settings().await?;
    let jql = settings.jira.jql.clone();
    let jira = async {
        if settings.features.jira {
            Some(blocking(move || acli::search(&jql)).await)
        } else {
            None
        }
    };
    let notion = async {
        if settings.features.notion {
            Some(notion_tickets(settings.notion.database.clone()).await)
        } else {
            None
        }
    };
    let (jira, notion) = tokio::join!(jira, notion);
    let mut list = TicketList::default();
    for (source, result) in [(TicketSource::Jira, jira), (TicketSource::Notion, notion)] {
        match result {
            Some(Ok(tickets)) => list.tickets.extend(tickets),
            Some(Err(message)) => list.errors.push(TicketError { source, message }),
            None => {}
        }
    }
    Ok(list)
}

#[tauri::command]
#[specta::specta]
pub async fn ticket_detail(source: TicketSource, key: String) -> Result<TicketDetail> {
    match source {
        TicketSource::Jira => blocking(move || acli::detail(&key)).await,
        TicketSource::Notion => notion::detail(&notion_token().await?, &key).await,
    }
}

/// Databases the saved Notion token can see
#[tauri::command]
#[specta::specta]
pub async fn notion_databases() -> Result<Vec<NotionDatabase>> {
    notion::databases(&notion_token().await?).await
}
