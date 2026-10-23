//! Working directory, name, program and start time of a process (the PTY's foreground process group leader).

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

/// The program as typed, from argv[0]: `claude` runs a binary named after its version, so `name` won't do
#[cfg(target_os = "macos")]
pub fn program(pid: i32) -> Option<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // SAFETY: a null buffer asks for the size only
    let sized = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if sized != 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    // SAFETY: buf holds `size` bytes, and sysctl writes at most that and updates `size`
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    // argc, the executable's path, NUL padding, then argv
    let mut fields = buf
        .get(4..size)?
        .split(|&b| b == 0)
        .filter(|f| !f.is_empty());
    fields.next()?;
    basename(fields.next()?)
}

/// Microseconds since the epoch
#[cfg(target_os = "macos")]
pub fn start_time(pid: i32) -> Option<u64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is a zeroed proc_bsdinfo of exactly `size` bytes
    let written =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    (written == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
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

#[cfg(not(target_os = "macos"))]
pub fn program(pid: i32) -> Option<String> {
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    basename(cmdline.split(|&b| b == 0).next()?)
}

fn basename(path: &[u8]) -> Option<String> {
    let name = path.rsplit(|&b| b == b'/').next()?;
    (!name.is_empty()).then(|| String::from_utf8_lossy(name).into_owned())
}

/// Clock ticks since boot; only compared with itself
#[cfg(not(target_os = "macos"))]
pub fn start_time(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name in parentheses may hold spaces; starttime is the 20th field after it
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_own_process() {
        let pid = std::process::id() as i32;
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(super::cwd(pid).map(std::path::PathBuf::from), Some(cwd));
        assert!(super::name(pid).is_some_and(|n| !n.is_empty()));
        let exe = std::env::current_exe().unwrap();
        assert_eq!(
            super::program(pid).as_deref(),
            exe.file_name().and_then(|n| n.to_str())
        );
        let started = super::start_time(pid);
        assert!(started.is_some_and(|t| t > 0));
        assert_eq!(super::start_time(pid), started);
        assert_eq!(super::start_time(1), super::start_time(1));
        assert_ne!(super::start_time(1), started);
    }
}
