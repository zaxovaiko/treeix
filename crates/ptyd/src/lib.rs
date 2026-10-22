//! `treeix-ptyd`: the daemon that owns every PTY. The app is a client over a Unix socket
//! (`treeix_proto`), so shells outlive app restarts.

mod osc;
mod procinfo;
mod server;
mod session;
mod snapshot;
mod state;

pub mod client;

use anyhow::Context;
use server::Daemon;
use std::fs;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tokio::net::UnixListener;

pub const BUILD: &str = match option_env!("TREEIX_BUILD") {
    Some(build) => build,
    None => env!("CARGO_PKG_VERSION"),
};

pub struct Opts {
    pub data_dir: PathBuf,
    pub socket: PathBuf,
    /// SIGTERM/SIGINT snapshot and exit; off for in-process servers so tests keep Ctrl-C
    pub handle_signals: bool,
}

/// Serves until Shutdown or a signal. Returns at once when another daemon holds the data dir
pub fn run(opts: Opts) -> anyhow::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&opts.data_dir)?;
    fs::set_permissions(&opts.data_dir, fs::Permissions::from_mode(0o700))?;
    init_logging(&opts.data_dir);
    let Some(_lock) = lock_data_dir(&opts.data_dir)? else {
        tracing::info!("another daemon owns {}; exiting", opts.data_dir.display());
        return Ok(());
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(opts));
    runtime.shutdown_timeout(Duration::from_millis(500));
    result
}

/// One daemon per data dir: two would race on the socket and on state.json. The flock goes with the
/// process, so a SIGKILLed daemon never leaves a stale lock
fn lock_data_dir(data_dir: &Path) -> anyhow::Result<Option<fs::File>> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("ptyd.lock"))?;
    // SAFETY: flock on a descriptor this function owns
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let e = std::io::Error::last_os_error();
    if e.kind() == std::io::ErrorKind::WouldBlock {
        Ok(None)
    } else {
        Err(e).context("locking ptyd.lock")
    }
}

async fn serve(opts: Opts) -> anyhow::Result<()> {
    let socket = opts.socket;
    if let Some(parent) = socket.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(&socket);
    let listener =
        UnixListener::bind(&socket).with_context(|| format!("binding {}", socket.display()))?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;

    let daemon = Daemon::load(opts.data_dir.clone(), BUILD.to_owned());
    daemon.save_state(false);
    daemon.spawn_timers();
    tracing::info!(
        "listening on {} (build {BUILD}, pid {})",
        socket.display(),
        std::process::id()
    );

    let accept = async {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let daemon = daemon.clone();
                    tokio::spawn(async move {
                        if let Err(e) = daemon.serve(stream).await {
                            tracing::warn!("client: {e:#}");
                        }
                    });
                }
                Err(e) => tracing::error!("accept: {e}"),
            }
        }
    };
    tokio::select! {
        () = accept => {}
        () = daemon.shutdown.notified() => {}
        () = signals(opts.handle_signals) => {}
    }
    daemon.stop();
    drop(listener);
    // The lock is still held, so the socket is ours
    let _ = fs::remove_file(&socket);
    // Let client writers flush the last replies (Shutdown's Ok)
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(())
}

async fn signals(enabled: bool) {
    use tokio::signal::unix::{SignalKind, signal};
    if !enabled {
        return std::future::pending().await;
    }
    let (Ok(mut term), Ok(mut int)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

fn init_logging(data_dir: &Path) {
    let Ok(file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("ptyd.log"))
    else {
        return;
    };
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    // In-process servers (tests) share one global subscriber; the first wins
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(Mutex::new(file))
        .try_init();
}

/// Runs a server on a thread and returns once its socket accepts connections (tests, bench)
pub fn spawn_in_process(data_dir: PathBuf) -> std::thread::JoinHandle<anyhow::Result<()>> {
    let socket = data_dir.join("ptyd.sock");
    let handle = std::thread::spawn({
        let socket = socket.clone();
        move || {
            run(Opts {
                data_dir,
                socket,
                handle_signals: false,
            })
        }
    });
    for _ in 0..500 {
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() || handle.is_finished() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    handle
}
