//! The ingest loop: bring the store up to date with the provider roots (the initial scan), then
//! apply watcher events. Sources are read in parallel (rayon) and written by this thread in
//! batches, one transaction and one revision per batch.

use crate::discover::{Touched, classify, discover};
use crate::model::{Format, Root};
use crate::paths::ProjectDirResolver;
use crate::read::{Apply, FullReason, Outcome, Stamp, Taken, read_source};
use crate::store::{Committed, Known, Writer};
use rayon::prelude::*;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Counts for one scan or event batch. Every changed source is counted by how it was read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub sources: u64,
    pub unchanged: u64,
    pub resumed: u64,
    pub full: u64,
    /// Why each full read happened: `unseen`, `replaced`, `shrank`, `rewritten`, `document`,
    /// `rebuild:<why>`. A resume that keeps falling back to full reads shows up here.
    pub full_reasons: std::collections::BTreeMap<String, u64>,
    pub removed: u64,
    pub failed: u64,
    pub messages_written: u64,
    pub bytes_read: u64,
    pub malformed_lines: u64,
    pub ms: f64,
    /// Read failures, `path: error`. A failed source keeps its previous stored state.
    pub errors: Vec<String>,
}

/// Outcomes per transaction: large enough that commit cost vanishes, small enough that the
/// reader sees progress during a cold scan.
const BATCH_SOURCES: usize = 256;
const BATCH_MESSAGES: usize = 50_000;
/// Full re-reads of known sources above this size are logged.
const LOUD_FULL_READ_BYTES: u64 = 16 << 20;

pub struct Engine {
    pub roots: Vec<Root>,
    /// Each root's canonical path. FSEvents reports real paths (`/private/var/…` for a root
    /// configured as `/var/…`), and sources are keyed by the configured form.
    canonical: Vec<Option<PathBuf>>,
    writer: Writer,
    resolver: ProjectDirResolver,
    known: HashMap<String, Known>,
}

impl Engine {
    pub fn open(roots: Vec<Root>, db_path: &Path) -> crate::store::Result<Engine> {
        let writer = Writer::open(db_path)?;
        let known = writer.known()?;
        let canonical = roots.iter().map(|r| std::fs::canonicalize(&r.path).ok()).collect();
        Ok(Engine { roots, canonical, writer, resolver: ProjectDirResolver::default(), known })
    }

    pub fn missing_roots(&self) -> Vec<String> {
        self.roots.iter().filter(|r| !Path::new(&r.path).is_dir()).map(|r| r.path.clone()).collect()
    }

    /// The root an event path is under, and the path in that root's configured form.
    fn root_of(&self, path: &Path) -> Option<(Root, PathBuf)> {
        self.roots.iter().zip(&self.canonical).find_map(|(root, canonical)| {
            if path.starts_with(&root.path) {
                return Some((root.clone(), path.to_path_buf()));
            }
            let rest = path.strip_prefix(canonical.as_ref()?).ok()?;
            Some((root.clone(), Path::new(&root.path).join(rest)))
        })
    }

    /// Walk every root and reconcile the store with what exists.
    pub fn scan(&mut self, on_commit: &mut dyn FnMut(&Committed)) -> Report {
        let found: Vec<(Format, PathBuf)> =
            self.roots.par_iter().flat_map_iter(|root| discover(root).into_iter().map(move |p| (root.format, p))).collect();
        let under_roots = |path: &str| self.roots.iter().any(|r| Path::new(path).starts_with(&r.path));
        let present: BTreeSet<String> = found.iter().map(|(_, p)| p.to_string_lossy().into_owned()).collect();
        let gone: Vec<String> = self.known.keys().filter(|p| under_roots(p) && !present.contains(*p)).cloned().collect();
        self.process(found, gone, on_commit)
    }

    /// Re-check one root (OpenCode: any change under it).
    pub fn scan_root(&mut self, root: &Root, on_commit: &mut dyn FnMut(&Committed)) -> Report {
        let found: Vec<(Format, PathBuf)> = discover(root).into_iter().map(|p| (root.format, p)).collect();
        let present: BTreeSet<String> = found.iter().map(|(_, p)| p.to_string_lossy().into_owned()).collect();
        let gone: Vec<String> =
            self.known.keys().filter(|p| Path::new(p).starts_with(&root.path) && !present.contains(*p)).cloned().collect();
        self.process(found, gone, on_commit)
    }

