use rusqlite::Connection;
use unleashd_buddies::Store;

// The steering fix names run.steered_at on every read. A fresh-file test cannot prove that
// a pre-fix install upgrades; guard the owning addon's real reopen path and retained rows.
#[test]
fn run_steered_at_is_added_to_an_existing_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("before-steering.sqlite");
    let path = path.to_str().unwrap();
    drop(Store::open(path).unwrap());
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "INSERT INTO workspace (id, name, root_path, created_at) VALUES ('kept', 'Kept', '/kept', 'now');
         ALTER TABLE run DROP COLUMN steered_at;",
    ).unwrap();
    drop(conn);
    for _ in 0..2 {
        drop(Store::open(path).unwrap());
        let conn = Connection::open(path).unwrap();
        let (columns, retained): (i64, i64) = conn.query_row(
            "SELECT (SELECT count(*) FROM pragma_table_info('run') WHERE name = 'steered_at'),
                    (SELECT count(*) FROM workspace WHERE id = 'kept')",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!((columns, retained), (1, 1), "reopen adds the column once and preserves existing data");
    }
}
