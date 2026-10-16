//! The two per-launch tokens, and the constant-time comparison every credential goes through.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::fmt;
use subtle::ConstantTimeEq;

/// What a journal calls a secret it found and masked (`[REDACTED:<kind>]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretKind {
    Token,
    Capability,
    Nonce,
}

impl SecretKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SecretKind::Token => "token",
            SecretKind::Capability => "capability",
            SecretKind::Nonce => "nonce",
        }
    }
}

/// A value this process holds right now that no journal may contain. Never prints itself.
#[derive(Clone)]
pub struct Secret {
    pub kind: SecretKind,
    pub value: String,
}

impl Secret {
    pub fn new(kind: SecretKind, value: impl Into<String>) -> Self {
        Secret { kind, value: value.into() }
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret({}, [redacted])", self.kind.as_str())
    }
}

/// Fill `buffer` from the operating system's generator; a host that cannot get randomness cannot mint a
/// credential and must not start.
pub fn random_bytes(buffer: &mut [u8]) -> Result<(), SecretsError> {
    getrandom::fill(buffer).map_err(|error| SecretsError(format!("no secure randomness: {error}")))
}

pub fn random_base64url(bytes: usize) -> Result<String, SecretsError> {
    let mut buffer = vec![0u8; bytes];
    random_bytes(&mut buffer)?;

    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

pub fn random_hex(bytes: usize) -> Result<String, SecretsError> {
    let mut buffer = vec![0u8; bytes];
    random_bytes(&mut buffer)?;

    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug)]
pub struct SecretsError(pub String);

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SecretsError {}

/// The shortest token the host accepts at start: 128 bits of base64url would be 22 characters.
pub const MIN_TOKEN_LENGTH: usize = 22;

/// The backend's token drives the command registry; the CLI's is written to a user-only file. Neither
/// opens the other's door. Held in memory only.
pub struct Tokens {
    backend: String,
    cli: String,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Tokens { backend: [redacted], cli: [redacted] }")
    }
}

impl Tokens {
    /// Two fresh tokens of 24 random bytes (32 base64url characters), as the shell mints them.
    pub fn mint() -> Result<Tokens, SecretsError> {
        Tokens::from_values(random_base64url(24)?, random_base64url(24)?)
    }

    /// Fail closed: an empty, short or shared token means there is no credential to check against, so
    /// the host refuses to serve instead of serving a door anyone could open.
    pub fn from_values(backend: String, cli: String) -> Result<Tokens, SecretsError> {
        for (name, value) in [("backend", &backend), ("cli", &cli)] {
            if value.len() < MIN_TOKEN_LENGTH {
                return Err(SecretsError(format!("the {name} token is missing or too short: refusing to serve")));
            }
        }

        if same_token(Some(&backend), &cli) {
            return Err(SecretsError("the backend and CLI tokens are the same: refusing to serve".into()));
        }

        Ok(Tokens { backend, cli })
    }

    pub fn backend(&self) -> &str {
        &self.backend
    }

    pub fn cli(&self) -> &str {
        &self.cli
    }
}

/// Whether `supplied` is `expected`, compared in constant time over their digests so neither the
/// content nor the length of the secret shows in the timing. An absent or empty value is never equal.
pub fn same_token(supplied: Option<&str>, expected: &str) -> bool {
    let Some(supplied) = supplied else {
        return false;
    };

    if expected.is_empty() {
        return false;
    }

    let a = Sha256::digest(supplied.as_bytes());
    let b = Sha256::digest(expected.as_bytes());

    a.as_slice().ct_eq(b.as_slice()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_tokens_are_32_characters_and_distinct() {
        let tokens = Tokens::mint().unwrap();
        assert_eq!(tokens.backend().len(), 32);
        assert_eq!(tokens.cli().len(), 32);
        assert_ne!(tokens.backend(), tokens.cli());
    }

    #[test]
    fn a_missing_short_or_shared_token_refuses_to_serve() {
        assert!(Tokens::from_values(String::new(), "x".repeat(32)).is_err());
        assert!(Tokens::from_values("x".repeat(32), "short".into()).is_err());
        assert!(Tokens::from_values("x".repeat(32), "x".repeat(32)).is_err());
    }

    #[test]
    fn debug_never_prints_a_token() {
        let tokens = Tokens::mint().unwrap();
        assert!(!format!("{tokens:?}").contains(tokens.backend()));
        assert!(!format!("{:?}", Secret::new(SecretKind::Token, "abcdefghij")).contains("abcdefghij"));
    }

    #[test]
    fn same_token_is_exact_and_never_true_for_nothing() {
        assert!(same_token(Some("abc"), "abc"));
        assert!(!same_token(Some("abd"), "abc"));
        assert!(!same_token(Some(""), ""));
        assert!(!same_token(None, "abc"));
        assert!(!same_token(Some("abc"), ""));
    }
}
