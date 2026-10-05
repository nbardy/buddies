mod common;

use common::{Fixture, WS, buddy, fixture};
use unleashd_buddies::CoreError;
use unleashd_buddies::types::*;

fn post(body: &str, key: &str) -> PostInput {
    PostInput {
        kind: PostKind::Inform,
        body: body.into(),
        purpose: None,
        evidence: vec![],
        reply_to_id: None,
        task_id: None,
        from_conversation_id: None,
        returns: None,
        run_config: None,
        broadcast: false,
        key: key.into(),
    }
}

fn general_id(f: &Fixture) -> String {
    rusqlite::Connection::open(&f.path).unwrap().query_row("SELECT id FROM channel WHERE name = 'general'", [], |r| r.get(0)).unwrap()
}

fn seeded() -> Fixture {
    let mut f = fixture();
    let general = f
        .store
        .create_channel(&Actor::Owner, ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() })
        .unwrap();
    for (who, body) in [
        (buddy("lead"), "we should go to market in November"),
        (buddy("lead"), "the marketing website needs a new hero"),
        (buddy("peer"), "Posts are ordered newest first"),
        (buddy("peer"), "**Deployment** checklist for the canary"),
    ] {
        f.store.post(&who, ChannelRef::Id { id: general.id.clone() }, post(body, body)).unwrap();
    }
    f
}

fn hits(f: &Fixture, q: &str) -> Vec<String> {
    f.store.search_posts(&Actor::Owner, WS, &SearchQuery::text(q), None, 20).unwrap().posts.into_iter().map(|p| p.body).collect()
}

// Owner report 2026-10-05: "market" returned nothing. On main the exact-token post ("go to
// market") IS found (reproduced on a temp store), so the miss was word forms: "marketing".
#[test]
fn market_finds_exact_token_and_word_forms() {
    let f = seeded();
    assert_eq!(hits(&f, "market"), ["the marketing website needs a new hero", "we should go to market in November"]);
}

#[test]
fn stem_matches_plural_and_inflected_forms() {
    let f = seeded();
    assert_eq!(hits(&f, "post"), ["Posts are ordered newest first"]);
    assert_eq!(hits(&f, "deploy"), ["**Deployment** checklist for the canary"]);
}

#[test]
fn typos_of_long_words_match_but_short_words_stay_exact() {
    let f = seeded();
    // Newest first; a typo hit is not ranked below an exact one (decision: ordering stays newest-first).
    let market = ["the marketing website needs a new hero", "we should go to market in November"];
    assert_eq!(hits(&f, "markte"), market, "a swap");
    assert_eq!(hits(&f, "marketng"), market, "a typo of an inflected form reaches the stem");
    assert_eq!(hits(&f, "Deploymnet checklist"), ["**Deployment** checklist for the canary"], "typos combine with exact words");
    assert!(hits(&f, "gx").is_empty() && hits(&f, "mrkt").is_empty(), "under 5 letters is exact-or-prefix only");
    assert!(hits(&f, "internationl").is_empty(), "no unrelated word is within one edit");
}

// Real-data check 2026-10-05: with typo terms always ORed in, "market" also pulled "marker" and
// "marked" posts (3 hits became 50). Typos are only a fallback for a query that finds nothing.
#[test]
fn typo_terms_only_apply_when_the_exact_query_finds_nothing() {
    let mut f = seeded();
    f.store.post(&buddy("peer"), ChannelRef::Id { id: general_id(&f) }, post("ticket marked as done", "m")).unwrap();
    assert_eq!(hits(&f, "market").len(), 2, "exact/prefix/stem hits exist, so `marked` stays out");
    assert_eq!(hits(&f, "markd"), ["ticket marked as done"], "nothing exact: the one-edit fallback finds it");
    let page = f.store.search_posts(&Actor::Owner, WS, &SearchQuery::text("markd"), None, 1).unwrap();
    assert!(page.next.is_none(), "{page:?}");
}

#[test]
fn user_operators_stay_literal_even_when_the_query_expands() {
    let f = seeded();
    for typed in ["marketng AND zzzz", "market NOT november", "body:market", "\"market\" OR* NEAR(go to)"] {
        assert!(hits(&f, typed).is_empty(), "{typed:?} is words, not FTS syntax");
    }
}

#[test]
fn at_author_filters_to_that_buddy_or_the_owner_and_unknown_names_are_errors() {
    let mut f = seeded();
    rusqlite::Connection::open(&f.path).unwrap().execute("UPDATE buddy SET name = 'Release Manager' WHERE id = 'lead'", []).unwrap();
    f.store.post(&Actor::Owner, ChannelRef::Id { id: general_id(&f) }, post("owner says go to market early", "o")).unwrap();
    let lead_market = ["the marketing website needs a new hero", "we should go to market in November"];
    assert_eq!(hits(&f, "@\"Release Manager\" market"), lead_market, "quoted multi-word name, combined with a word");
    assert_eq!(hits(&f, "@lead market"), lead_market, "the slug works too");
    assert_eq!(hits(&f, "@LEAD").len(), 2, "a bare @name lists that author's posts, newest first");
    assert_eq!(hits(&f, "@owner"), ["owner says go to market early"]);
    assert_eq!(hits(&f, "@owner @peer").len(), 3, "several authors are alternatives");
    let unknown = f.store.search_posts(&Actor::Owner, WS, &SearchQuery::text("@nobody market"), None, 20).unwrap_err();
    assert!(matches!(&unknown, CoreError::Invalid(m) if m == "no Buddy named \"nobody\""), "{unknown:?}");
}

// A database indexed before the stemming tokenizer (plain unicode61) must come back searchable
// by prefix and stem after open, with every post still findable.
#[test]
fn an_index_built_with_the_plain_tokenizer_is_rebuilt_on_open() {
    let f = seeded();
    let path = f.path.clone();
    drop(f.store);
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute_batch(
        "DROP TRIGGER post_search_insert; DROP TRIGGER post_search_delete; DROP TRIGGER post_search_update;
         DROP TABLE post_search_vocab; DROP TABLE post_search;
         CREATE VIRTUAL TABLE post_search USING fts5(body, content='post', content_rowid='rowid');
         INSERT INTO post_search(post_search) VALUES ('rebuild');",
    )
    .unwrap();
    drop(raw);
    let store = unleashd_buddies::Store::open(path.to_str().unwrap()).unwrap();
    let count = |q: &str| store.search_posts(&Actor::Owner, WS, &SearchQuery::text(q), None, 20).unwrap().posts.len();
    assert_eq!((count("market"), count("post"), count("canary")), (2, 1, 1));
}
