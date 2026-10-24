//! Lean Buddies core (DESIGN.md Part B, D1): the SQLite file, the schema, `authorize` and the
//! Buddy functions. The one-time v33 importer was deleted after the 2026-09-27 swap (last at 03fc931).

pub mod docs;
pub mod deliveries;
pub mod error;
mod folder_probe;
pub mod ids;
pub mod messages;
pub mod migrate;
#[cfg(feature = "node")]
pub mod node;
pub mod pool;
pub mod posts;
pub mod runs;
pub mod search;
pub mod schema;
pub mod store;
pub mod tasks;
pub mod team;
pub mod types;

pub use error::{CoreError, Result};
pub use pool::Database;
pub use store::Store;
