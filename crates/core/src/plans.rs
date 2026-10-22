//! Claude Code's plans (`~/.claude/plans/*.md`) for the plan pane, like the Electron plugins/plans/main/plans.ts.
//! Owner: G7

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// One plan file
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    /// File name, like `snug-wiggling-cat.md`; what `read` takes
    pub name: String,
    pub path: String,
    /// The first `# heading`, else the name without `.md`
    pub title: String,
    /// Unix ms
    pub modified_at: u64,
}

/// Claude Code's default `plansDirectory`
pub fn dir(home: &Path) -> PathBuf {
    home.join(".claude").join("plans")
}

/// The first `# heading`, trimmed, else `fallback`
pub fn title(markdown: &str, fallback: &str) -> String {
    markdown
        .lines()
        .find_map(|line| {
            let rest = line.strip_prefix('#')?;
            (rest.starts_with([' ', '\t']) && !rest.trim().is_empty())
                .then(|| rest.trim().to_owned())
        })
        .unwrap_or_else(|| fallback.to_owned())
}

/// Titles sit at the top, so only the head is read
const TITLE_BYTES: u64 = 4096;

fn title_of(path: &Path, fallback: &str) -> String {
    let mut head = Vec::new();
    let read = fs::File::open(path).and_then(|file| file.take(TITLE_BYTES).read_to_end(&mut head));
    match read {
        Ok(_) => title(&String::from_utf8_lossy(&head), fallback),
        Err(_) => fallback.to_owned(),
    }
}

/// Newest first; no folder is no plans
pub fn list(home: &Path) -> Result<Vec<PlanFile>, String> {
    let dir = dir(home);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut plans: Vec<PlanFile> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stem = name.strip_suffix(".md")?.to_owned();
            let meta = entry.metadata().ok().filter(fs::Metadata::is_file)?;
            let modified_at = meta
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|since| u64::try_from(since.as_millis()).ok())?;
            let path = entry.path();
            Some(PlanFile {
                title: title_of(&path, &stem),
                path: path.to_string_lossy().into_owned(),
                name,
                modified_at,
            })
        })
        .collect();
    plans.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(plans)
}

/// Refuses anything but a `.md` file name in the plans folder
pub fn read(home: &Path, name: &str) -> Result<String, String> {
    let plain = Path::new(name).file_name().is_some_and(|file| file == name);
    if !plain || !name.ends_with(".md") {
        return Err(format!("{name} is not a plan"));
    }
    fs::read_to_string(dir(home).join(name)).map_err(|e| format!("{name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_uses_the_first_top_level_heading() {
        assert_eq!(
            title("intro\n## Context\n# quick-diff: viewer \n", "fallback"),
            "quick-diff: viewer"
        );
        assert_eq!(title("no heading", "fallback"), "fallback");
    }

    #[test]
    fn read_refuses_paths_outside_the_plans_folder() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir(home.path())).unwrap();
        fs::write(home.path().join(".claude/settings.md"), "secret").unwrap();
        for name in [
            "../settings.md",
            "../../.ssh/id_rsa.md",
            "/etc/hosts.md",
            "plan.txt",
            "",
        ] {
            assert!(read(home.path(), name).is_err(), "{name}");
        }
    }

    #[test]
    fn list_is_newest_first_with_titles_and_reads_by_name() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(list(home.path()).unwrap(), []);
        let plans = dir(home.path());
        fs::create_dir_all(&plans).unwrap();
        fs::write(plans.join("old-cat.md"), "# Old plan\n").unwrap();
        fs::write(plans.join("notes.txt"), "# not a plan").unwrap();
        let old = fs::File::options()
            .write(true)
            .open(plans.join("old-cat.md"))
            .unwrap();
        old.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_000))
            .unwrap();
        fs::write(plans.join("new-fox.md"), "no heading\n").unwrap();

        let listed = list(home.path()).unwrap();
        let names: Vec<(&str, &str)> = listed
            .iter()
            .map(|plan| (plan.name.as_str(), plan.title.as_str()))
            .collect();
        assert_eq!(
            names,
            [("new-fox.md", "new-fox"), ("old-cat.md", "Old plan")]
        );
        assert_eq!(listed[1].modified_at, 1_000_000);
        assert_eq!(read(home.path(), "old-cat.md").unwrap(), "# Old plan\n");
    }
}
