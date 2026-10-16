//! One-shot capabilities: "this exact action was approved", spent once.
//!
//! A token says *who* is asking and can be copied; an approval says *what* was approved, once. A
//! mutation needs an approval the host itself witnessed, carried by a capability that names the
//! command, is bound to the arguments, expires, and can be spent only once. A capability that checks
//! out is burned *before* the call runs ([`CapabilityStore::spend`] verifies and consumes under one
//! `&mut self`), so a crash, a hang or a second connection racing the first cannot turn one approval
//! into two actions. The secret half is compared in constant time and never journalled; the journal
//! gets only a 12-hex fingerprint of the approval id.
//!
//! Port of `control-capability.ts`. Differences, by design: records are keyed by the public segment of
//! the id so the nonce is the only thing compared in constant time, and a wrong nonce answers
//! `Unknown` exactly like an id that was never issued.

use crate::clock::Clock;
use crate::secrets::{Secret, SecretKind, SecretsError, random_base64url, same_token};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

const ID_PREFIX: &str = "cap_";
/// 9 random bytes, base64url: 12 characters.
const ID_BYTES: usize = 9;
const ID_SEGMENT: usize = 12;
/// 18 random bytes, base64url: 24 characters.
const NONCE_BYTES: usize = 18;
const HOUR_MS: u64 = 3_600_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityOutcome {
    Ok,
    Unknown,
    Expired,
    Replayed,
    Mismatch,
    Malformed,
}

#[derive(Clone)]
pub struct CapabilityRecord {
    /// `cap_<12 chars>_<24 chars>`: the capability itself. Never written to a journal.
    pub id: String,
    pub approval_id: String,
    /// The canonical call name the capability is for (`registry:memory.forget`).
    pub command: String,
    /// sha256 over the command and the canonical argument JSON.
    pub binding: String,
    nonce: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub used_at: Option<u64>,
}

impl std::fmt::Debug for CapabilityRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CapabilityRecord {{ command: {:?}, binding: {}, [secret fields redacted] }}", self.command, self.binding)
    }
}

pub struct CapabilityCheck {
    pub outcome: CapabilityOutcome,
    pub record: Option<CapabilityRecord>,
    pub reason: String,
}

