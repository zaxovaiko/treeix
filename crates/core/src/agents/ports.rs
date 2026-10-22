//! TCP ports that processes under a Treeix session listen on (`ps` + `lsof`). Port of terminal/main/ports.ts

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionPort {
    pub session: String,
    pub port: u16,
    pub pid: u32,
    /// Process name, like `node`
    pub command: Option<String>,
    /// The listening process's working directory
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub pid: u32,
    pub port: u16,
    pub command: Option<String>,
}

/// `ps -A -o pid=,ppid=`: pid to parent
pub fn parse_parents(ps: &str) -> HashMap<u32, u32> {
    ps.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pair = (fields.next()?.parse().ok()?, fields.next()?.parse().ok()?);
            fields.next().is_none().then_some(pair)
        })
        .collect()
}

/// `lsof -Fpcn`: `p<pid>` starts a process, `c<name>` is what runs it, `n<address>:<port>` names each socket
/// (`*:5173`, `127.0.0.1:3000`, `[::1]:8080`)
pub fn parse_listeners(lsof: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    let mut pid = None;
    let mut command = None;
    for line in lsof.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse().ok().filter(|&p| p > 0);
            command = None;
        } else if let Some(rest) = line.strip_prefix('c') {
            command = (!rest.is_empty()).then(|| rest.to_owned());
        } else if let (Some(rest), Some(pid)) = (line.strip_prefix('n'), pid)
            && let Some((_, port)) = rest.rsplit_once(':')
            && let Ok(port) = port.parse()
        {
            listeners.push(Listener {
                pid,
                port,
                command: command.clone(),
            });
        }
    }
    listeners
}

/// A port belongs to the session whose shell is the listening process or one of its ancestors; once per
/// session and port
pub fn attribute_ports(
    shells: &HashMap<String, u32>,
    parents: &HashMap<u32, u32>,
    listeners: &[Listener],
) -> Vec<SessionPort> {
    let session_of: HashMap<u32, &String> = shells
        .iter()
        .map(|(session, &pid)| (pid, session))
        .collect();
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for listener in listeners {
        let mut visited = HashSet::new();
        let mut current = Some(listener.pid);
        while let Some(pid) =
            current.filter(|&p| p > 1 && !session_of.contains_key(&p) && visited.insert(p))
        {
            current = parents.get(&pid).copied();
        }
        let Some(session) = current.and_then(|pid| session_of.get(&pid)) else {
            continue;
        };
        if seen.insert((*session, listener.port)) {
            found.push(SessionPort {
                session: (*session).clone(),
                port: listener.port,
                pid: listener.pid,
                command: listener.command.clone(),
                cwd: None,
            });
        }
    }
    found
}

/// `lsof -a -p <pids> -d cwd -Fpn`: pid to cwd
pub fn parse_cwds(lsof: &str) -> HashMap<u32, String> {
    let mut cwds = HashMap::new();
    let mut pid = None;
    for line in lsof.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse().ok().filter(|&p: &u32| p > 0);
        } else if let (Some(path), Some(pid)) = (line.strip_prefix('n'), pid) {
            cwds.insert(pid, path.to_owned());
        }
    }
    cwds
}

