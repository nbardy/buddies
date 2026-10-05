//! Structured post search: the text grammar and its FTS5 translation.
//!
//! Grammar (the only source of FTS5 operators; every user word and phrase is emitted as a quoted
//! FTS5 string with `"` doubled, so user text can never inject `NEAR`, `*`, `^`, column filters or
//! parentheses):
//!   words        all must match            `rollout friday`
//!   @Name        only that author's posts  `@lead rollout`, `@"Release Manager"`, `@owner`
//!   "a phrase"   exact adjacent words      `"deploy window"`
//!   -term        excluded everywhere       `-draft`, `-"on hold"`
//!   OR           alternatives (UPPERCASE)  `staging OR canary`
//! Words are joined by an explicit AND (FTS5 rejects an implicit one after a parenthesized group).
//! Adjacency is AND and binds tighter than OR (`a OR b c` = `a OR (b c)`). Exclusions apply to the
//! whole query, not to one OR branch, so every branch needs a positive term. Lowercase `or` is a word.
//! `@Name` also applies to the whole query; with no other words the query lists that author's posts.
//!
//! Why prefix + stem, and why the user's text stays quoted: the index tokenizer is `porter
//! unicode61` (schema.rs), so "posts" and "post" share a stem. A bare word is emitted as a quoted
//! string followed by `*` (`"market"*`), a prefix match, so "market" finds "marketing". The `*` is
//! appended by this module after quoting; user text is never spliced into the expression unquoted,
//! so a `*`, `NEAR(`, `col:` or `AND` typed by the user is still just text. Phrases and exclusions
//! stay exact: a phrase means adjacent words, and an exclusion should drop only what was named.
//! Words of 5+ letters also match one-edit typos: the caller supplies `similar` (index vocabulary
//! within one edit, see `within_one_edit`) and each hit is quoted like any other term. The store only
//! asks when the query matched nothing without typos (posts.rs `search_posts`).
use crate::error::{CoreError, Result};

#[derive(Debug, PartialEq)]
enum Token {
    /// A bare word: prefix and typo matching apply.
    Word(String),
    /// A quoted phrase: adjacent words, exact.
    Phrase(String),
    Excluded(String),
    Author(String),
    Or,
}

/// A parsed search text: the FTS5 expression (absent when the text names only authors) and the
/// `@` author names, still unresolved (names mean Buddies; resolving them needs the database).
#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub fts: Option<String>,
    pub authors: Vec<String>,
}

/// Shortest word that also matches one-edit typos; shorter words are too ambiguous.
const TYPO_MIN_CHARS: usize = 5;
/// Cap on expansions per word so a common prefix of typos cannot blow up the expression.
pub const TYPO_MAX_TERMS: usize = 20;

/// True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent swap.
pub fn within_one_edit(a: &[char], b: &[char]) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if long.len() - short.len() > 1 {
        return false;
    }
    let lead = short.iter().zip(long).take_while(|(x, y)| x == y).count();
    let (short, long) = (&short[lead..], &long[lead..]);
    match (short.len(), long.len()) {
        (0, _) => true,
        (n, m) if n == m => short[1..] == long[1..] || (n >= 2 && short[0] == long[1] && short[1] == long[0] && short[2..] == long[2..]),
        _ => short == &long[1..],
    }
}

/// Index terms that `word` may be a typo of. The index holds stems (`marketing` is stored as
/// `market`), so a vocabulary term also qualifies when it is one edit from a leading slice of the
/// word that is at most four letters shorter (a suffix such as -ing or -ment). The cap keeps
/// `international` from reaching `inter`.
pub fn is_typo_of(word: &[char], term: &[char]) -> bool {
    if within_one_edit(word, term) {
        return true;
    }
    let cut = word.len().saturating_sub(term.len());
    term.len() >= 5 && (1..=4).contains(&cut) && within_one_edit(&word[..term.len().min(word.len())], term)
}

fn invalid<T>(why: &str) -> Result<T> {
    Err(CoreError::Invalid(format!("search text: {why}")))
}

/// One quoted FTS5 string. `""` is the FTS5 escape for a quote inside one.
fn fts_string(raw: &str) -> String {
    format!("\"{}\"", raw.replace('"', "\"\""))
}

