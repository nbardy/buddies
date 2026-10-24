//! Regression guard: the workspace Task directory is polled every 15 s, and as full Tasks it was
//! 1.7 MB for 896 tasks (~1 MB free text). The summary list must carry the same rows in the same
//! order as the full list while reading none of the free-text columns.

mod common;

use common::{WS, buddy, fixture};
use unleashd_buddies::types::*;

#[test]
fn task_summaries_match_full_list_rows_without_free_text() {
    let mut f = fixture();
    let s = &mut f.store;
    let mid = buddy("mid");
    for (i, title) in ["alpha", "beta", "gamma"].iter().enumerate() {
        s.upsert_task(
            &mid,
            TaskWrite::Create {
                owner_id: "ic".into(),
                parent_id: None,
                title: (*title).into(),
                done_criteria: "x".repeat(10_000),
                key: format!("k{i}"),
            },
        )
        .unwrap();
    }
    let full = s.list_tasks(TaskQuery::Workspace { workspace_id: WS.into() }).unwrap();
    let summaries = s.list_task_summaries(WS).unwrap();
    assert_eq!(full.len(), 3);
    let ids = |v: Vec<String>| v;
    assert_eq!(ids(full.iter().map(|t| t.id.clone()).collect()), ids(summaries.iter().map(|t| t.id.clone()).collect()));
    for (t, m) in full.iter().zip(&summaries) {
        assert_eq!((&t.title, t.revision, t.pin, t.status), (&m.title, m.revision, m.pin, m.status));
    }
    // The point of the type: nothing here can hold done_criteria, so the row is small.
    assert!(format!("{summaries:?}").len() < 3 * 1_000);
}
