//! Starts `treeix-ptyd` so it outlives the app: a launchd agent on macOS, a systemd user unit on Linux, a detached
//! process when neither applies (dev builds, `TREEIX_DATA_DIR`, unsigned bundles, no user systemd).
//! A service can't see `TREEIX_DATA_DIR`, and dev builds must not leave one registered.

use std::io;
use std::path::{Path, PathBuf};

/// Tauri puts the sidecar next to the app binary, in the bundle and in dev
fn sidecar() -> io::Result<PathBuf> {
    Ok(std::env::current_exe()?.with_file_name("treeix-ptyd"))
}

fn custom_data_dir() -> bool {
    std::env::var_os("TREEIX_DATA_DIR").is_some()
}

pub fn start() -> io::Result<()> {
    let sidecar = sidecar()?;
    match platform::start_service(&sidecar) {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => tracing::warn!("daemon service unavailable, spawning the daemon: {e}"),
    }
    spawn_detached(&sidecar)
}

#[cfg(target_os = "macos")]
mod platform {
    use smappservice_rs::{AppService, ServiceManagementError, ServiceStatus, ServiceType};
    use std::io;
    use std::path::Path;
    use std::process::Command;

    const LABEL: &str = "com.dyvertex.treeix.next.ptyd";
    const PLIST: &str = "com.dyvertex.treeix.next.ptyd.plist";

    #[derive(Debug, PartialEq)]
    pub(super) enum Plan {
        Spawn,
        Register,
        /// Registered: launchd owns it, but may be throttling it after a crash loop
        Kickstart,
    }

    /// Only from an installed bundle: SMAppService resolves the plist inside it
    pub(super) fn wants_agent(sidecar: &Path, custom_data_dir: bool) -> bool {
        sidecar.to_string_lossy().contains(".app/Contents/MacOS/") && !custom_data_dir
    }

    pub(super) fn plan(status: ServiceStatus) -> Plan {
        match status {
            ServiceStatus::Enabled => Plan::Kickstart,
            // Switched off in System Settings > Login Items: respect it
            ServiceStatus::RequiresApproval => Plan::Spawn,
            ServiceStatus::NotRegistered | ServiceStatus::NotFound => Plan::Register,
        }
    }

    /// Whether launchd now runs the daemon
    pub(super) fn registered(
        result: Result<(), ServiceManagementError>,
        status: ServiceStatus,
    ) -> io::Result<bool> {
        match result {
            Ok(()) | Err(ServiceManagementError::AlreadyRegistered) => {
                Ok(status == ServiceStatus::Enabled)
            }
            Err(e) => Err(io::Error::other(format!("launch agent registration: {e}"))),
        }
    }

    /// Ok(false) when the daemon should be spawned by hand instead
    pub fn start_service(sidecar: &Path) -> io::Result<bool> {
        if !wants_agent(sidecar, super::custom_data_dir()) {
            return Ok(false);
        }
        let service = AppService::new(ServiceType::Agent { plist_name: PLIST });
        match plan(service.status()) {
            Plan::Spawn => Ok(false),
            Plan::Register => registered(service.register(), service.status()),
            Plan::Kickstart => {
                // SAFETY: getuid cannot fail
                let target = format!("gui/{}/{LABEL}", unsafe { libc::getuid() });
                let status = Command::new("launchctl")
                    .args(["kickstart", &target])
                    .status()?;
                if status.success() {
                    Ok(true)
                } else {
                    Err(io::Error::other(format!(
                        "launchctl kickstart {target}: {status}"
                    )))
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    const UNIT: &str = "treeix-ptyd.service";

    pub(super) fn wants_unit(custom_data_dir: bool) -> bool {
        !cfg!(debug_assertions) && !custom_data_dir
    }

    /// systemd restarts it after a crash and after a newer app asks it to step aside
    pub(super) fn unit(sidecar: &Path) -> String {
        let exec = sidecar
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%");
        format!(
            "[Unit]\nDescription=Treeix terminal daemon\n\n[Service]\nExecStart=\"{exec}\"\nRestart=on-failure\nRestartSec=1\n\n[Install]\nWantedBy=default.target\n"
        )
    }

    fn unit_path() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
        Some(config.join("systemd/user").join(UNIT))
    }

    fn systemctl(args: &[&str]) -> io::Result<()> {
        let status = Command::new("systemctl")
            .arg("--user")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "systemctl --user {}: {status}",
                args.join(" ")
            )))
        }
    }

    /// Ok(false) when the daemon should be spawned by hand instead
    pub fn start_service(sidecar: &Path) -> io::Result<bool> {
        if !wants_unit(super::custom_data_dir()) {
            return Ok(false);
        }
        let path = unit_path().ok_or_else(|| io::Error::other("no HOME"))?;
        let unit = unit(sidecar);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(unit.as_str()) {
            std::fs::create_dir_all(path.parent().expect("unit path has a parent"))?;
            std::fs::write(&path, unit)?;
            systemctl(&["daemon-reload"])?;
        }
        systemctl(&["enable", "--now", UNIT])?;
        Ok(true)
    }
}

/// Leaves the app's session so it outlives the app and its terminal; stderr goes to data_dir/ptyd.log
fn spawn_detached(sidecar: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let dir = treeix_proto::data_dir();
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("ptyd.log"))?;
    let mut command = Command::new(sidecar);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    // SAFETY: setsid is async-signal-safe
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| io::Error::new(e.kind(), format!("spawning {}: {e}", sidecar.display())))?;
    tracing::info!(pid = child.id(), "spawned daemon {}", sidecar.display());
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::platform::*;
    use std::path::Path;

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_only_from_a_bundle_with_the_default_data_dir() {
        use smappservice_rs::{ServiceManagementError as E, ServiceStatus as S};
        let bundled = Path::new("/Applications/Treeix Next.app/Contents/MacOS/treeix-ptyd");
        assert!(wants_agent(bundled, false));
        assert!(!wants_agent(bundled, true));
        assert!(!wants_agent(
            Path::new("/repo/target/debug/treeix-ptyd"),
            false
        ));

        assert_eq!(plan(S::Enabled), Plan::Kickstart);
        assert_eq!(plan(S::RequiresApproval), Plan::Spawn);
        assert_eq!(plan(S::NotRegistered), Plan::Register);
        assert_eq!(plan(S::NotFound), Plan::Register);

        assert!(registered(Ok(()), S::Enabled).unwrap());
        assert!(registered(Err(E::AlreadyRegistered), S::Enabled).unwrap());
        assert!(
            !registered(Ok(()), S::RequiresApproval).unwrap(),
            "awaiting approval spawns by hand"
        );
        assert!(registered(Err(E::InvalidSignature), S::NotRegistered).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_unit_runs_the_sidecar_and_only_for_release_builds() {
        assert!(!wants_unit(true));
        assert_eq!(wants_unit(false), !cfg!(debug_assertions));
        let unit = unit(Path::new("/opt/Treeix 100%/treeix-ptyd"));
        assert!(unit.contains("ExecStart=\"/opt/Treeix 100%%/treeix-ptyd\"\n"));
        // A second daemon exits 0 when the lock is held: on-failure, or systemd restarts it forever
        assert!(unit.contains("Restart=on-failure"));
    }
}
