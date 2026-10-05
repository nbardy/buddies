#![allow(dead_code)]

use rusqlite::{Connection, params};
use std::path::PathBuf;
use unleashd_buddies::Store;
use unleashd_buddies::types::{Actor, RunBudgets};

/// A fresh store with one workspace and the org: lead → mid → ic, plus a peer and an archived buddy.
pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub path: PathBuf,
    pub store: Store,
}

pub const WS: &str = "ws_1";

/// A claim's clocks with this lease; deadlines at their production values (24 h chat, 1 h turn).
#[allow(dead_code)]
pub fn lease(ms: i64) -> RunBudgets {
    RunBudgets { lease_ms: ms, chat_deadline_ms: 86_400_000, turn_deadline_ms: 3_600_000 }
}

pub fn buddy(id: &str) -> Actor {
    Actor::Buddy { id: id.to_string() }
}

pub fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let store = Store::open(path.to_str().unwrap()).unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute("INSERT INTO workspace (id, name, root_path, created_at) VALUES (?1, 'ws', '/tmp/ws', '2026-01-01T00:00:00.000Z')", [WS])
        .unwrap();
    for (id, manager, status) in [
        ("lead", None, "active"),
        ("mid", Some("lead"), "active"),
        ("ic", Some("mid"), "active"),
        ("peer", None, "active"),
        ("gone", Some("lead"), "archived"),
    ] {
        conn.execute(
            "INSERT INTO buddy (id, workspace_id, slug, name, role, status, manager_id, max_active_runs, created_at)
             VALUES (?1, ?2, ?1, ?1, 'role', ?3, ?4, 2, '2026-01-01T00:00:00.000Z')",
            params![id, WS, status, manager],
        )
        .unwrap();
    }
    Fixture { dir, path, store }
}
