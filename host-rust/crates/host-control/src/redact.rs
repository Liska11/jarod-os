//! R1 invariant 7: a journal never holds a secret this process knows.
//!
//! The same function as `redactSecrets` in `control-authz.ts` (mission 0b.1): a live token,
//! capability, capability nonce or pipe nonce found in a free-text field is written as
//! `[REDACTED:<kind>]`. Only values the process actually holds are masked, compared by SHA-256
//! digest with a constant-time equality: no guess is made from the shape of a string, so a
//! legitimate long id is left alone. Candidate windows are tried only inside runs of token
//! characters, at the lengths of the live secrets, which keeps the scan linear in the field size.

use crate::secrets::{Secret, SecretKind};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use subtle::ConstantTimeEq;

/// Longest free-text field the journal keeps; the rest is cut *before* scanning, so a secret past the
/// cut cannot survive in the part that is written.
pub const JOURNAL_FIELD_MAX: usize = 4096;
pub const MIN_SECRET_LENGTH: usize = 8;

fn is_run_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn redact_secrets(text: &str, secrets: &[Secret]) -> String {
    let live: Vec<&Secret> = secrets.iter().filter(|secret| secret.value.len() >= MIN_SECRET_LENGTH).collect();

    if text.is_empty() || live.is_empty() {
        return text.to_string();
    }

    let bounded: String = if text.chars().count() > JOURNAL_FIELD_MAX {
        let mut cut: String = text.chars().take(JOURNAL_FIELD_MAX).collect();
        cut.push_str("…[cut]");
        cut
    } else {
        text.to_string()
    };

    // Two kinds of value. Those made only of token characters (the host's own tokens, capabilities, nonces:
    // base64url or hex) are looked for inside runs of token characters, which keeps the scan linear. Anything
    // else (a vault value: an API key with a dash and a colon, a pass phrase) can sit anywhere in the text,
    // so its length is tried at every position. Both compare digests in constant time, and a match is always
    // a whole-character range because a valid UTF-8 value cannot begin in the middle of another character.
    let mut by_length: BTreeMap<usize, Vec<(SecretKind, [u8; 32])>> = BTreeMap::new();
    let mut free_by_length: BTreeMap<usize, Vec<(SecretKind, [u8; 32])>> = BTreeMap::new();

    for secret in &live {
        let target = if secret.value.bytes().all(is_run_byte) { &mut by_length } else { &mut free_by_length };

        target.entry(secret.value.len()).or_default().push((secret.kind, digest(secret.value.as_bytes())));
    }

    let bytes = bounded.as_bytes();
    let mut found: Vec<(usize, usize, SecretKind)> = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if !is_run_byte(bytes[index]) {
            index += 1;
            continue;
        }

        let start = index;

        while index < bytes.len() && is_run_byte(bytes[index]) {
            index += 1;
        }

        let run = &bytes[start..index];

        for (length, group) in &by_length {
            if run.len() < *length {
                continue;
            }

            for at in 0..=(run.len() - length) {
                let window = digest(&run[at..at + length]);
                let mut matched = None;

                // Every candidate is compared, hit or not, so the number of comparisons does not
                // depend on which secret matched.
                for (kind, hash) in group {
                    if bool::from(window.as_slice().ct_eq(hash.as_slice())) {
                        matched = Some(*kind);
                    }
                }

                if let Some(kind) = matched {
                    found.push((start + at, start + at + length, kind));
                }
            }
        }
    }

    for (length, group) in &free_by_length {
        if bytes.len() < *length {
            continue;
        }

        for at in 0..=(bytes.len() - length) {
            let window = digest(&bytes[at..at + length]);
            let mut matched = None;

            for (kind, hash) in group {
                if bool::from(window.as_slice().ct_eq(hash.as_slice())) {
                    matched = Some(*kind);
                }
            }

            if let Some(kind) = matched {
                found.push((at, at + length, kind));
            }
        }
    }

    if found.is_empty() {
        return bounded;
    }

    // Earliest first; at the same start the longest wins (a capability contains its own nonce).
    found.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));

    let mut out = String::with_capacity(bounded.len());
    let mut cursor = 0;

    for (start, end, kind) in found {
        if start < cursor {
            continue;
        }

        out.push_str(&bounded[cursor..start]);
        out.push_str(&format!("[REDACTED:{}]", kind.as_str()));
        cursor = end;
    }

    out.push_str(&bounded[cursor..]);

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets() -> Vec<Secret> {
        vec![
            Secret::new(SecretKind::Token, "tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            Secret::new(SecretKind::Capability, "cap_AbCdEfGhIjKl_nonceNONCEnonce0123456789"),
            Secret::new(SecretKind::Nonce, "nonceNONCEnonce0123456789"),
        ]
    }

    #[test]
    fn masks_each_kind_wherever_it_sits() {
        let s = secrets();

        assert_eq!(redact_secrets(&format!("x {} y", s[0].value), &s), "x [REDACTED:token] y");
        assert_eq!(redact_secrets(&format!("({})", s[2].value), &s), "([REDACTED:nonce])");
        assert_eq!(redact_secrets(&format!("{}/{}", s[0].value, s[0].value), &s), "[REDACTED:token]/[REDACTED:token]");
        assert_eq!(redact_secrets(&format!("prefix-{}-suffix", s[0].value), &s), "prefix-[REDACTED:token]-suffix");
    }

    #[test]
    fn a_capability_is_masked_as_the_capability_not_as_its_nonce() {
        let s = secrets();

        assert_eq!(redact_secrets(&format!("using {} now", s[1].value), &s), "using [REDACTED:capability] now");
    }

    #[test]
    fn ordinary_text_is_left_alone_even_when_long_and_token_shaped() {
        let s = secrets();
        let lookalike = "A".repeat(64);
        let text = format!("{lookalike} and {}", "x1y2z3".repeat(10));

        assert_eq!(redact_secrets(&text, &s), text);
        assert_eq!(redact_secrets("memory.add from agent", &s), "memory.add from agent");
    }

    #[test]
    fn nothing_to_hide_or_only_short_values_changes_nothing() {
        assert_eq!(redact_secrets("abc", &[]), "abc");
        assert_eq!(redact_secrets("a b c", &[Secret::new(SecretKind::Token, ""), Secret::new(SecretKind::Token, "a")]), "a b c");
    }

    #[test]
    fn an_oversized_field_is_cut_before_scanning() {
        let s = secrets();
        let out = redact_secrets(&format!("{}{}", "z ".repeat(3000), s[0].value), &s);

        assert!(!out.contains(&s[0].value));
        assert!(out.ends_with("…[cut]"));
    }

    #[test]
    fn a_value_with_characters_outside_the_token_set_is_found_anywhere() {
        // An API key with a dash and a colon, a pass phrase with spaces and accents: not base64url, still known.
        let s = vec![Secret::new(SecretKind::Vault, "123456789:AAEhBP0-bot-secret_xyz"), Secret::new(SecretKind::Vault, "mot de passe très long")];

        assert_eq!(redact_secrets("x 123456789:AAEhBP0-bot-secret_xyz y", &s), "x [REDACTED:vault] y");
        assert_eq!(redact_secrets("url=https://api/bot123456789:AAEhBP0-bot-secret_xyz/send", &s), "url=https://api/bot[REDACTED:vault]/send");
        assert_eq!(redact_secrets("il dit: mot de passe très long!", &s), "il dit: [REDACTED:vault]!");
        assert_eq!(redact_secrets("123456789:AAEhBP0-bot-secret_xyz123456789:AAEhBP0-bot-secret_xyz", &s), "[REDACTED:vault][REDACTED:vault]");
        // A near miss is not a match, and neither is a fragment.
        assert_eq!(redact_secrets("123456789:AAEhBP0-bot-secret_xyZ", &s), "123456789:AAEhBP0-bot-secret_xyZ");
        assert_eq!(redact_secrets("AAEhBP0-bot-secret_xyz", &s), "AAEhBP0-bot-secret_xyz");
    }

    #[test]
    fn token_set_and_free_form_values_are_masked_together_with_the_right_kind() {
        let s = vec![Secret::new(SecretKind::Token, "tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), Secret::new(SecretKind::Vault, "key: with spaces & symbols")];

        assert_eq!(redact_secrets("a tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA b key: with spaces & symbols c", &s), "a [REDACTED:token] b [REDACTED:vault] c");
    }

    #[test]
    fn non_ascii_text_around_a_secret_is_kept_intact() {
        let s = secrets();

        assert_eq!(redact_secrets(&format!("é {} ü", s[0].value), &s), "é [REDACTED:token] ü");
    }
}
