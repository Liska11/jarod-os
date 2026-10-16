#![cfg(windows)]
//! The vault against the real DPAPI: nothing readable at rest, a blob that does not open is an error
//! and never an empty secret, a protector that fails leaves no trace, and a vault value that reaches a
//! journal line is masked before it is written.

use host_control::adjudicate::StaticCatalogue;
use host_control::audit::{ControlSecurity, FileJournal};
use host_control::capability::CapabilityStore;
use host_control::clock::SystemClock;
use host_control::contracts::Contracts;
use host_control::gate::{BoxFuture, Executor, HostCall, HostControlGate, Outcome};
use host_control::secrets::Tokens;
use host_control::types::Surface;
use host_control::wire::HostService;
use host_vault::{DpapiProtector, Protector, ProtectorError, Vault, VaultError, VaultObserver, VaultOp};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("host-vault-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

fn contracts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/v1")
}

fn dpapi() -> Arc<dyn Protector> {
    Arc::new(DpapiProtector)
}

/// Every byte under `dir`, searched for `needle` in the forms a careless writer might leave it in.
fn tree_contains(dir: &Path, needle: &str) -> bool {
    let forms: Vec<Vec<u8>> = vec![
        needle.as_bytes().to_vec(),
        needle.encode_utf16().flat_map(|u| u.to_le_bytes()).collect(),
        needle.bytes().map(|b| format!("{b:02x}")).collect::<String>().into_bytes(),
    ];
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        for item in fs::read_dir(&current).unwrap().flatten() {
            let path = item.path();

            if path.is_dir() {
                stack.push(path);
            } else {
                let bytes = fs::read(&path).unwrap();

                if forms.iter().any(|form| bytes.windows(form.len()).any(|window| window == form.as_slice())) {
                    return true;
                }
            }
        }
    }

    false
}

const API_KEY: &str = "sk-vaulted-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const BOT: &str = "123456789:AAEhBP0-vaulted-bot-secret-value_xyz";