fn tokenize(text: &str) -> Result<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let excluded = c == '-';
        let author = c == '@';
        if excluded || author {
            chars.next();
        }
        let mut phrase = false;
        let term = match chars.peek() {
            Some('"') => {
                chars.next();
                let mut quoted = String::new();
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some(ch) => quoted.push(ch),
                        None => return invalid("unclosed quote"),
                    }
                }
                if quoted.trim().is_empty() {
                    return invalid("empty phrase");
                }
                phrase = true;
                quoted.split_whitespace().collect::<Vec<_>>().join(" ")
            }
            Some(&ch) if !ch.is_whitespace() => {
                let mut word = String::new();
                while let Some(&ch) = chars.peek() {
                    if ch.is_whitespace() {
                        break;
                    }
                    if ch == '"' {
                        return invalid("a quote inside a word; put the phrase in its own quotes");
                    }
                    word.push(ch);
                    chars.next();
                }
                if !excluded && word == "OR" {
                    tokens.push(Token::Or);
                    continue;
                }
                word
            }
            _ if author => return invalid("a lone `@`; name a Buddy, `@Name` or @\"Two Words\""),
            _ => return invalid("a lone `-`; exclude a word or \"phrase\" with -word"),
        };
        tokens.push(match (excluded, author, phrase) {
            (true, _, _) => Token::Excluded(term),
            (_, true, _) => Token::Author(term),
            (_, _, true) => Token::Phrase(term),
            _ => Token::Word(term),
        });
    }
    Ok(tokens)
}

/// The prefix without a final y (`"deplo"*`) for a word of `min` letters or more ending in y.
/// Porter stems the QUERY too and is not idempotent on a final y: the index holds `deployment` as
/// `deploy` but the query `deploy` becomes `deploi`, so `"deploy"*` alone would miss "deployment".
/// The y-less prefix covers both stored forms.
fn without_y(word: &str, min: usize) -> Option<String> {
    let long_enough = word.chars().count() >= min && word.to_lowercase().ends_with('y');
    long_enough.then(|| format!("{}*", fts_string(&word[..word.len() - 1])))
}

/// One bare word as FTS5: its prefix (`"market"*`, plus the y-less prefix for a word of 6+
/// letters ending in y), and for a long word each index term one typo away as an exact quoted
/// term (`("markte"* OR "market")`). Typo terms are not prefixes: a typo's stem can be short
/// (`marked` is stored as `mark`) and `"mark"*` would match "market". Typo terms ending in y get
/// the y-less prefix too (they are stems, and a stem ending in y cannot be re-queried exactly).
fn word_expr(word: &str, similar: &dyn Fn(&str) -> Result<Vec<String>>) -> Result<String> {
    let lower = word.to_lowercase();
    let mut alternatives = vec![format!("{}*", fts_string(word))];
    alternatives.extend(without_y(word, 6));
    if lower.chars().count() >= TYPO_MIN_CHARS {
        for term in similar(&lower)? {
            alternatives.push(fts_string(&term));
            alternatives.extend(without_y(&term, 5));
        }
    }
    Ok(match alternatives.len() {
        1 => alternatives.remove(0),
        _ => format!("({})", alternatives.join(" OR ")),
    })
}

