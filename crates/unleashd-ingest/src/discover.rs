//! Which paths under a provider root are sources, both for the initial walk and for classifying
//! a watcher event. The layouts are those of the TS adapters' `discoverFiles`.

use crate::model::{Format, Root};
use std::fs;
use std::path::{Path, PathBuf};

fn entries(dir: &Path) -> Vec<(PathBuf, fs::FileType, String)> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    read.flatten().filter_map(|e| Some((e.path(), e.file_type().ok()?, e.file_name().to_str()?.to_string()))).collect()
}

/// Non-hidden subdirectories (`getProjectDirectories`).
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    entries(dir).into_iter().filter(|(_, t, n)| t.is_dir() && !n.starts_with('.')).map(|(p, _, _)| p).collect()
}

/// Regular files (not symlinks) with an extension.
fn files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    entries(dir).into_iter().filter(|(_, t, n)| t.is_file() && n.ends_with(ext)).map(|(p, _, _)| p).collect()
}

fn muse_walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for (path, kind, name) in entries(dir) {
        if kind.is_dir() {
            muse_walk(&path, out);
        } else if kind.is_file() && (name.ends_with(".jsonl") || name.ends_with(".json")) {
            out.push(path);
        }
    }
}

/// Every source under a root. OpenCode sources are session directories.
pub fn discover(root: &Root) -> Vec<PathBuf> {
    let base = Path::new(&root.path);
    match root.format {
        Format::Pi => subdirs(base).iter().flat_map(|d| files(d, ".jsonl")).collect(),
        Format::Claude => subdirs(base).iter().flat_map(|d| files(d, ".jsonl")).collect(),
        Format::Codex => {
            subdirs(base).iter().flat_map(|y| subdirs(y)).flat_map(|m| subdirs(&m)).flat_map(|d| files(&d, ".jsonl")).collect()
        }
        Format::Cursor => {
            subdirs(base).iter().flat_map(|p| subdirs(&p.join("agent-transcripts"))).flat_map(|s| files(&s, ".jsonl")).collect()
        }
        Format::Gemini => subdirs(base)
            .iter()
            .flat_map(|p| files(&p.join("chats"), ".json"))
            .filter(|f| f.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("session-")))
            .collect(),
        Format::Opencode => subdirs(&base.join("message")),
        Format::Muse => {
            let mut out = Vec::new();
            muse_walk(base, &mut out);
            // Sub-agent sessions are task children, not conversations.
            out.retain(|p| !p.to_string_lossy().contains("/subagent/"));
            out
        }
    }
}

/// What a watcher event under a root means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Touched {
    Source(PathBuf),
    /// OpenCode spreads one session over three trees keyed by different ids; any change under
    /// its storage re-checks every session's composite stamp.
    WholeRoot,
    Unrelated,
}

pub fn classify(root: &Root, path: &Path) -> Touched {
    let Ok(rel) = path.strip_prefix(&root.path) else { return Touched::Unrelated };
    let parts: Vec<&str> = rel.iter().filter_map(|p| p.to_str()).collect();
    let name = parts.last().copied().unwrap_or("");
    let visible = |i: usize| parts.get(i).is_some_and(|p| !p.starts_with('.'));
    let is_source = match root.format {
        Format::Pi => parts.len() == 2 && visible(0) && name.ends_with(".jsonl"),
        Format::Claude => parts.len() == 2 && visible(0) && name.ends_with(".jsonl"),
        Format::Codex => parts.len() == 4 && visible(0) && visible(1) && visible(2) && name.ends_with(".jsonl"),
        Format::Cursor => parts.len() == 4 && visible(0) && parts[1] == "agent-transcripts" && visible(2) && name.ends_with(".jsonl"),
        Format::Gemini => parts.len() == 3 && visible(0) && parts[1] == "chats" && name.starts_with("session-") && name.ends_with(".json"),
        Format::Muse => (name.ends_with(".jsonl") || name.ends_with(".json")) && !parts.contains(&"subagent"),
        Format::Opencode => return Touched::WholeRoot,
    };
    if is_source { Touched::Source(path.to_path_buf()) } else { Touched::Unrelated }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_map_to_sources_by_layout() {
        let codex = Root { format: Format::Codex, path: "/r".into() };
        assert_eq!(classify(&codex, Path::new("/r/2026/09/25/rollout-x.jsonl")), Touched::Source("/r/2026/09/25/rollout-x.jsonl".into()));
        assert_eq!(classify(&codex, Path::new("/r/2026/09/rollout-x.jsonl")), Touched::Unrelated);
        let claude = Root { format: Format::Claude, path: "/c".into() };
        assert_eq!(classify(&claude, Path::new("/c/-Users-me/abc.jsonl")), Touched::Source("/c/-Users-me/abc.jsonl".into()));
        assert_eq!(classify(&claude, Path::new("/c/-Users-me/abc/subagents/x.jsonl")), Touched::Unrelated);
        let muse = Root { format: Format::Muse, path: "/m".into() };
        assert_eq!(classify(&muse, Path::new("/m/2026/09/25/id/subagent/s/session.jsonl")), Touched::Unrelated);
    }
}