    /// The event paths that name an append-only JSONL source (every format but the Gemini and
    /// OpenCode documents), as given: the watcher watches these directly once written.
    pub fn appendable(&self, paths: &BTreeSet<PathBuf>) -> Vec<PathBuf> {
        paths
            .iter()
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .filter(|p| self.root_of(p).is_some_and(|(root, path)| matches!(classify(&root, &path), Touched::Source(_))))
            .cloned()
            .collect()
    }

    /// Apply a set of changed paths from the watcher.
    pub fn changed(&mut self, paths: BTreeSet<PathBuf>, on_commit: &mut dyn FnMut(&Committed)) -> Report {
        let mut sources = Vec::new();
        let mut gone = Vec::new();
        let mut whole: Vec<Root> = Vec::new();
        for path in paths {
            let Some((root, path)) = self.root_of(&path) else { continue };
            match classify(&root, &path) {
                Touched::Source(p) if p.exists() => sources.push((root.format, p)),
                Touched::Source(p) => gone.push(p.to_string_lossy().into_owned()),
                Touched::WholeRoot => {
                    if !whole.contains(&root) {
                        whole.push(root);
                    }
                }
                Touched::Unrelated => {}
            }
        }
        // An Antigravity database and its WAL can notify in the same batch.
        // Both resolve to the same source, which should be read only once.
        sources.sort_unstable_by(|a, b| a.1.cmp(&b.1));
        sources.dedup();
        let mut report = self.process(sources, gone, on_commit);
        for root in whole {
            let more = self.scan_root(&root, on_commit);
            report.merge(more);
        }
        report
    }

    fn process(&mut self, sources: Vec<(Format, PathBuf)>, gone: Vec<String>, on_commit: &mut dyn FnMut(&Committed)) -> Report {
        let started = Instant::now();
        let mut report = Report { sources: sources.len() as u64, ..Default::default() };
        // Stat in parallel; only sources whose stamp moved are read.
        let stamped: Vec<(Format, PathBuf, Option<Stamp>)> = sources
            .into_par_iter()
            .map(|(format, path)| {
                let stamp = Stamp::of(format, &path).ok();
                (format, path, stamp)
            })
            .collect();
        let mut work = Vec::new();
        for (format, path, stamp) in stamped {
            let key = path.to_string_lossy().into_owned();
            let known = self.known.get(&key);
            if stamp.is_some() && known.is_some_and(|k| k.format == format && Some(k.stamp) == stamp) {
                report.unchanged += 1;
                continue;
            }
            let checkpoint = match known {
                Some(k) if k.format == format => self.writer.checkpoint(k.id).unwrap_or(None),
                _ => None,
            };
            let prior_stamp = known.filter(|k| k.format == format).map(|k| k.stamp);
            work.push((format, path, prior_stamp, checkpoint));
        }
        let resolver = &self.resolver;
        let (tx, rx) = std::sync::mpsc::sync_channel::<(String, Format, std::io::Result<Outcome>)>(BATCH_SOURCES * 2);
        let writer = &mut self.writer;
        let known = &mut self.known;
        std::thread::scope(|scope| {
            scope.spawn(move || {
                work.into_par_iter().for_each_with(tx, |tx, (format, path, prior_stamp, checkpoint)| {
                    let outcome = read_source(format, &path, resolver, prior_stamp, checkpoint);
                    let _ = tx.send((path.to_string_lossy().into_owned(), format, outcome));
                });
            });
            let mut batch: Vec<(String, Format, Outcome)> = Vec::new();
            let mut batch_messages = 0usize;
            for (path, format, outcome) in rx {
                match outcome {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Deleted between the stat and the read.
                        report.removed += 1;
                        batch_remove(writer, known, &[path], on_commit, &mut report);
                    }
                    Err(e) => {
                        report.failed += 1;
                        report.errors.push(format!("{path}: {e}"));
                    }
                    Ok(outcome) => {
                        report.bytes_read += outcome.bytes_read;
                        report.malformed_lines += outcome.malformed_lines;
                        match outcome.taken {
                            Taken::Unchanged => report.unchanged += 1,
                            Taken::Resumed => report.resumed += 1,
                            Taken::Full(reason) => {
                                // A known source read from byte 0 costs its whole size (4 s for the
                                // 934 MB rollout): say so in the server log, never silently.
                                if reason != FullReason::Unseen && outcome.bytes_read > LOUD_FULL_READ_BYTES {
                                    eprintln!("[ingest] full re-read ({}) of {path}: {} MB", reason.label(), outcome.bytes_read >> 20);
                                }
                                report.full += 1;
                                *report.full_reasons.entry(reason.label()).or_default() += 1;
                            }
                        }
                        if quiet(writer, &path, &outcome) {
                            // Nothing shown changed (a touch, a partial line): new stamp, no revision.
                            if writer.restamp(&path, &outcome).is_ok()
                                && let Some(k) = known.get_mut(&path)
                            {
                                k.stamp = outcome.stamp;
                            }
                            continue;
                        }
                        batch_messages += outcome.messages.len();
                        batch.push((path, format, outcome));
                        if batch.len() >= BATCH_SOURCES || batch_messages >= BATCH_MESSAGES {
                            flush(writer, known, &mut batch, &mut report, on_commit);
                            batch_messages = 0;
                        }
                    }
                }
            }
            flush(writer, known, &mut batch, &mut report, on_commit);
        });
        if !gone.is_empty() {
            report.removed += gone.len() as u64;
            batch_remove(&mut self.writer, &mut self.known, &gone, on_commit, &mut report);
        }
        report.ms = started.elapsed().as_secs_f64() * 1000.0;
        report
    }
}

