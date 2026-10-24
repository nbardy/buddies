//! The reader pool (src/pool.rs). Regression guard: every crate call once took ONE
//! `Mutex<Store>`, so reads queued behind each other and behind the Buddy runner's writes
//! (10 ms requests took 300 ms - 6 s under load). `reads_proceed_while_the_writer_is_held` fails
//! if a read ever goes back through the writer lane. `bench_pool_vs_single_lock` (ignored; run
//! with `--ignored --nocapture`) prints the before/after latencies.

mod common;

use common::{buddy, fixture};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
use unleashd_buddies::Database;
use unleashd_buddies::types::*;

fn post(body: &str, reply_to: Option<&str>, key: &str) -> PostInput {
    PostInput {
        kind: PostKind::Inform,
        body: body.into(),
        purpose: None,
        evidence: vec![],
        reply_to_id: reply_to.map(Into::into),
        task_id: None,
        from_conversation_id: None,
        mentions: vec![],
        run_config: None,
        broadcast: false,
        key: key.into(),
    }
}

fn dm() -> ChannelRef {
    ChannelRef::Direct { members: vec![buddy("peer"), buddy("mid")] }
}

/// A database with one thread of `replies` replies. Returns (dir guard, path, root id).
fn seeded(replies: usize) -> (common::Fixture, String) {
    let mut f = fixture();
    let root = f.store.write_post(&buddy("peer"), dm(), post("root", None, "root")).unwrap().post;
    for i in 0..replies {
        f.store
            .write_post(
                &buddy("mid"),
                ChannelRef::Id { id: root.channel_id.clone() },
                post(&format!("reply {i}"), Some(&root.id), &format!("r{i}")),
            )
            .unwrap();
    }
    (f, root.id)
}

fn thread(root: &str) -> PostQuery {
    PostQuery::Thread { root_id: root.into() }
}

#[test]
fn reads_proceed_while_the_writer_is_held() {
    let (f, root) = seeded(20);
    let db = Arc::new(Database::open(f.path.to_str().unwrap()).unwrap());
    let (held_tx, held_rx) = channel();
    let (release_tx, release_rx) = channel::<()>();
    let holder = {
        let db = db.clone();
        let path = f.path.clone();
        std::thread::spawn(move || {
            db.write(|_| {
                // The writer mutex is held AND another connection sits in an open write transaction.
                let raw = rusqlite::Connection::open(&path).unwrap();
                raw.execute_batch("BEGIN IMMEDIATE; UPDATE workspace SET name = 'held';").unwrap();
                held_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                raw.execute_batch("ROLLBACK;").unwrap();
                Ok(())
            })
            .unwrap();
        })
    };
    held_rx.recv().unwrap();
    let (done_tx, done_rx) = channel();
    let reader = {
        let db = db.clone();
        std::thread::spawn(move || {
            let page = db.read(|s| s.list_posts(&buddy("peer"), thread(&root), None, 50)).unwrap();
            let names = db.read(|s| s.list_workspaces()).unwrap();
            done_tx.send((page.posts.len(), names[0].name.clone())).unwrap();
        })
    };
    let got = done_rx.recv_timeout(Duration::from_secs(3));
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    match got {
        Ok((n, name)) => {
            assert_eq!(n, 20);
            assert_eq!(name, "ws", "the reader sees committed state, never the held uncommitted write");
        }
        Err(RecvTimeoutError::Timeout) => panic!("a read waited on the writer"),
        Err(e) => panic!("{e}"),
    }
    reader.join().unwrap();
}

#[test]
fn a_read_sees_every_write_committed_before_it() {
    let (f, root) = seeded(0);
    let db = Database::open(f.path.to_str().unwrap()).unwrap();
    for i in 0..50 {
        let channel = db.read(|s| s.list_posts(&buddy("peer"), thread(&root), None, 100)).unwrap();
        assert_eq!(channel.posts.len(), i);
        let post_in = db.read(|s| s.get_post(&buddy("peer"), &root)).unwrap();
        db.write(|s| {
            s.write_post(&buddy("mid"), ChannelRef::Id { id: post_in.channel_id.clone() }, post("x", Some(&root), &format!("k{i}")))
                .map(|_| ())
        })
        .unwrap();
    }
    assert_eq!(db.read(|s| s.list_posts(&buddy("peer"), thread(&root), None, 100)).unwrap().posts.len(), 50);
}

fn pct(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p) as usize]
}

/// 30 concurrent thread readers x 40 calls while a writer loop posts. `pooled = false` routes the
/// reads through the writer lane, which is exactly the old single-mutex behaviour.
fn run(db: &Arc<Database>, root: &str, channel: &str, pooled: bool) -> (f64, f64) {
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let (db, stop, channel, root) = (db.clone(), stop.clone(), channel.to_string(), root.to_string());
        std::thread::spawn(move || {
            let mut i = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                db.write(|s| {
                    s.write_post(&buddy("mid"), ChannelRef::Id { id: channel.clone() }, post("w", Some(&root), &format!("bw{pooled}{i}")))
                        .map(|_| ())
                })
                .unwrap();
                i += 1;
            }
        })
    };
    let barrier = Arc::new(Barrier::new(30));
    let readers: Vec<_> = (0..30)
        .map(|_| {
            let (db, barrier, root) = (db.clone(), barrier.clone(), root.to_string());
            std::thread::spawn(move || {
                barrier.wait();
                (0..40)
                    .map(|_| {
                        let t = Instant::now();
                        if pooled {
                            db.read(|s| s.list_posts(&buddy("peer"), thread(&root), None, 50)).unwrap();
                        } else {
                            db.write(|s| s.list_posts(&buddy("peer"), thread(&root), None, 50)).unwrap();
                        }
                        t.elapsed().as_secs_f64() * 1000.0
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let all: Vec<f64> = readers.into_iter().flat_map(|h| h.join().unwrap()).collect();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
    println!("  pooled={pooled} p90 {:.2} p999 {:.2} max {:.2}", pct(all.clone(), 0.9), pct(all.clone(), 0.999), pct(all.clone(), 1.0));
    (pct(all.clone(), 0.5), pct(all, 0.99))
}

#[test]
#[ignore]
fn bench_pool_vs_single_lock() {
    let (f, root) = seeded(300);
    let db = Arc::new(Database::open(f.path.to_str().unwrap()).unwrap());
    let channel = db.read(|s| s.get_post(&buddy("peer"), &root)).unwrap().channel_id;
    let (p50, p99) = run(&db, &root, &channel, false);
    println!("single lock : p50 {p50:.2} ms  p99 {p99:.2} ms");
    let (p50, p99) = run(&db, &root, &channel, true);
    println!("reader pool : p50 {p50:.2} ms  p99 {p99:.2} ms");
}
