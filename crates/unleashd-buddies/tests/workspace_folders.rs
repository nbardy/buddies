use unleashd_buddies::Store;

#[test]
fn old_workspaces_gain_folder_history_without_replacing_their_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.sqlite");
    let path = path.to_str().unwrap();
    drop(Store::open(path).unwrap());
    {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "DROP TRIGGER workspace_folders_insert; DROP TRIGGER workspace_folders_update;
            DROP TABLE workspace_folder; DROP INDEX workspace_repository;
            ALTER TABLE workspace DROP COLUMN folders;
            ALTER TABLE workspace DROP COLUMN repository_identity;
            INSERT INTO workspace (id, name, root_path, created_at) VALUES ('kept', 'Owner name', '/old', 'then');",
        )
        .unwrap();
    }
    let store = Store::open(path).unwrap();
    let workspace = store.list_workspaces().unwrap().pop().unwrap();
    assert_eq!(workspace.id, "kept");
    assert_eq!(workspace.name, "Owner name");
    assert_eq!(workspace.folders.unwrap(), ["/old"]);
    assert!(workspace.repository_identity.is_none());
}
