//! A minimal daemon client for tests and the bench. The app has its own in src-tauri.

use crate::BUILD;
use anyhow::{Context, bail};
use std::collections::VecDeque;
use std::path::Path;
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use treeix_proto::{
    ClientMsg, Event, PROTO_VERSION, Request, Response, ServerMsg, read_frame, write_frame,
};

pub struct Client {
    reader: OwnedReadHalf,
    writer: OwnedWriteHalf,
    next_id: u64,
    events: VecDeque<Event>,
    /// The daemon's pid from its Hello
    pub pid: u32,
}

impl Client {
    pub async fn connect(socket: &Path) -> anyhow::Result<Self> {
        let (mut reader, mut writer) = UnixStream::connect(socket).await?.into_split();
        write_frame(
            &mut writer,
            &ClientMsg::Hello {
                proto: PROTO_VERSION,
                build: BUILD.to_owned(),
            },
        )
        .await?;
        match read_frame(&mut reader).await? {
            Some(ServerMsg::Hello { pid, .. }) => Ok(Self {
                reader,
                writer,
                next_id: 1,
                events: VecDeque::new(),
                pid,
            }),
            other => bail!("expected Hello, got {other:?}"),
        }
    }

    /// Sends without waiting; the reply is skipped by `next_event`
    pub async fn send(&mut self, req: Request) -> anyhow::Result<u64> {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(&mut self.writer, &ClientMsg::Req { id, req }).await?;
        Ok(id)
    }

    /// Events that arrive before the reply are kept for `next_event`
    pub async fn request(&mut self, req: Request) -> anyhow::Result<Response> {
        let id = self.send(req).await?;
        loop {
            match read_frame(&mut self.reader)
                .await?
                .context("daemon closed the connection")?
            {
                ServerMsg::Resp { id: got, resp } if got == id => {
                    return resp.map_err(anyhow::Error::msg);
                }
                ServerMsg::Event(event) => self.events.push_back(event),
                _ => {}
            }
        }
    }

    /// `None` once the daemon closes the connection
    pub async fn next_event(&mut self) -> anyhow::Result<Option<Event>> {
        if let Some(event) = self.events.pop_front() {
            return Ok(Some(event));
        }
        loop {
            match read_frame(&mut self.reader).await? {
                Some(ServerMsg::Event(event)) => return Ok(Some(event)),
                Some(_) => {}
                None => return Ok(None),
            }
        }
    }
}