fn flush(
    writer: &mut Writer,
    known: &mut HashMap<String, Known>,
    batch: &mut Vec<(String, Format, Outcome)>,
    report: &mut Report,
    on_commit: &mut dyn FnMut(&Committed),
) {
    if batch.is_empty() {
        return;
    }
    let stamps: HashMap<String, (Format, Stamp)> = batch.iter().map(|(p, f, o)| (p.clone(), (*f, o.stamp))).collect();
    let count = batch.len() as u64;
    match writer.apply(std::mem::take(batch), &[]) {
        Ok(committed) => {
            for (path, id) in &committed.sources {
                let (format, stamp) = stamps[path];
                known.insert(path.clone(), Known { id: *id, format, stamp });
            }
            report.messages_written += committed.messages_written;
            on_commit(&committed);
        }
        Err(e) => {
            report.failed += count;
            report.errors.push(format!("store: {e}"));
        }
    }
}

/// A resumed read that added nothing and left the row as stored.
fn quiet(writer: &Writer, path: &str, outcome: &Outcome) -> bool {
    if !matches!(outcome.taken, Taken::Resumed)
        || outcome.apply != Apply::Append
        || !outcome.messages.is_empty()
        || !outcome.turns.is_empty()
    {
        return false;
    }
    let Some(row) = &outcome.row else { return false };
    // A Muse `model_completed` or a Codex rate-limit refresh changes only these.
    match writer.extras_of(path) {
        Ok((context, limits)) if context == row.facts.context && limits == row.facts.rate_limits => {}
        _ => return false,
    }
    match writer.row_of(path) {
        Ok(Some(stored)) => {
            stored.session_id == row.facts.session_id
                && stored.message_count == row.message_count
                && stored.activity_at == row.activity_at
                && stored.label == row.label
                && stored.usage == row.facts.usage
                && stored.observed_model == row.facts.model
                && stored.title == row.facts.title
                && stored.identity == row.identity
        }
        _ => false,
    }
}

fn batch_remove(
    writer: &mut Writer,
    known: &mut HashMap<String, Known>,
    paths: &[String],
    on_commit: &mut dyn FnMut(&Committed),
    report: &mut Report,
) {
    match writer.apply(Vec::new(), paths) {
        Ok(committed) => {
            for p in paths {
                known.remove(p);
            }
            on_commit(&committed);
        }
        Err(e) => report.errors.push(format!("store: {e}")),
    }
}

impl Report {
    pub fn merge(&mut self, other: Report) {
        self.sources += other.sources;
        self.unchanged += other.unchanged;
        self.resumed += other.resumed;
        self.full += other.full;
        for (reason, n) in other.full_reasons {
            *self.full_reasons.entry(reason).or_default() += n;
        }
        self.removed += other.removed;
        self.failed += other.failed;
        self.messages_written += other.messages_written;
        self.bytes_read += other.bytes_read;
        self.malformed_lines += other.malformed_lines;
        self.ms += other.ms;
        self.errors.extend(other.errors);
    }
}