#[test]
fn a_secret_round_trips_and_is_not_readable_at_rest() {
    let dir = scratch("rest");
    let vault = Vault::open(&dir, dpapi(), None).unwrap();

    vault.put("hermes.api-key", API_KEY.as_bytes()).unwrap();
    vault.put("telegram.bot", BOT.as_bytes()).unwrap();

    assert_eq!(vault.get("hermes.api-key").unwrap().unwrap().expose_str(), Some(API_KEY));
    assert_eq!(vault.get("telegram.bot").unwrap().unwrap().expose_str(), Some(BOT));
    assert_eq!(vault.list().unwrap(), vec!["hermes.api-key".to_string(), "telegram.bot".to_string()]);

    // Not in the files, not in any common encoding of them, not even a fragment of the key.
    for secret in [API_KEY, BOT, &API_KEY[3..20], &BOT[14..30]] {
        assert!(!tree_contains(&dir, secret), "{secret:?} is readable at rest");
    }

    // The files hold only the header and the sealed blob, and no temporary leftover.
    let names: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();

    assert!(names.iter().all(|n| n.ends_with(".sec")), "{names:?}");
    assert_eq!(&fs::read(dir.join("hermes.api-key.sec")).unwrap()[..5], b"JVLT\x01");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_secret_survives_a_restart_and_a_replacement_is_atomic() {
    let dir = scratch("restart");
    let vault = Vault::open(&dir, dpapi(), None).unwrap();

    vault.put("a.key", b"first-value-1234567890").unwrap();
    vault.put("a.key", b"second-value-1234567890").unwrap();
    drop(vault);

    let again = Vault::open(&dir, dpapi(), None).unwrap();

    assert_eq!(again.get("a.key").unwrap().unwrap().expose_str(), Some("second-value-1234567890"));
    assert!(again.known_secrets().iter().any(|s| s.value == "second-value-1234567890"));
    assert!(!again.known_secrets().iter().any(|s| s.value == "first-value-1234567890"), "a replaced value is no longer known");
    assert_eq!(again.get("absent").unwrap().map(|_| ()), None);
    assert!(again.delete("a.key").unwrap());
    assert!(!again.delete("a.key").unwrap());
    assert!(again.known_secrets().is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn names_and_values_are_validated_before_anything_touches_the_disk() {
    let dir = scratch("names");
    let vault = Vault::open(&dir, dpapi(), None).unwrap();

    for bad in ["", "A", "../x", "..\\x", "a/b", "a\\b", "nul", "con", "a.", " a", "1a", "a b", "é", &"a".repeat(65), "a:b"] {
        assert!(matches!(vault.put(bad, b"value-1234567"), Err(VaultError::InvalidName(_))), "{bad:?}");
        assert!(matches!(vault.get(bad), Err(VaultError::InvalidName(_))), "{bad:?}");
        assert!(matches!(vault.delete(bad), Err(VaultError::InvalidName(_))), "{bad:?}");
    }

    assert!(matches!(vault.put("ok", b""), Err(VaultError::InvalidValue(_))));
    assert!(matches!(vault.put("ok", &vec![b'x'; host_vault::MAX_SECRET_BYTES + 1]), Err(VaultError::InvalidValue(_))));
    assert!(vault.put("ok", &vec![b'x'; host_vault::MAX_SECRET_BYTES]).is_ok());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "refusals created nothing");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_blob_that_does_not_open_is_an_error_never_an_empty_secret() {
    let dir = scratch("tamper");
    let vault = Vault::open(&dir, dpapi(), None).unwrap();

    vault.put("a.key", API_KEY.as_bytes()).unwrap();
    vault.put("b.key", BOT.as_bytes()).unwrap();

    let path = dir.join("a.key.sec");
    let good = fs::read(&path).unwrap();

    // A flipped byte inside the sealed blob.
    let mut flipped = good.clone();
    let middle = flipped.len() / 2;

    flipped[middle] ^= 0x01;
    fs::write(&path, &flipped).unwrap();
    assert!(matches!(vault.get("a.key"), Err(VaultError::Corrupt(_))));

    // Truncated, wrong magic, wrong format, empty.
    for bytes in [good[..good.len() - 5].to_vec(), [b"XXXX".as_slice(), &good[4..]].concat(), [&good[..4], &[9u8][..], &good[5..]].concat(), Vec::new(), b"JVLT\x01".to_vec()] {
        fs::write(&path, bytes).unwrap();
        assert!(matches!(vault.get("a.key"), Err(VaultError::Corrupt(_))));
    }

    // The sealed blob of one name, copied under another: the name is part of the seal.
    fs::write(&path, &good).unwrap();
    fs::copy(&path, dir.join("c.key.sec")).unwrap();
    assert_eq!(vault.get("a.key").unwrap().unwrap().expose_str(), Some(API_KEY));
    assert!(matches!(vault.get("c.key"), Err(VaultError::Corrupt(_))), "a blob moved to another name does not open");

    // A broken secret never stops the others, and is not "known" after a reload.
    let reopened = Vault::open(&dir, dpapi(), None).unwrap();

    assert_eq!(reopened.get("b.key").unwrap().unwrap().expose_str(), Some(BOT));
    assert!(!reopened.known_secrets().iter().any(|s| s.value.is_empty()));
    assert_eq!(reopened.known_secrets().len(), 2, "a.key and b.key; c.key does not open");

    let _ = fs::remove_dir_all(&dir);
}

struct Flaky {
    inner: DpapiProtector,
    fail_protect: AtomicBool,
    fail_unprotect: AtomicBool,
}

impl Protector for Flaky {
    fn protect(&self, plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ProtectorError> {
        if self.fail_protect.load(Ordering::SeqCst) {
            return Err(ProtectorError("the OS refused to seal".into()));
        }

        self.inner.protect(plaintext, entropy)
    }

    fn unprotect(&self, sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ProtectorError> {
        if self.fail_unprotect.load(Ordering::SeqCst) {
            return Err(ProtectorError("sealed for another user".into()));
        }

        self.inner.unprotect(sealed, entropy)
    }
}

#[test]
fn a_protector_that_fails_leaves_no_file_and_keeps_the_previous_value() {
    let dir = scratch("flaky");
    let flaky = Arc::new(Flaky { inner: DpapiProtector, fail_protect: AtomicBool::new(false), fail_unprotect: AtomicBool::new(false) });
    let vault = Vault::open(&dir, flaky.clone(), None).unwrap();

    vault.put("a.key", b"original-value-123456").unwrap();
    flaky.fail_protect.store(true, Ordering::SeqCst);

    assert!(matches!(vault.put("a.key", b"replacement-value-123456"), Err(VaultError::Protector(_))));
    assert!(matches!(vault.put("new.key", b"never-stored-value-123456"), Err(VaultError::Protector(_))));

    flaky.fail_protect.store(false, Ordering::SeqCst);
    assert_eq!(vault.get("a.key").unwrap().unwrap().expose_str(), Some("original-value-123456"));
    assert_eq!(vault.get("new.key").unwrap().map(|_| ()), None);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no new file and no temporary");
    assert!(!vault.known_secrets().iter().any(|s| s.value.contains("replacement") || s.value.contains("never-stored")));

    // A seal that will not open (another user's, say) is an error to `get`, and unknown to the redaction.
    flaky.fail_unprotect.store(true, Ordering::SeqCst);
    assert!(matches!(vault.get("a.key"), Err(VaultError::Corrupt(_))));
    assert!(Vault::open(&dir, flaky.clone(), None).unwrap().known_secrets().is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[derive(Default)]
struct Recorder(Mutex<Vec<(VaultOp, String, bool)>>);

impl VaultObserver for Recorder {
    fn event(&self, op: VaultOp, name: &str, ok: bool) {
        self.0.lock().unwrap().push((op, name.to_string(), ok));
    }
}

#[test]
fn the_observer_hears_names_and_outcomes_and_never_a_value() {
    let dir = scratch("observer");
    let recorder = Arc::new(Recorder::default());
    let vault = Vault::open(&dir, dpapi(), Some(recorder.clone())).unwrap();

    vault.put("hermes.api-key", API_KEY.as_bytes()).unwrap();
    let _ = vault.get("hermes.api-key").unwrap();
    let _ = vault.get("nope");
    let _ = vault.put("../bad", b"value-1234567");
    let _ = vault.list();
    let _ = vault.delete("hermes.api-key");

    let events = recorder.0.lock().unwrap().clone();

    assert_eq!(
        events.iter().map(|(op, _, ok)| (*op, *ok)).collect::<Vec<_>>(),
        vec![(VaultOp::Put, true), (VaultOp::Get, true), (VaultOp::Get, true), (VaultOp::Put, false), (VaultOp::List, true), (VaultOp::Delete, true)]
    );
    assert!(!format!("{events:?}").contains(API_KEY));
    assert!(!format!("{:?}", vault.get("hermes.api-key")).contains(API_KEY), "no Debug output carries a value");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn debug_output_never_prints_a_secret() {
    let secret = host_vault::SecretBytes::new(API_KEY.as_bytes().to_vec());

    assert!(!format!("{secret:?}").contains(API_KEY));
    assert!(format!("{secret:?}").contains("redacted"));
    assert!(!VaultError::Corrupt("a.key".into()).to_string().contains(API_KEY));
}

#[test]
fn the_seal_is_bound_to_its_entropy_so_the_name_cannot_be_swapped() {
    let sealed = DpapiProtector.protect(API_KEY.as_bytes(), b"name-a").unwrap();

    assert!(!sealed.windows(API_KEY.len()).any(|w| w == API_KEY.as_bytes()));
    assert_eq!(DpapiProtector.unprotect(&sealed, b"name-a").unwrap(), API_KEY.as_bytes());
    assert!(DpapiProtector.unprotect(&sealed, b"name-b").is_err());
    assert!(DpapiProtector.unprotect(&sealed[..sealed.len() - 1], b"name-a").is_err());
    assert!(DpapiProtector.unprotect(b"", b"name-a").is_err());
}

#[test]
fn a_vault_directory_that_is_a_link_is_refused() {
    let base = scratch("link");
    let real = base.join("real");

    fs::create_dir_all(&real).unwrap();

    let link = base.join("link");
    let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&real).output().unwrap();

    assert!(made.status.success());
    assert!(matches!(Vault::open(&link, dpapi(), None), Err(VaultError::Refused(_))));
    assert_eq!(fs::read_dir(&real).unwrap().count(), 0);

    fs::remove_dir(&link).unwrap();
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_hardened_vault_directory_names_only_this_user() {
    let base = scratch("hardened");
    let dir = base.join("vault");
    let vault = Vault::open_hardened(&dir, dpapi(), None).unwrap();

    vault.put("a.key", API_KEY.as_bytes()).unwrap();

    let me = host_storage::acl::current_user().unwrap();
    let live = host_storage::acl::read_zone_dacl(&dir).unwrap();

    assert!(live.protected);
    assert_eq!(live.aces.iter().map(|(sid, _)| sid.clone()).collect::<Vec<_>>(), vec![me.clone()]);
    assert_eq!(vault.get("a.key").unwrap().unwrap().expose_str(), Some(API_KEY), "the owner still works in it");

    let file = host_storage::acl::read_zone_dacl(&dir.join("a.key.sec")).unwrap();

    assert!(file.aces.iter().all(|(sid, _)| *sid == me), "the file inherited the same policy: {:?}", file.aces);

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn concurrent_writers_all_land() {
    let dir = scratch("threads");
    let vault = Arc::new(Vault::open(&dir, dpapi(), None).unwrap());
    let mut handles = Vec::new();

    for number in 0..16 {
        let vault = vault.clone();

        handles.push(std::thread::spawn(move || vault.put(&format!("k{number}.key"), format!("value-number-{number}-abcdefghij").as_bytes())));
    }

    for handle in handles {
        handle.join().unwrap().unwrap();
    }

    assert_eq!(vault.list().unwrap().len(), 16);
    assert_eq!(vault.get("k7.key").unwrap().unwrap().expose_str(), Some("value-number-7-abcdefghij"));
    assert_eq!(vault.known_secrets().len(), 16);

    let _ = fs::remove_dir_all(&dir);
}

struct Echo;

impl Executor for Echo {
    fn run(&self, call: HostCall) -> BoxFuture<Outcome> {
        Box::pin(async move { Outcome::ok(format!("ran {}", call.command)) })
    }
}

/// The whole point: a value the vault holds, sent in any free-text field of a request, is written to the
/// journal as `[REDACTED:vault]`. The journal is a real file; the host is the real pipeline.
#[tokio::test]
async fn a_vault_value_in_a_request_never_reaches_the_journal_file() {
    let base = scratch("journal");
    let vault = Arc::new(Vault::open(base.join("vault"), dpapi(), None).unwrap());

    vault.put("hermes.api-key", API_KEY.as_bytes()).unwrap();
    vault.put("telegram.bot", BOT.as_bytes()).unwrap();

    let contracts = Contracts::load(&contracts_dir()).unwrap();
    let tokens = Tokens::mint().unwrap();
    let cli = tokens.cli().to_string();
    let journal_path = base.join("control-audit.jsonl");
    let journal = Arc::new(FileJournal::open(&journal_path).unwrap());
    let clock = Arc::new(SystemClock);
    let security =
        Arc::new(ControlSecurity::new(tokens, Surface::Panel, Arc::new(contracts.matrix.clone()), Arc::new(StaticCatalogue::default()), journal, clock.clone(), Vec::new()));

    security.add_secret_source(vault.secret_source());

    let gate = Arc::new(HostControlGate::new(security, CapabilityStore::new(clock), None));
    let service = HostService::new(gate, Arc::new(Echo));

    for line in [
        json!({ "cmd": "state", "token": cli, "source": format!("agent using {API_KEY}") }),
        json!({ "cmd": "theme", "token": cli, "source": BOT, "args": [API_KEY] }),
        json!({ "cmd": API_KEY, "token": cli }),
        json!({ "cmd": "run", "token": cli, "command": BOT, "requestId": "r1" }),
        json!({ "cmd": "state", "token": cli, "requestId": API_KEY }),
    ] {
        let reply = service.handle_line(&line.to_string()).await;

        assert!(reply.get("ok").is_some());
    }

    // A value stored after the host started is covered from that moment on.
    vault.put("late.key", b"late-arriving-secret-0123456789").unwrap();
    service.handle_line(&json!({ "cmd": "state", "token": cli, "source": "late-arriving-secret-0123456789" }).to_string()).await;

    let text = fs::read_to_string(&journal_path).unwrap();

    for secret in [API_KEY, BOT, "late-arriving-secret-0123456789"] {
        assert!(!text.contains(secret), "{secret} reached the journal");
    }

    assert!(text.matches("[REDACTED:vault]").count() >= 5, "{text}");
    assert!(!tree_contains(&base, API_KEY) && !tree_contains(&base, BOT), "and nowhere else under the host's files either");

    for line in text.lines() {
        let value: serde_json::Value = serde_json::from_str(line).unwrap();

        assert!(contracts.is_valid("c3-control-audit-entry", &value), "{line}");
    }

    let _ = fs::remove_dir_all(&base);
}