/// The canonical form of a call's arguments: sorted keys, so two spellings of the same object bind to
/// the same capability and a changed value does not. Rebuilt in sorted order whatever the map type.
pub fn canonical_args(value: &Value) -> String {
    fn walk(node: &Value) -> Value {
        match node {
            Value::Array(items) => Value::Array(items.iter().map(walk).collect()),
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();

                let mut out = Map::new();

                for key in keys {
                    out.insert(key.clone(), walk(&map[key]));
                }

                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    serde_json::to_string(&walk(value)).unwrap_or_else(|_| "unserialisable".to_string())
}

/// The binding of one call: its name and its arguments, together, hashed.
pub fn binding_of(command: &str, args: &Value) -> String {
    let digest = Sha256::digest(format!("{command}\u{0}{}", canonical_args(args)).as_bytes());

    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What a journal may say about a capability: enough to line an approval up with its use, and nothing
/// that would let a reader spend it.
pub fn fingerprint(record: &CapabilityRecord) -> String {
    let digest = Sha256::digest(record.approval_id.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    hex[..12].to_string()
}

pub struct CapabilityStore {
    clock: Arc<dyn Clock>,
    ttl_ms: u64,
    max: usize,
    records: HashMap<String, CapabilityRecord>,
    order: VecDeque<String>,
    counter: u64,
}

impl CapabilityStore {
    /// Defaults of the shell: 120 s to spend an approval, 32 outstanding at most.
    pub fn new(clock: Arc<dyn Clock>) -> CapabilityStore {
        CapabilityStore::with_limits(clock, 120_000, 32)
    }

    pub fn with_limits(clock: Arc<dyn Clock>, ttl_ms: u64, max: usize) -> CapabilityStore {
        CapabilityStore { clock, ttl_ms, max: max.max(1), records: HashMap::new(), order: VecDeque::new(), counter: 0 }
    }

    pub fn len(&mut self) -> usize {
        self.prune();

        self.records.len()
    }

    pub fn is_empty(&mut self) -> bool {
        self.len() == 0
    }

    /// Mint a capability for exactly this call. The caller has already witnessed the approval.
    pub fn grant(&mut self, command: &str, args: &Value, approval_id: Option<String>) -> Result<CapabilityRecord, SecretsError> {
        self.prune();

        while self.records.len() >= self.max {
            match self.order.pop_front() {
                Some(oldest) => {
                    self.records.remove(&oldest);
                }
                None => break,
            }
        }

        let issued_at = self.clock.now_ms();
        let nonce = random_base64url(NONCE_BYTES)?;
        let public = format!("{ID_PREFIX}{}", random_base64url(ID_BYTES)?);

        self.counter += 1;

        let approval_id = match approval_id {
            Some(id) => id,
            None => format!("ap_{}_{}", random_base64url(ID_BYTES)?, self.counter),
        };
        let record = CapabilityRecord {
            id: format!("{public}_{nonce}"),
            approval_id,
            command: command.to_string(),
            binding: binding_of(command, args),
            nonce,
            issued_at,
            expires_at: issued_at + self.ttl_ms,
            used_at: None,
        };

        self.order.push_back(public.clone());
        self.records.insert(public, record.clone());

        Ok(record)
    }

    fn split(id: &str) -> Option<(&str, &str)> {
        let head = ID_PREFIX.len() + ID_SEGMENT;

        if !id.is_ascii() || id.len() <= head + 1 || !id.starts_with(ID_PREFIX) || id.as_bytes()[head] != b'_' {
            return None;
        }

        Some((&id[..head], &id[head + 1..]))
    }

    /// Can this capability run this call? Order is the whole policy: a spent capability is spent
    /// whatever it is presented for, an expired one is expired, and a call that does not match the
    /// binding was never approved. Nothing here spends it.
    pub fn verify(&mut self, id: &str, command: &str, args: &Value) -> CapabilityCheck {
        let id = id.trim();

        if !id.starts_with(ID_PREFIX) {
            return CapabilityCheck { outcome: CapabilityOutcome::Malformed, record: None, reason: "a capability looks like cap_<id>_<nonce>".into() };
        }

        self.prune();

        let unknown = || CapabilityCheck { outcome: CapabilityOutcome::Unknown, record: None, reason: "no such capability (already spent, or never issued)".into() };
        let Some((public, presented)) = Self::split(id) else {
            return unknown();
        };
        let Some(record) = self.records.get(public) else {
            return unknown();
        };

        // Constant time on the secret half; the rest is a name, not a credential. A wrong nonce is
        // answered like an id that was never issued, so the answer does not confirm the name exists.
        if !same_token(Some(presented), &record.nonce) {
            return unknown();
        }

        let record = record.clone();
        let verdict = |outcome: CapabilityOutcome, reason: String| CapabilityCheck { outcome, record: Some(record.clone()), reason };

        if record.used_at.is_some() {
            return verdict(CapabilityOutcome::Replayed, "this capability has already been spent".into());
        }

        if self.clock.now_ms() >= record.expires_at {
            return verdict(CapabilityOutcome::Expired, "this capability has expired".into());
        }

        if record.command != command {
            return verdict(CapabilityOutcome::Mismatch, format!("this capability is for {}, not {command}", record.command));
        }

        if record.binding != binding_of(command, args) {
            return verdict(CapabilityOutcome::Mismatch, "the arguments changed since this capability was issued".into());
        }

        verdict(CapabilityOutcome::Ok, "approved for this call".into())
    }

    /// Burn a capability: it can be spent once, by one caller, for one call.
    pub fn consume(&mut self, record: &CapabilityRecord) {
        let now = self.clock.now_ms();

        if let Some((public, _)) = Self::split(&record.id)
            && let Some(stored) = self.records.get_mut(public)
        {
            stored.used_at = Some(now);
        }
    }

    /// Verify and, when it checks out, burn — under one exclusive borrow, so two requests cannot both
    /// spend the same capability.
    pub fn spend(&mut self, id: &str, command: &str, args: &Value) -> CapabilityCheck {
        let check = self.verify(id, command, args);

        if check.outcome == CapabilityOutcome::Ok
            && let Some(record) = &check.record
        {
            self.consume(record);
        }

        check
    }

    /// Every capability and nonce still on record, so the journal can keep them out.
    pub fn secrets(&self) -> Vec<Secret> {
        self.records.values().flat_map(|record| [Secret::new(SecretKind::Capability, record.id.clone()), Secret::new(SecretKind::Nonce, record.nonce.clone())]).collect()
    }

    /// Keep memory bounded without losing an answer a caller still needs: a record is forgotten only an
    /// hour after it expired (or was spent), so a late attempt is told `expired` or `replayed` rather
    /// than `unknown`. `grant` evicts the oldest record at `max`, which is the real memory bound.
    fn prune(&mut self) {
        let now = self.clock.now_ms();
        let stale: Vec<String> =
            self.records.iter().filter(|(_, record)| now.saturating_sub(record.used_at.unwrap_or(record.expires_at)) > HOUR_MS).map(|(public, _)| public.clone()).collect();

        for public in stale {
            self.records.remove(&public);
            self.order.retain(|item| item != &public);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Manual(AtomicU64);

    impl Clock for Manual {
        fn now_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn store() -> (CapabilityStore, Arc<Manual>) {
        let clock = Arc::new(Manual(AtomicU64::new(1_000_000)));

        (CapabilityStore::new(clock.clone()), clock)
    }

    #[test]
    fn ids_have_the_documented_shape() {
        let (mut store, _) = store();
        let record = store.grant("registry:x", &json!({}), None).unwrap();

        assert!(record.id.starts_with("cap_"));
        assert_eq!(record.id.len(), 4 + 12 + 1 + 24);
        assert_eq!(record.id.as_bytes()[16], b'_');
    }

    #[test]
    fn is_spent_once() {
        let (mut store, _) = store();
        let args = json!({ "args": { "t": 1 } });
        let record = store.grant("registry:x", &args, None).unwrap();

        assert_eq!(store.verify(&record.id, "registry:x", &args).outcome, CapabilityOutcome::Ok);
        assert_eq!(store.spend(&record.id, "registry:x", &args).outcome, CapabilityOutcome::Ok);
        assert_eq!(store.spend(&record.id, "registry:x", &args).outcome, CapabilityOutcome::Replayed);
        assert_eq!(store.verify(&record.id, "registry:x", &args).outcome, CapabilityOutcome::Replayed);
    }

    #[test]
    fn a_changed_call_or_argument_was_never_approved() {
        let (mut store, _) = store();
        let record = store.grant("registry:x", &json!({ "a": 1, "b": 2 }), None).unwrap();

        assert_eq!(store.verify(&record.id, "registry:y", &json!({ "a": 1, "b": 2 })).outcome, CapabilityOutcome::Mismatch);
        assert_eq!(store.verify(&record.id, "registry:x", &json!({ "a": 2, "b": 2 })).outcome, CapabilityOutcome::Mismatch);
        // Two spellings of the same object bind to the same capability.
        assert_eq!(store.verify(&record.id, "registry:x", &json!({ "b": 2, "a": 1 })).outcome, CapabilityOutcome::Ok);
        // A mismatch does not spend it.
        assert_eq!(store.spend(&record.id, "registry:x", &json!({ "a": 1, "b": 2 })).outcome, CapabilityOutcome::Ok);
    }

    #[test]
    fn expires_after_its_ttl_and_is_remembered_as_expired_for_an_hour() {
        let (mut store, clock) = store();
        let record = store.grant("registry:x", &json!({}), None).unwrap();

        clock.0.fetch_add(119_999, Ordering::SeqCst);
        assert_eq!(store.verify(&record.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Ok);
        clock.0.fetch_add(1, Ordering::SeqCst);
        assert_eq!(store.verify(&record.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Expired);
        clock.0.fetch_add(HOUR_MS, Ordering::SeqCst);
        // Exactly an hour after it expired it is still remembered; one millisecond later it is not.
        assert_eq!(store.verify(&record.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Expired);
        clock.0.fetch_add(1, Ordering::SeqCst);
        assert_eq!(store.verify(&record.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Unknown);
    }

    #[test]
    fn wrong_malformed_and_foreign_ids_are_refused() {
        let (mut store, _) = store();
        let record = store.grant("registry:x", &json!({}), None).unwrap();
        let mut wrong = record.id.clone();
        wrong.pop();
        wrong.push(if record.id.ends_with('A') { 'B' } else { 'A' });

        assert_eq!(store.verify(&wrong, "registry:x", &json!({})).outcome, CapabilityOutcome::Unknown);
        assert_eq!(store.verify("nope", "registry:x", &json!({})).outcome, CapabilityOutcome::Malformed);
        assert_eq!(store.verify("cap_short", "registry:x", &json!({})).outcome, CapabilityOutcome::Unknown);
        assert_eq!(store.verify("", "registry:x", &json!({})).outcome, CapabilityOutcome::Malformed);
        assert_eq!(store.verify("cap_é", "registry:x", &json!({})).outcome, CapabilityOutcome::Unknown);
    }

    #[test]
    fn the_oldest_is_evicted_at_the_bound() {
        let clock = Arc::new(Manual(AtomicU64::new(1)));
        let mut store = CapabilityStore::with_limits(clock, 120_000, 2);
        let first = store.grant("registry:x", &json!({}), None).unwrap();
        let second = store.grant("registry:x", &json!({}), None).unwrap();
        let third = store.grant("registry:x", &json!({}), None).unwrap();

        assert_eq!(store.len(), 2);
        assert_eq!(store.verify(&first.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Unknown);
        assert_eq!(store.verify(&second.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Ok);
        assert_eq!(store.verify(&third.id, "registry:x", &json!({})).outcome, CapabilityOutcome::Ok);
    }

    #[test]
    fn the_fingerprint_is_12_hex_and_is_not_the_capability() {
        let (mut store, _) = store();
        let record = store.grant("registry:x", &json!({}), Some("ask_1".into())).unwrap();
        let print = fingerprint(&record);

        assert_eq!(print.len(), 12);
        assert!(print.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert!(!record.id.contains(&print));
    }

    #[test]
    fn debug_and_secrets_never_leak_through_the_wrong_door() {
        let (mut store, _) = store();
        let record = store.grant("registry:x", &json!({}), None).unwrap();

        assert!(!format!("{record:?}").contains(&record.id));
        assert!(store.secrets().iter().any(|secret| secret.value == record.id));
    }
}
