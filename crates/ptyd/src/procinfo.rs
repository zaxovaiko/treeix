//! Working directory and name of a process (the PTY's foreground process group leader).

#[cfg(target_os = "macos")]
pub fn cwd(pid: i32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: the buffer is a zeroed proc_vnodepathinfo of exactly `size` bytes
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: the kernel NUL-terminates vip_path within its MAXPATHLEN bytes
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    Some(path.to_string_lossy().into_owned()).filter(|p| !p.is_empty())
}

#[cfg(target_os = "macos")]
pub fn name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: proc_name writes at most buf.len() bytes
    let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&buf[..len as usize]).into_owned())
}

#[cfg(not(target_os = "macos"))]
pub fn cwd(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "macos"))]
pub fn name(pid: i32) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(comm.trim_end().to_owned()).filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_own_process() {
        let pid = std::process::id() as i32;
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(super::cwd(pid).map(std::path::PathBuf::from), Some(cwd));
        assert!(super::name(pid).is_some_and(|n| !n.is_empty()));
    }
}
