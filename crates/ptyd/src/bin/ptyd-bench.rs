//! `ptyd-bench [--in-process] <file>`: throughput attached and detached (`cat <file>`), echo
//! latency, and daemon RSS with 20 idle shells. Prints JSON.

use anyhow::{Context, bail};
use std::time::{Duration, Instant};
use treeix_proto::{CreateSession, Event, Request, Response, SessionKind};
use treeix_ptyd::client::Client;

fn create(command: &[&str]) -> Request {
    Request::Create(CreateSession {
        kind: SessionKind::Shell,
        cwd: None,
        command: command.iter().map(|s| s.to_string()).collect(),
        env: vec![],
        cols: 120,
        rows: 40,
        title: None,
        routine: None,
    })
}

async fn start(client: &mut Client, command: &[&str]) -> anyhow::Result<String> {
    match client.request(create(command)).await? {
        Response::Created(info) => Ok(info.id),
        other => bail!("{other:?}"),
    }
}

/// Output bytes per second, attached and acking every frame at once
async fn attached_throughput(client: &mut Client, file: &str) -> anyhow::Result<f64> {
    let id = start(
        client,
        &["sh", "-c", &format!("sleep 0.5; exec cat '{file}'")],
    )
    .await?;
    client
        .request(Request::Attach {
            session: id.clone(),
        })
        .await?;
    let (mut bytes, mut first) = (0u64, None);
    loop {
        match client.next_event().await?.context("daemon gone")? {
            Event::Data {
                session,
                bytes: data,
                ..
            } if session == id => {
                first.get_or_insert_with(Instant::now);
                bytes += data.len() as u64;
                client
                    .send(Request::Ack {
                        session: id.clone(),
                        bytes: data.len() as u64,
                    })
                    .await?;
            }
            Event::Exit { session, .. } if session == id => break,
            _ => {}
        }
    }
    let elapsed = first.context("no output")?.elapsed().as_secs_f64();
    client.request(Request::Remove { session: id }).await?;
    Ok(bytes as f64 / elapsed)
}

/// Output bytes per second with nobody attached: the daemon only parses
async fn detached_throughput(client: &mut Client, file: &str) -> anyhow::Result<f64> {
    let started = Instant::now();
    let id = start(client, &["cat", file]).await?;
    loop {
        match client.next_event().await?.context("daemon gone")? {
            Event::Exit { session, .. } if session == id => break,
            _ => {}
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    let Response::Sessions(list) = client.request(Request::List).await? else {
        bail!("List")
    };
    let seq = list
        .iter()
        .find(|s| s.id == id)
        .context("session gone")?
        .seq;
    client.request(Request::Remove { session: id }).await?;
    Ok(seq as f64 / elapsed)
}

/// Milliseconds from writing one byte to its echo arriving, through `cat` in raw mode. Keys go
/// 10 ms apart like fast typing; back to back they would land in the 5 ms output coalescing window
async fn echo_latency(client: &mut Client, samples: usize) -> anyhow::Result<Vec<f64>> {
    let id = start(
        client,
        &["sh", "-c", "stty raw -echo; echo ready; exec cat"],
    )
    .await?;
    client
        .request(Request::Attach {
            session: id.clone(),
        })
        .await?;
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains("ready") {
        if let Event::Data { session, bytes, .. } =
            client.next_event().await?.context("daemon gone")?
            && session == id
        {
            seen.extend_from_slice(&bytes);
        }
    }
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        tokio::time::sleep(Duration::from_millis(10)).await;
        let sent = Instant::now();
        client
            .send(Request::Write {
                session: id.clone(),
                data: b"a".to_vec(),
            })
            .await?;
        loop {
            if let Event::Data { session, bytes, .. } =
                client.next_event().await?.context("daemon gone")?
                && session == id
            {
                client
                    .send(Request::Ack {
                        session: id.clone(),
                        bytes: bytes.len() as u64,
                    })
                    .await?;
                break;
            }
        }
        times.push(sent.elapsed().as_secs_f64() * 1000.0);
    }
    client.request(Request::Remove { session: id }).await?;
    times.sort_by(f64::total_cmp);
    Ok(times)
}

async fn idle_rss_mb(client: &mut Client, shells: usize) -> anyhow::Result<f64> {
    let mut ids = Vec::new();
    for _ in 0..shells {
        ids.push(start(client, &[]).await?);
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    let ps = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &client.pid.to_string()])
        .output()?;
    let kb: f64 = String::from_utf8_lossy(&ps.stdout).trim().parse()?;
    for id in ids {
        client.request(Request::Remove { session: id }).await?;
    }
    Ok(kb / 1024.0)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let in_process = args.iter().any(|a| a == "--in-process");
    let file = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .context("usage: ptyd-bench [--in-process] <file>")?;
    let file_mb = std::fs::metadata(file)?.len() as f64 / 1e6;

    let data_dir = if in_process {
        let dir = std::env::temp_dir().join(format!("ptyd-bench-{}", std::process::id()));
        let _ = tokio::task::spawn_blocking({
            let dir = dir.clone();
            move || treeix_ptyd::spawn_in_process(dir)
        })
        .await?;
        dir
    } else {
        treeix_proto::data_dir()
    };
    let mut client = Client::connect(&data_dir.join("ptyd.sock")).await?;

    let idle_rss = idle_rss_mb(&mut client, 20).await?;
    let attached = attached_throughput(&mut client, file).await?;
    let detached = detached_throughput(&mut client, file).await?;
    let echo = echo_latency(&mut client, 1000).await?;

    if in_process {
        client.request(Request::Shutdown).await?;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
    let report = serde_json::json!({
        "file_mb": file_mb,
        "attached_mb_s": attached / 1e6,
        "detached_mb_s": detached / 1e6,
        "echo_ms": {
            "p50": percentile(&echo, 0.50),
            "p95": percentile(&echo, 0.95),
            "p99": percentile(&echo, 0.99),
        },
        "daemon_rss_mb_20_idle_shells": idle_rss,
        "in_process": in_process,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
