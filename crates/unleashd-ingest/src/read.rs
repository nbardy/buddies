//! Pattern: wake-on-write (docs/patterns.md#wake-on-write) — a change reads only the bytes
//! appended since the stored offset.
//! Pattern: sum-types (docs/patterns.md#sum-types) — `FoldState` / `read_source` is the one
//! dispatcher over formats; each parser is one handler.
//!
//! Reading one source: decide between "unchanged", "resume from the stored offset" and "read
//! from byte 0", run the format's parser, and describe the result for the store.

use crate::lines::{fingerprint, for_each_line, line_text};
use crate::markers::{Hints, Rebuild, Visible};
use crate::model::{Cwd, Format, Identity, Message, SubAgent, TimeFrom, Usage, UsageTurn};
use crate::parsers::{self, Ctx, Doc, Facts, Fold, Line, Sink};
use crate::paths::ProjectDirResolver;
use serde::{Deserialize, Serialize};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// What identifies a version of a source on disk. Directories (OpenCode) use their composite
/// mtime and no size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stamp {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime_ms: f64,
}

impl Stamp {
    pub fn of(format: Format, path: &Path) -> io::Result<Stamp> {
        let meta = std::fs::metadata(path)?;
        let file_mtime = meta.mtime() as f64 * 1000.0 + (meta.mtime_nsec() / 1_000_000) as f64;
        Ok(match format {
            Format::Opencode => Stamp { dev: meta.dev(), ino: meta.ino(), size: 0, mtime_ms: parsers::opencode::composite_mtime(path) },
            _ => Stamp { dev: meta.dev(), ino: meta.ino(), size: meta.size(), mtime_ms: file_mtime },
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum FoldState {
    Claude(parsers::claude::ClaudeFold),
    Codex(parsers::codex::CodexFold),
    Cursor(parsers::cursor::CursorFold),
    Muse(parsers::muse::MuseFold),
    Pi(parsers::pi::PiFold),
}

/// Everything needed to resume a JSONL source where the last read stopped. Stored per source.
#[derive(Debug, Serialize, Deserialize)]
pub struct Checkpoint {
    /// Bump when fold identity or stored message content changes; old checkpoints re-read.
    #[serde(default)]
    pub content_version: u8,
    pub offset: u64,
    pub fingerprint: Vec<u8>,
    pub hints: Hints,
    pub next_seq: u32,
    /// The next usage turn's number.
    #[serde(default)]
    pub next_turn: u32,
    pub visible: Visible,
    pub fold: FoldState,
}

/// Why a changed source was read from byte 0 instead of resumed. Reported, never silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullReason {
    Unseen,
    ContentUpgrade,
    /// Another file now has this path (new inode).
    Replaced,
    Shrank,
    /// The bytes before the stored offset changed.
    Rewritten,
    /// A whole-document format (Gemini JSON, OpenCode directory).
    Document,
    /// A resumed read hit a line that changes earlier output.
    Rebuild(Rebuild),
}

impl FullReason {
    pub fn label(&self) -> String {
        match self {
            FullReason::Unseen => "unseen".into(),
            FullReason::ContentUpgrade => "content-upgrade".into(),
            FullReason::Replaced => "replaced".into(),
            FullReason::Shrank => "shrank".into(),
            FullReason::Rewritten => "rewritten".into(),
            FullReason::Document => "document".into(),
            FullReason::Rebuild(why) => format!("rebuild:{why:?}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taken {
    Unchanged,
    Resumed,
    Full(FullReason),
}

/// The session row a read produced, before the store gives it a revision.
#[derive(Debug, Clone, PartialEq)]
pub struct RowData {
    pub facts: Facts,
    pub identity: Identity,
    pub hidden: bool,
    pub swarm_debug_prefix: Option<String>,
    pub resumed_from: Option<String>,
    pub label: String,
    pub message_count: u32,
    pub created_at: f64,
    pub activity_at: f64,
    pub time_from: TimeFrom,
}

impl RowData {
    pub fn cwd(&self) -> &Cwd {
        &self.facts.cwd
    }
    pub fn usage(&self) -> Option<&Usage> {
        self.facts.usage.as_ref()
    }
    pub fn sub_agents(&self) -> &[SubAgent] {
        &self.facts.sub_agents
    }
}

/// How a read's `messages` change the stored history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Apply {
    /// A resume: append after the stored messages.
    Append,
    /// A full read: `messages` is the whole history.
    Replace,
    /// A resume that took back stored messages (these seqs, in stored numbering): delete them,
    /// renumber the rest to close the gaps, then append. A Codex file switching to event mode.
    Withdraw(Vec<u32>),
}

#[derive(Debug)]
pub struct Outcome {
    pub taken: Taken,
    pub stamp: Stamp,
    pub checkpoint: Option<Checkpoint>,
    /// Messages to apply to the stored history as `apply` says.
    pub messages: Vec<Message>,
    pub apply: Apply,
    /// Usage turns read, numbered from `first_turn` (a full read replaces all stored turns).
    pub turns: Vec<UsageTurn>,
    pub first_turn: u32,
    /// `None`: the source holds no session (yet).
    pub row: Option<RowData>,
    pub malformed_lines: u64,
    pub bytes_read: u64,
}

fn row(facts: Facts, visible: &Visible, message_count: u32, mtime_ms: f64) -> RowData {
    let (created_at, activity_at, time_from) = match facts.span {
        Some((lo, hi)) => (lo, hi, TimeFrom::Transcript),
        None => (mtime_ms, mtime_ms, TimeFrom::FileMtime),
    };
    RowData {
        identity: visible.identity(),
        hidden: visible.hidden(),
        swarm_debug_prefix: visible.swarm_debug_prefix(),
        resumed_from: visible.durable.resumed_from.clone(),
        label: visible.label(facts.title.as_deref()),
        message_count,
        created_at,
        activity_at,
        time_from,
        facts,
    }
}

struct Pass<F> {
    fold: F,
    sink: Sink,
    offset: u64,
    malformed: u64,
}

/// Feed the bytes from `start` to the fold. Stops before an unterminated fragment that does not
/// parse: a writer is mid-append, and advancing past it would lose the record.
fn run<F: Fold>(path: &Path, start: u64, mut fold: F, mut sink: Sink, full: bool, hints: Hints) -> io::Result<Result<Pass<F>, Rebuild>> {
    if full {
        fold.begin_full(hints);
    }
    let mut offset = start;
    let mut malformed = 0u64;
    let mut failure: Option<Rebuild> = None;
    for_each_line(path, start, |bytes, end, terminated| {
        let text = line_text(bytes);
        if crate::text::js_trim(&text).is_empty() {
            if terminated {
                offset = end;
            }
            return terminated;
        }
        if !terminated && serde_json::from_str::<serde::de::IgnoredAny>(&text).is_err() {
            return false;
        }
        match fold.line(&text, &mut sink) {
            Ok(Line::Malformed) => malformed += 1,
            Ok(Line::Used | Line::Skipped) => {}
            Err(rebuild) => {
                failure = Some(rebuild);
                return false;
            }
        }
        offset = end;
        true
    })?;
    if let Some(rebuild) = failure {
        return Ok(Err(rebuild));
    }
    if full && let Err(rebuild) = fold.end_full(&mut sink) {
        return Ok(Err(rebuild));
    }
    Ok(Ok(Pass { fold, sink, offset, malformed }))
}

impl From<parsers::claude::ClaudeFold> for FoldState {
    fn from(f: parsers::claude::ClaudeFold) -> Self {
        FoldState::Claude(f)
    }
}
impl From<parsers::codex::CodexFold> for FoldState {
    fn from(f: parsers::codex::CodexFold) -> Self {
        FoldState::Codex(f)
    }
}
impl From<parsers::cursor::CursorFold> for FoldState {
    fn from(f: parsers::cursor::CursorFold) -> Self {
        FoldState::Cursor(f)
    }
}
impl From<parsers::muse::MuseFold> for FoldState {
    fn from(f: parsers::muse::MuseFold) -> Self {
        FoldState::Muse(f)
    }
}

impl From<parsers::pi::PiFold> for FoldState {
    fn from(f: parsers::pi::PiFold) -> Self { Self::Pi(f) }
}

fn finish<F: Fold + Into<FoldState>>(
    pass: Pass<F>,
    path: &Path,
    ctx: &Ctx,
    stamp: Stamp,
    hints: Hints,
    taken: Taken,
    start: u64,
) -> io::Result<Outcome> {
    let facts = pass.fold.facts(ctx);
    let next_seq = pass.sink.next_seq;
    let apply = match (taken, pass.sink.withdrawn.is_empty()) {
        (Taken::Resumed, true) => Apply::Append,
        (Taken::Resumed, false) => Apply::Withdraw(pass.sink.withdrawn),
        (_, _) => Apply::Replace,
    };
    let row = facts.map(|f| row(f, &pass.sink.visible, next_seq, stamp.mtime_ms));
    let checkpoint = Checkpoint {
        content_version: 1,
        offset: pass.offset,
        fingerprint: fingerprint(path, pass.offset)?,
        hints,
        next_seq,
        next_turn: pass.sink.first_turn + pass.sink.turns.len() as u32,
        visible: pass.sink.visible,
        fold: pass.fold.into(),
    };
    Ok(Outcome {
        taken,
        stamp,
        checkpoint: Some(checkpoint),
        messages: pass.sink.out,
        apply,
        turns: pass.sink.turns,
        first_turn: pass.sink.first_turn,
        row,
        malformed_lines: pass.malformed,
        bytes_read: pass.offset - start,
    })
}

/// Read a JSONL source from byte 0, retrying with what a failed pass learned.
fn full<F: Fold + Into<FoldState>>(path: &Path, ctx: &Ctx, stamp: Stamp, mut hints: Hints, reason: FullReason) -> io::Result<Outcome> {
    // A retry sets the one hint there is; a second failure is a parser bug.
    for _ in 0..2 {
        match run(path, 0, F::default(), Sink::new(Visible::with_hints(hints), 0, 0), true, hints)? {
            Ok(pass) => return finish(pass, path, ctx, stamp, hints, Taken::Full(reason), 0),
            Err(Rebuild::OwnedLater) => hints.owned_later = true,
            Err(Rebuild::Reordered) => {
                return Err(io::Error::other(format!("{}: a full read reported an ordering rebuild", path.display())));
            }
        }
    }
    Err(io::Error::other(format!("{}: parser did not settle after 2 full reads", path.display())))
}

fn plan(path: &Path, stamp: &Stamp, prior: &Option<(Stamp, Checkpoint)>) -> io::Result<Result<(), FullReason>> {
    let Some((old, checkpoint)) = prior else { return Ok(Err(FullReason::Unseen)) };
    if checkpoint.content_version != 1 { return Ok(Err(FullReason::ContentUpgrade)); }
    if old.dev != stamp.dev || old.ino != stamp.ino {
        return Ok(Err(FullReason::Replaced));
    }
    if stamp.size < checkpoint.offset {
        return Ok(Err(FullReason::Shrank));
    }
    if fingerprint(path, checkpoint.offset)? != checkpoint.fingerprint {
        return Ok(Err(FullReason::Rewritten));
    }
    Ok(Ok(()))
}

fn read_jsonl<F: Fold + Into<FoldState>>(
    path: &Path,
    ctx: &Ctx,
    stamp: Stamp,
    prior: Option<(Stamp, Checkpoint)>,
    unwrap: fn(FoldState) -> Option<F>,
) -> io::Result<Outcome> {
    let reason = match plan(path, &stamp, &prior)? {
        Err(reason) => reason,
        Ok(()) => {
            let (_, cp) = prior.expect("plan resumes only with a prior checkpoint");
            let hints = cp.hints;
            let fold = unwrap(cp.fold).ok_or_else(|| io::Error::other("stored fold is for another format"))?;
            match run(path, cp.offset, fold, Sink::new(cp.visible, cp.next_seq, cp.next_turn), false, hints)? {
                Ok(pass) => return finish(pass, path, ctx, stamp, hints, Taken::Resumed, cp.offset),
                Err(rebuild) => {
                    let mut hints = hints;
                    match rebuild {
                        Rebuild::OwnedLater => hints.owned_later = true,
                        Rebuild::Reordered => {}
                    }
                    return full::<F>(path, ctx, stamp, hints, FullReason::Rebuild(rebuild));
                }
            }
        }
    };
    full::<F>(path, ctx, stamp, Hints::default(), reason)
}

fn read_doc(stamp: Stamp, doc: Option<Doc>) -> Outcome {
    let mut sink = Sink::new(Visible::default(), 0, 0);
    let row = doc.and_then(|doc| {
        for m in doc.messages {
            // A document has no later line to prove the first prompt misread; nothing to retry.
            if let Some(parts_json) = m.parts_json {
                let parts = serde_json::from_str(&parts_json).unwrap_or_default();
                sink.push_parts(m.role, m.at, m.completed_at, m.content, parts);
            } else if sink.push(m.role, m.at, m.completed_at, m.content, None).is_err() {
                return None;
            }
        }
        sink.turns = doc.turns;
        Some(row(doc.facts, &sink.visible, sink.next_seq, stamp.mtime_ms))
    });
    Outcome {
        taken: Taken::Full(FullReason::Document),
        stamp,
        checkpoint: None,
        messages: sink.out,
        apply: Apply::Replace,
        turns: sink.turns,
        first_turn: 0,
        row,
        malformed_lines: 0,
        bytes_read: stamp.size,
    }
}

/// Read one source given what the store holds for it. `prior` is the stored stamp and
/// checkpoint (JSONL formats) or just the stamp (documents).
pub fn read_source(
    format: Format,
    path: &Path,
    resolver: &ProjectDirResolver,
    prior_stamp: Option<Stamp>,
    prior_checkpoint: Option<Checkpoint>,
) -> io::Result<Outcome> {
    let stamp = Stamp::of(format, path)?;
    if prior_stamp.as_ref() == Some(&stamp) && prior_checkpoint.as_ref().is_none_or(|c| c.content_version == 1) {
        return Ok(Outcome {
            taken: Taken::Unchanged,
            stamp,
            checkpoint: prior_checkpoint,
            messages: Vec::new(),
            apply: Apply::Append,
            turns: Vec::new(),
            first_turn: 0,
            row: None,
            malformed_lines: 0,
            bytes_read: 0,
        });
    }
    let ctx = Ctx { path, resolver, mtime_ms: stamp.mtime_ms };
    let prior = prior_stamp.zip(prior_checkpoint);
    match format {
        Format::Claude => read_jsonl(path, &ctx, stamp, prior, |f| match f {
            FoldState::Claude(f) => Some(f),
            _ => None,
        }),
        Format::Codex => read_jsonl(path, &ctx, stamp, prior, |f| match f {
            FoldState::Codex(f) => Some(f),
            _ => None,
        }),
        Format::Cursor => read_jsonl(path, &ctx, stamp, prior, |f| match f {
            FoldState::Cursor(f) => Some(f),
            _ => None,
        }),
        Format::Pi => read_jsonl(path, &ctx, stamp, prior, |f| match f {
            FoldState::Pi(f) => Some(f),
            _ => None,
        }),
        Format::Muse => read_jsonl(path, &ctx, stamp, prior, |f| match f {
            FoldState::Muse(f) => Some(f),
            _ => None,
        }),
        Format::Gemini => Ok(read_doc(stamp, parsers::gemini::read(path, &ctx)?)),
        Format::Opencode => Ok(read_doc(stamp, parsers::opencode::read(path, &ctx)?)),
    }
}
