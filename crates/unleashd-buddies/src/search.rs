//! Structured post search: the text grammar and its FTS5 translation.
//!
//! Grammar (the only source of FTS5 operators; every user word and phrase is emitted as a quoted
//! FTS5 string with `"` doubled, so user text can never inject `NEAR`, `*`, `^`, column filters or
//! parentheses):
//!   words        all must match            `rollout friday`
//!   "a phrase"   exact adjacent words      `"deploy window"`
//!   -term        excluded everywhere       `-draft`, `-"on hold"`
//!   OR           alternatives (UPPERCASE)  `staging OR canary`
//! Adjacency is AND and binds tighter than OR (`a OR b c` = `a OR (b c)`). Exclusions apply to the
//! whole query, not to one OR branch, so every branch needs a positive term. Lowercase `or` is a word.
use crate::error::{CoreError, Result};

#[derive(Debug, PartialEq)]
enum Token {
    Term(String),
    Excluded(String),
    Or,
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
        if excluded {
            chars.next();
        }
        let term = match chars.peek() {
            Some('"') => {
                chars.next();
                let mut phrase = String::new();
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some(ch) => phrase.push(ch),
                        None => return invalid("unclosed quote"),
                    }
                }
                if phrase.trim().is_empty() {
                    return invalid("empty phrase");
                }
                phrase.split_whitespace().collect::<Vec<_>>().join(" ")
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
            _ => return invalid("a lone `-`; exclude a word or \"phrase\" with -word"),
        };
        tokens.push(if excluded { Token::Excluded(term) } else { Token::Term(term) });
    }
    Ok(tokens)
}

/// The FTS5 MATCH expression for `text`: `(a b) OR (c) NOT (x OR y)`.
pub fn to_fts(text: &str) -> Result<String> {
    let mut branches: Vec<Vec<String>> = vec![Vec::new()];
    let mut excluded: Vec<String> = Vec::new();
    for token in tokenize(text)? {
        match token {
            Token::Term(t) => branches.last_mut().expect("one branch").push(fts_string(&t)),
            Token::Excluded(t) => excluded.push(fts_string(&t)),
            Token::Or => branches.push(Vec::new()),
        }
    }
    if branches.iter().any(|b| b.is_empty()) {
        return match branches.len() {
            1 => invalid("needs at least one word or phrase to match"),
            _ => invalid("every side of OR needs a word or phrase (exclusions apply to the whole query)"),
        };
    }
    let positive = branches.iter().map(|b| format!("({})", b.join(" "))).collect::<Vec<_>>().join(" OR ");
    Ok(match excluded.is_empty() {
        true => positive,
        false => format!("({positive}) NOT ({})", excluded.join(" OR ")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_text_is_always_quoted_and_operators_come_only_from_the_grammar() {
        assert_eq!(to_fts("a b").unwrap(), "(\"a\" \"b\")");
        assert_eq!(to_fts("a OR b c -x -\"y z\"").unwrap(), "((\"a\") OR (\"b\" \"c\")) NOT (\"x\" OR \"y z\")");
        assert_eq!(to_fts("NEAR( rank* a:b").unwrap(), "(\"NEAR(\" \"rank*\" \"a:b\")");
        assert_eq!(to_fts("a or b").unwrap(), "(\"a\" \"or\" \"b\")");
        for bad in ["", "  ", "\"open", "\"\"", "-", "a -", "OR a", "a OR", "a OR OR b", "-x", "a OR -x", "ab\"cd"] {
            assert!(to_fts(bad).is_err(), "{bad:?} must be a typed error");
        }
    }
}
