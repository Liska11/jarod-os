//! Who may sign an update, and the check that they did.
//!
//! The key is ECDSA P-256, the kind `cosign` generates; the signature is `cosign sign-blob`'s (base64 DER
//! over the SHA-256 of the blob). Several keys may be trusted at once (rotation); none at all is an error,
//! because a host with no key to check against has nothing to check and must not start installing.

use crate::error::UpdateError;
use base64::{Engine, engine::general_purpose::STANDARD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use p256::pkcs8::DecodePublicKey;

/// A DER ECDSA P-256 signature is at most 72 bytes; anything much larger is not one.
const MAX_SIGNATURE_BYTES: usize = 128;

#[derive(Clone)]
pub struct TrustedKeys {
    keys: Vec<VerifyingKey>,
}

impl TrustedKeys {
    /// From PEM public keys (`-----BEGIN PUBLIC KEY-----`). An empty list, or a key that does not parse, is refused.
    pub fn from_pem(pems: &[&str]) -> Result<TrustedKeys, UpdateError> {
        if pems.is_empty() {
            return Err(UpdateError::Untrusted("no trusted key: the host will not install updates it cannot check".into()));
        }

        let keys = pems
            .iter()
            .map(|pem| VerifyingKey::from_public_key_pem(pem.trim()).map_err(|error| UpdateError::Untrusted(format!("a trusted key is not an ECDSA P-256 public key: {error}"))))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(TrustedKeys { keys })
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// `message` is the exact bytes that were signed; `signature_b64` is what `manifest.sig` holds.
    pub fn verify(&self, message: &[u8], signature_b64: &str) -> Result<(), UpdateError> {
        let compact: String = signature_b64.chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = STANDARD.decode(compact.as_bytes()).map_err(|_| UpdateError::Untrusted("the signature is not base64".into()))?;

        if bytes.is_empty() || bytes.len() > MAX_SIGNATURE_BYTES {
            return Err(UpdateError::Untrusted("the signature has an impossible size".into()));
        }

        let signature = Signature::from_der(&bytes).map_err(|_| UpdateError::Untrusted("the signature is not a DER ECDSA signature".into()))?;

        if self.keys.iter().any(|key| key.verify(message, &signature).is_ok()) {
            Ok(())
        } else {
            Err(UpdateError::Untrusted("the signature does not verify against any trusted key".into()))
        }
    }
}
