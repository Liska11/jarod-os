//! The C1 endpoint: `pipe://herald-os-<16 lowercase hex>`, emitted and accepted in that exact form.
//!
//! The Python client is more tolerant (`pipe://[A-Za-z0-9._-]{1,200}`) and the TypeScript shell
//! only ever emits the strict form; the Rust host does both ends strictly, so a typo or a hostile
//! name is refused here and not left for a reader to catch. There is no TCP endpoint.

use crate::secrets::{SecretsError, random_hex};
use std::fmt;

const PREFIX: &str = "pipe://herald-os-";
const NONCE_LENGTH: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PipeEndpoint {
    nonce: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct EndpointError(pub String);

impl fmt::Display for EndpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EndpointError {}

fn is_nonce(value: &str) -> bool {
    value.len() == NONCE_LENGTH && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl PipeEndpoint {
    /// A fresh endpoint with a per-run nonce: the host is the only party that knows the name until it
    /// publishes it (after the pipe's access policy has been verified).
    pub fn fresh() -> Result<PipeEndpoint, SecretsError> {
        Ok(PipeEndpoint { nonce: random_hex(NONCE_LENGTH / 2)? })
    }

    /// From a caller's nonce: exactly 16 lowercase hexadecimal characters, nothing else. The nonce is
    /// validated rather than trusted, so a name, a separator or an empty string cannot choose part of
    /// the pipe path.
    pub fn from_nonce(nonce: &str) -> Result<PipeEndpoint, EndpointError> {
        if !is_nonce(nonce) {
            return Err(EndpointError("a pipe nonce must be exactly 16 lowercase hexadecimal characters".into()));
        }

        Ok(PipeEndpoint { nonce: nonce.to_string() })
    }

    /// `pipe://herald-os-<nonce>`: what the backend is told to dial. Exact match only; anything else
    /// (`tcp://`, `http://`, a path, an uppercase nonce, trailing characters) is refused.
    pub fn parse(endpoint: &str) -> Result<PipeEndpoint, EndpointError> {
        let Some(nonce) = endpoint.strip_prefix(PREFIX) else {
            return Err(EndpointError(format!("not a control endpoint: expected {PREFIX}<16 lowercase hex>")));
        };

        PipeEndpoint::from_nonce(nonce)
    }

    pub fn endpoint(&self) -> String {
        format!("{PREFIX}{}", self.nonce)
    }

    /// The Windows path of the pipe object.
    pub fn path(&self) -> String {
        format!(r"\\.\pipe\herald-os-{}", self.nonce)
    }

    /// The part of the name only this host knows until it publishes the endpoint.
    pub fn nonce(&self) -> &str {
        &self.nonce
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_and_accepts_only_the_strict_form() {
        let endpoint = PipeEndpoint::from_nonce("0123456789abcdef").unwrap();
        assert_eq!(endpoint.endpoint(), "pipe://herald-os-0123456789abcdef");
        assert_eq!(endpoint.path(), r"\\.\pipe\herald-os-0123456789abcdef");
        assert_eq!(PipeEndpoint::parse(&endpoint.endpoint()).unwrap(), endpoint);

        for bad in [
            "",
            "tcp://127.0.0.1:5000",
            "http://localhost",
            "pipe://herald-os-",
            "pipe://herald-os-0123456789ABCDEF",
            "pipe://herald-os-0123456789abcde",
            "pipe://herald-os-0123456789abcdef0",
            "pipe://herald-os-0123456789abcdef/extra",
            "pipe://other-0123456789abcdef",
            "pipe://herald-os-..\\..\\x",
            " pipe://herald-os-0123456789abcdef",
        ] {
            assert!(PipeEndpoint::parse(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_fresh_endpoint_is_strict_and_unique() {
        let a = PipeEndpoint::fresh().unwrap();
        let b = PipeEndpoint::fresh().unwrap();
        assert_ne!(a, b);
        assert_eq!(PipeEndpoint::parse(&a.endpoint()).unwrap(), a);
    }
}