/// Stdout even on a failed exit: lsof exits 1 when nothing matches
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs ps and lsof for `shells` (session id to shell pid)
pub fn session_ports(shells: &HashMap<String, u32>) -> Result<Vec<SessionPort>, String> {
    if shells.is_empty() {
        return Ok(Vec::new());
    }
    let parents = parse_parents(&run("/bin/ps", &["-A", "-o", "pid=,ppid="])?);
    let lsof = run(
        "/usr/sbin/lsof",
        &["-w", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
    )?;
    let mut found = attribute_ports(shells, &parents, &parse_listeners(&lsof));
    if found.is_empty() {
        return Ok(found);
    }
    let pids: Vec<String> = found
        .iter()
        .map(|entry| entry.pid)
        .collect::<HashSet<_>>()
        .iter()
        .map(u32::to_string)
        .collect();
    let cwds = parse_cwds(
        &run(
            "/usr/sbin/lsof",
            &["-w", "-a", "-p", &pids.join(","), "-d", "cwd", "-Fpn"],
        )
        .unwrap_or_default(),
    );
    for entry in &mut found {
        entry.cwd = cwds.get(&entry.pid).cloned();
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "    1     0
  500     1
  501   500
  502   501
  600     1
  700   600
  900     1
";

    const LSOF: &str = "p502
cnode
f12
n*:5173
f13
n[::1]:5173
p700
cbun
f20
n127.0.0.1:3000
f21
n[::1]:8080
p900
cpython3
f5
n*:7000
";

    fn listener(pid: u32, port: u16, command: Option<&str>) -> Listener {
        Listener {
            pid,
            port,
            command: command.map(str::to_owned),
        }
    }

    fn port(session: &str, port: u16, pid: u32, command: Option<&str>) -> SessionPort {
        SessionPort {
            session: session.into(),
            port,
            pid,
            command: command.map(str::to_owned),
            cwd: None,
        }
    }

    fn shells(pairs: &[(&str, u32)]) -> HashMap<String, u32> {
        pairs.iter().map(|&(s, p)| (s.to_owned(), p)).collect()
    }

    #[test]
    fn reads_pid_and_parent_pairs_from_ps() {
        let parents = parse_parents(PS);
        assert_eq!(parents.get(&502), Some(&501));
        assert_eq!(parents.get(&1), Some(&0));
        assert_eq!(parents.len(), 7);
    }

    #[test]
    fn reads_listening_ports_per_pid_from_lsof_whatever_the_address_form() {
        assert_eq!(
            parse_listeners(LSOF),
            [
                listener(502, 5173, Some("node")),
                listener(502, 5173, Some("node")),
                listener(700, 3000, Some("bun")),
                listener(700, 8080, Some("bun")),
                listener(900, 7000, Some("python3")),
            ]
        );
    }

    #[test]
    fn ignores_lines_it_does_not_know_and_names_without_a_port() {
        assert_eq!(parse_listeners("garbage\np12\nnlocalhost\nn*:abc\n\n"), []);
    }

    #[test]
    fn gives_a_port_to_the_session_whose_shell_is_an_ancestor_or_the_process_itself_once_per_session()
     {
        let mut found = attribute_ports(
            &shells(&[("a", 500), ("b", 700)]),
            &parse_parents(PS),
            &parse_listeners(LSOF),
        );
        found.sort_by_key(|p| (p.session.clone(), p.port));
        assert_eq!(
            found,
            [
                port("a", 5173, 502, Some("node")),
                port("b", 3000, 700, Some("bun")),
                port("b", 8080, 700, Some("bun")),
            ]
        );
    }

    #[test]
    fn drops_ports_outside_every_session_and_survives_a_parent_cycle() {
        let parents = HashMap::from([(10, 11), (11, 10)]);
        assert_eq!(
            attribute_ports(&shells(&[("a", 500)]), &parents, &[listener(10, 80, None)]),
            []
        );
    }

    #[test]
    fn the_shell_itself_listening_counts_a_pid_ps_no_longer_lists_does_not() {
        let parents = parse_parents(PS);
        let a = shells(&[("a", 500)]);
        assert_eq!(
            attribute_ports(&a, &parents, &[listener(500, 9000, None)]),
            [port("a", 9000, 500, None)]
        );
        assert_eq!(
            attribute_ports(&a, &parents, &[listener(4242, 9001, None)]),
            []
        );
    }

    #[test]
    fn reads_each_process_working_directory_from_lsof() {
        let cwds = parse_cwds("p502\nfcwd\nn/repo/apps/web\np700\nfcwd\nn/repo/apps/api\n");
        assert_eq!(cwds.get(&502).map(String::as_str), Some("/repo/apps/web"));
        assert_eq!(cwds.get(&700).map(String::as_str), Some("/repo/apps/api"));
        assert!(parse_cwds("garbage\nn/orphan\n").is_empty());
    }
}