/// The FTS5 MATCH expression for `text`: `(a b) OR (c) NOT (x OR y)`. `similar(word)` returns index
/// terms one typo from a lowercase word of 5+ letters; pass `&|_| Ok(vec![])` to disable typo matching.
pub fn parse(text: &str, similar: &dyn Fn(&str) -> Result<Vec<String>>) -> Result<Parsed> {
    let mut branches: Vec<Vec<String>> = vec![Vec::new()];
    let mut excluded: Vec<String> = Vec::new();
    let mut authors: Vec<String> = Vec::new();
    let mut ors = 0;
    for token in tokenize(text)? {
        match token {
            Token::Word(t) => branches.last_mut().expect("one branch").push(word_expr(&t, similar)?),
            Token::Phrase(t) => branches.last_mut().expect("one branch").push(fts_string(&t)),
            Token::Excluded(t) => excluded.push(fts_string(&t)),
            Token::Author(name) => authors.push(name),
            Token::Or => {
                ors += 1;
                branches.push(Vec::new());
            }
        }
    }
    if ors == 0 && branches[0].is_empty() && excluded.is_empty() && !authors.is_empty() {
        return Ok(Parsed { fts: None, authors });
    }
    if branches.iter().any(|b| b.is_empty()) {
        return match branches.len() {
            1 => invalid("needs at least one word or phrase to match"),
            _ => invalid("every side of OR needs a word or phrase (exclusions apply to the whole query)"),
        };
    }
    let positive = branches.iter().map(|b| format!("({})", b.join(" AND "))).collect::<Vec<_>>().join(" OR ");
    let fts = match excluded.is_empty() {
        true => positive,
        false => format!("({positive}) NOT ({})", excluded.join(" OR ")),
    };
    Ok(Parsed { fts: Some(fts), authors })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &str) -> Result<Vec<String>> {
        Ok(vec![])
    }
    fn fts(text: &str) -> String {
        parse(text, &none).unwrap().fts.unwrap()
    }
    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn fts_text_is_always_quoted_and_operators_come_only_from_the_grammar() {
        assert_eq!(fts("a b"), "(\"a\"* AND \"b\"*)");
        assert_eq!(fts("a OR b c -x -\"y z\" \"p q\""), "((\"a\"*) OR (\"b\"* AND \"c\"* AND \"p q\")) NOT (\"x\" OR \"y z\")");
        assert_eq!(fts("NEAR( rank* a:b"), "(\"NEAR(\"* AND \"rank*\"* AND \"a:b\"*)");
        assert_eq!(fts("a or b"), "(\"a\"* AND \"or\"* AND \"b\"*)");
        for bad in ["", "  ", "\"open", "\"\"", "-", "a -", "@", "OR a", "a OR", "a OR OR b", "-x", "a OR -x", "ab\"cd", "@lead OR", "@lead -x"] {
            assert!(parse(bad, &none).is_err(), "{bad:?} must be a typed error");
        }
    }

    #[test]
    fn authors_are_collected_and_a_bare_author_has_no_match_expression() {
        let p = parse("@lead @\"Release Manager\" rollout", &none).unwrap();
        assert_eq!(p.authors, ["lead", "Release Manager"]);
        assert_eq!(p.fts.unwrap(), "(\"rollout\"*)");
        assert_eq!(parse("@lead", &none).unwrap(), Parsed { fts: None, authors: vec!["lead".into()] });
        assert_eq!(fts("a@b.com"), "(\"a@b.com\"*)", "an @ inside a word is text");
    }

    #[test]
    fn long_words_expand_to_their_typo_terms_each_quoted() {
        let similar = |w: &str| {
            Ok(match w {
                "markte" => vec!["market".to_string(), "a\"b".to_string()],
                _ => vec![],
            })
        };
        assert_eq!(parse("markte go", &similar).unwrap().fts.unwrap(), "((\"markte\"* OR \"market\" OR \"a\"\"b\") AND \"go\"*)");
        assert_eq!(parse("short", &|_| Ok(vec!["x".into()])).unwrap().fts.unwrap(), "((\"short\"* OR \"x\"))", "5 letters expands");
        assert_eq!(fts("deploy copy"), "((\"deploy\"* OR \"deplo\"*) AND \"copy\"*)", "a final y also gets the stem-safe prefix, from 6 letters");
        assert_eq!(parse("four", &|_| Ok(vec!["x".into()])).unwrap().fts.unwrap(), "(\"four\"*)", "4 letters does not");
        assert_eq!(parse("\"markte x\"", &similar).unwrap().fts.unwrap(), "(\"markte x\")", "phrases stay exact");
    }

    #[test]
    fn one_edit_covers_insert_delete_substitute_and_swap_but_not_two() {
        for (a, b) in [("market", "markte"), ("market", "markit"), ("market", "marke"), ("market", "marketx"), ("market", "market")] {
            assert!(within_one_edit(&chars(a), &chars(b)), "{a} {b}");
        }
        for (a, b) in [("market", "mraket2"), ("market", "mrkt"), ("market", "marketxx")] {
            assert!(!within_one_edit(&chars(a), &chars(b)), "{a} {b}");
        }
        // The index stores stems: "marketng" (typo of marketing) must reach stem "market".
        assert!(is_typo_of(&chars("marketng"), &chars("market")));
        assert!(!is_typo_of(&chars("international"), &chars("inter")), "a long suffix is not a stem");
    }
}
