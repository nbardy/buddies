//! Ordered ids: time-ordered UUIDv7 (RFC 9562) from ONE monotonic generator per process.
//!
//! Order by these ids, never by timestamp ties. Posts used to sort by `(created_at, id)` with
//! random v4 ids, so posts written in one millisecond read back shuffled (29 of 50 three-reply
//! threads, 2026-09-25), which broke "is this the thread's newest post" (follow-up gating), the
//! Buddy-chain bound, read cursors and keyset paging. Guard: core.rs
//! `posts_read_back_in_write_order_within_a_millisecond`.
//!
//! Why a tiny generator rather than `uuid::Uuid::now_v7()`: `now_v7` is monotonic per process,
//! but the importer must give legacy rows ids at THEIR write time (an explicit timestamp) from the
//! same counter, and read cursors need a "ceiling" key (the last possible id of a millisecond).
//! Both need the bit layout in hand, and it is 40 lines: RFC 9562 §6.2 Method 1 — a 12-bit counter
//! in `rand_a`, seeded randomly with its top bit clear at each new millisecond and incremented
//! within one; on overflow the id's timestamp moves to the next millisecond (the RFC's allowance).
//! A clock that steps back keeps the last millisecond. `created_at` is never adjusted.

// Pattern: ordered-ids (docs/patterns.md#ordered-ids)
use std::sync::Mutex;
use uuid::Uuid;

struct State {
    ms: u64,
    counter: u16,
}

static GENERATOR: Mutex<State> = Mutex::new(State { ms: 0, counter: 0 });

fn random_bits() -> [u8; 16] {
    *Uuid::new_v4().as_bytes()
}

fn layout(ms: u64, counter: u16, random: [u8; 16]) -> Uuid {
    let mut b = random;
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = 0x70 | ((counter >> 8) as u8 & 0x0f);
    b[7] = counter as u8;
    b[8] = 0x80 | (b[8] & 0x3f);
    Uuid::from_bytes(b)
}

/// The next id at `ms` (Unix milliseconds): strictly greater than every id this process issued.
pub fn next_at(ms: u64) -> Uuid {
    let mut state = GENERATOR.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let random = random_bits();
    let fresh = |ms: u64| State { ms, counter: u16::from(random[6] & 0x07) << 8 | u16::from(random[7]) };
    *state = match (ms > state.ms, state.counter >= 0x0fff) {
        (true, _) => fresh(ms),
        (false, true) => fresh(state.ms + 1),
        (false, false) => State { ms: state.ms, counter: state.counter + 1 },
    };
    layout(state.ms, state.counter, random)
}

/// The next id now.
pub fn next() -> Uuid {
    next_at(chrono::Utc::now().timestamp_millis() as u64)
}

/// The greatest id a millisecond can hold: a cursor "read through that instant".
pub fn ceiling(ms: u64) -> Uuid {
    layout(ms, 0x0fff, [0xff; 16])
}
