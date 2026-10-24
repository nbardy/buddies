//! Whether a registered workspace folder exists on disk, remembered briefly.
//!
//! Pattern: fix-guards (docs/patterns.md#fix-guards)
//! `workspace_row` called `Path::is_dir()` for every folder of every workspace on every
//! listWorkspaces/overview read, under the store mutex. Existence only changes when a checkout is
//! moved or deleted, so a verdict is reused for `TTL`. Registration (`create_workspace`) does its
//! own uncached `try_exists`, so a stale verdict here can only delay which folder a READ reports
//! as `root_path` (falling back to the stored path), never mis-merge a team.
//! Guard: `a_verdict_is_reused_until_the_ttl_then_re_probed`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(crate) struct FolderProbe {
    verdicts: Mutex<HashMap<String, (Instant, bool)>>,
}

impl FolderProbe {
    /// `stat` is the filesystem question; it runs only when the remembered answer is missing or old.
    pub(crate) fn is_dir_at(&self, folder: &str, now: Instant, stat: impl FnOnce(&str) -> bool) -> bool {
        let mut verdicts = self.verdicts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, exists)) = verdicts.get(folder)
            && now.duration_since(*at) < TTL
        {
            return *exists;
        }
        let exists = stat(folder);
        verdicts.insert(folder.to_string(), (now, exists));
        exists
    }

    /// Registration is the owner changing folders: forget every verdict so the answer it returns
    /// (and the next read) reflects the disk now. Only external moves wait out the TTL.
    pub(crate) fn clear(&self) {
        self.verdicts.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
    }

    pub(crate) fn is_dir(&self, folder: &str) -> bool {
        self.is_dir_at(folder, Instant::now(), |f| std::path::Path::new(f).is_dir())
    }
}

pub(crate) static PROBE: std::sync::LazyLock<FolderProbe> = std::sync::LazyLock::new(FolderProbe::default);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verdict_is_reused_until_the_ttl_then_re_probed() {
        let probe = FolderProbe::default();
        let t0 = Instant::now();
        let calls = std::cell::Cell::new(0);
        let stat = |_: &str| {
            calls.set(calls.get() + 1);
            true
        };
        assert!(probe.is_dir_at("/x", t0, stat));
        assert!(probe.is_dir_at("/x", t0 + Duration::from_secs(1), stat));
        assert_eq!(calls.get(), 1, "second read within the TTL must not stat");
        assert!(probe.is_dir_at("/x", t0 + TTL + Duration::from_secs(1), stat));
        assert_eq!(calls.get(), 2);
    }
}
