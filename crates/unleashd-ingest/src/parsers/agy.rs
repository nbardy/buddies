//! Antigravity CLI stores one SQLite trajectory per conversation. Read the
//! protobuf projection used by its v1.5 SQLite writer without modifying it.

use super::{Ctx, Doc, DocMessage, Facts};
use crate::model::{Cwd, Provider, Role};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub fn mtime(path: &Path, db_mtime: f64) -> f64 {
    // SQLite can append a whole turn to the WAL without touching the database.
    let wal = path.with_extension("db-wal");
    std::fs::metadata(wal).map_or(db_mtime, |meta| db_mtime.max(meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1_000_000.0))
}

fn varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let (byte, rest) = bytes.split_first()?;
        *bytes = rest;
        if shift == 63 && *byte > 1 {
            return None;
        }
        value |= u64::from(byte & 127) << shift;
        if *byte < 128 {
            return Some(value);
        }
    }
    None
}

// Read only the length-delimited fields we need and skip other scalar fields.
fn blobs(mut bytes: &[u8], field: u64) -> impl Iterator<Item = &[u8]> {
    std::iter::from_fn(move || {
        loop {
            let tag = varint(&mut bytes)?;
            let size = match tag & 7 {
                0 => {
                    varint(&mut bytes)?;
                    continue;
                }
                1 => 8,
                2 => usize::try_from(varint(&mut bytes)?).ok()?,
                5 => 4,
                _ => return None,
            };
            let (value, rest) = bytes.split_at_checked(size)?;
            bytes = rest;
            if tag == (field << 3 | 2) {
                return Some(value);
            }
        }
    })
}

fn blob(bytes: &[u8], field: u64) -> Option<&[u8]> {
    blobs(bytes, field).next()
}

fn text(bytes: &[u8], field: u64) -> Option<&str> {
    std::str::from_utf8(blob(bytes, field)?).ok().filter(|text| !text.is_empty())
}

fn at(metadata: &[u8]) -> Option<f64> {
    // google.protobuf.Timestamp: seconds, then nanoseconds.
    let mut stamp = blob(metadata, 1)?;
    if varint(&mut stamp)? != 8 {
        return None;
    }
    let seconds = varint(&mut stamp)?;
    let nanos = if varint(&mut stamp) == Some(16) { varint(&mut stamp)? } else { 0 };
    Some(seconds as f64 * 1000.0 + nanos as f64 / 1_000_000.0)
}

fn file_uri(uri: &str) -> Option<String> {
    let mut bytes = uri.strip_prefix("file://")?.as_bytes();
    if bytes.first() != Some(&b'/') {
        return None;
    }
    let mut decoded = Vec::with_capacity(bytes.len());
    while let Some((&byte, rest)) = bytes.split_first() {
        bytes = rest;
        if byte == b'%' {
            let (hex, tail) = bytes.split_at_checked(2)?;
            decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            bytes = tail;
        } else {
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded).ok()
}

pub fn read(path: &Path, ctx: &Ctx) -> io::Result<Option<Doc>> {
    read_db(path, ctx).map_err(io::Error::other)
}

fn read_db(path: &Path, ctx: &Ctx) -> rusqlite::Result<Option<Doc>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_millis(50))?;
    let tx = db.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "SELECT step_type, metadata, step_payload FROM steps WHERE step_format = 0 AND status = 3 AND step_type IN (14,15) ORDER BY idx",
    )?;
    let mut rows = stmt.query([])?;
    let mut messages = Vec::new();
    while let Some(row) = rows.next()? {
        let kind: i64 = row.get(0)?;
        let metadata: Option<Vec<u8>> = row.get(1)?;
        let payload: Vec<u8> = row.get(2)?;
        let at = metadata.as_deref().and_then(at);
        let (role, field, text_field) = if kind == 14 { (Role::User, 19, 2) } else { (Role::Assistant, 20, 1) };
        let Some(body) = blob(&payload, field) else { continue };
        if let Some(content) = text(body, text_field) {
            messages.push(DocMessage { role, at, completed_at: None, content: content.into(), parts_json: None });
        }
        if role == Role::Assistant {
            for call in blobs(body, 7) {
                let Some(name) = text(call, 2) else { continue };
                // Native ACP names have an ambiguous single separator. The
                // Buddy server has a known name; leave other names as recorded.
                let canonical = name.strip_prefix("mcp_unleashd_buddy_").map(|tool| format!("mcp__unleashd_buddy__{tool}"));
                let name = canonical.as_deref().unwrap_or(name);
                let input = text(call, 3).and_then(|input| serde_json::from_str::<Value>(input).ok());
                let parts = json!([{ "t": "tool", "name": name, "input": input }]);
                messages.push(DocMessage { role, at, completed_at: None, content: String::new(), parts_json: Some(parts.to_string()) });
            }
        }
    }
    if messages.is_empty() {
        return Ok(None);
    }
    let metadata: Vec<u8> = tx.query_row("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'", [], |row| row.get(0))?;
    let cwd = text(&metadata, 7).and_then(file_uri).map_or(Cwd::Unknown, |path| Cwd::Transcript { path });
    let span = messages.first().and_then(|first| first.at).zip(messages.last().and_then(|last| last.at));
    Ok(Some(Doc {
        facts: Facts {
            session_id: ctx.stem(".db"),
            provider: Provider::Gemini,
            cwd,
            model: None,
            title: None,
            span,
            parent_session_id: None,
            usage: None,
            sub_agents: Vec::new(),
            context: None,
            rate_limits: None,
        },
        messages,
        turns: Vec::new(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Format, Root};
    use crate::paths::ProjectDirResolver;
    use crate::read::{Apply, Stamp, read_source};

    fn field(tag: u8, child: &[u8]) -> Vec<u8> {
        let mut bytes = vec![tag, child.len().try_into().unwrap()];
        bytes.extend_from_slice(child);
        bytes
    }

    #[test]
    fn an_antigravity_turn_is_visible_from_the_wal_before_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.db");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL;
             CREATE TABLE steps(idx, step_type, status, step_format, metadata, step_payload);
             CREATE TABLE trajectory_metadata_blob(id, data);",
            )
            .unwrap();
        writer.execute("INSERT INTO trajectory_metadata_blob VALUES ('main', ?1)", [field(58, b"file:///work%20tree")]).unwrap();
        let stamp = Stamp::of(Format::Agy, &path).unwrap();
        let insert = "INSERT INTO steps VALUES (?1, ?2, 3, 0, NULL, ?3)";
        // Field 19/20 are the length-delimited user/assistant trajectory step.
        let mut user = vec![0x9a, 1, 7];
        user.extend(field(18, b"hello"));
        writer.execute(insert, rusqlite::params![0, 14, user]).unwrap();
        let mut assistant = vec![0xa2, 1, 7];
        assistant.extend(field(10, b"world"));
        writer.execute(insert, rusqlite::params![1, 15, assistant]).unwrap();
        let root = Root { format: Format::Agy, path: dir.path().to_string_lossy().into_owned() };
        assert_eq!(crate::discover::classify(&root, &path.with_extension("db-wal")), crate::discover::Touched::Source(path.clone()));
        let resolver = ProjectDirResolver::default();
        let outcome = read_source(Format::Agy, &path, &resolver, Some(stamp), None).unwrap();
        assert_eq!(outcome.apply, Apply::Replace);
        assert_eq!(outcome.messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(), ["hello", "world"]);
        let row = outcome.row.unwrap();
        assert_eq!(row.facts.provider, Provider::Gemini);
        assert_eq!(row.facts.session_id, "session");
        assert_eq!(row.cwd().path(), Some("/work tree"));
    }
}
