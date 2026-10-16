//! The updater against real directories, real hashes and real ECDSA signatures (made in memory with a key
//! generated for each test and never written anywhere): nothing unsigned installs, a tampered bundle is
//! refused, a failed or silent update is rolled back to the last known good, and the running version is
//! never touched while an update is being prepared.

use host_control::clock::Clock;
use host_control::contracts::Contracts;
use host_control::secrets::random_bytes;
use host_updater::state::State;
use host_updater::{Slot, TrustedKeys, UpdateError, Updater, UpdaterConfig};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::pkcs8::{EncodePublicKey, LineEnding};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const START: u64 = 1_760_616_000_000;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("host-updater-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

fn contracts() -> Arc<Contracts> {
    Arc::new(Contracts::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/v1")).unwrap())
}

struct Clk(AtomicU64);

impl Clock for Clk {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A signing key that lives in memory for one test.
struct Publisher {
    key: SigningKey,
}

impl Publisher {
    fn new() -> Publisher {
        loop {
            let mut bytes = [0u8; 32];

            random_bytes(&mut bytes).unwrap();

            if let Ok(key) = SigningKey::from_slice(&bytes) {
                return Publisher { key };
            }
        }
    }

    fn pem(&self) -> String {
        self.key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap()
    }

    fn sign(&self, message: &[u8]) -> String {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let signature: Signature = self.key.sign(message);

        STANDARD.encode(signature.to_der().as_bytes())
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

struct Spec<'a> {
    version: &'a str,
    channel: &'a str,
    files: Vec<(&'a str, Vec<u8>)>,
    entry: &'a str,
}

impl<'a> Spec<'a> {
    fn new(version: &'a str) -> Spec<'a> {
        Spec {
            version,
            channel: "stable",
            files: vec![("bin/herald-host.exe", format!("host {version}").into_bytes()), ("resources/gateway.mjs", format!("kernel {version}").into_bytes())],
            entry: "bin/herald-host.exe",
        }
    }
}

/// Writes a bundle (files, manifest.json, manifest.sig) and returns its folder.
fn bundle(base: &Path, publisher: &Publisher, spec: &Spec) -> PathBuf {
    let dir = base.join(format!("bundle-{}-{}", spec.version, COUNTER.fetch_add(1, Ordering::SeqCst)));

    for (path, bytes) in &spec.files {
        let target = dir.join(path);

        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }

    let manifest = json!({
        "schema": 1,
        "product": "jarod-os",
        "version": spec.version,
        "channel": spec.channel,
        "createdAt": "2026-10-16T12:00:00Z",
        "entry": spec.entry,
        "files": spec.files.iter().map(|(path, bytes)| json!({ "path": path, "sha256": sha(bytes), "size": bytes.len() })).collect::<Vec<_>>(),
    });
    let bytes = serde_json::to_vec(&manifest).unwrap();

    fs::write(dir.join("manifest.json"), &bytes).unwrap();
    fs::write(dir.join("manifest.sig"), publisher.sign(&bytes)).unwrap();

    dir
}

struct Rig {
    base: PathBuf,
    publisher: Publisher,
    clock: Arc<Clk>,
    updater: Updater,
    root: PathBuf,
}

fn rig(name: &str) -> Rig {
    rig_with(name, UpdaterConfig::default())
}

fn rig_with(name: &str, config: UpdaterConfig) -> Rig {
    let base = scratch(name);
    let publisher = Publisher::new();
    let clock = Arc::new(Clk(AtomicU64::new(START)));
    let root = base.join("updater");
    let updater = Updater::open(&root, TrustedKeys::from_pem(&[&publisher.pem()]).unwrap(), contracts(), clock.clone(), config).unwrap();

    Rig { base, publisher, clock, updater, root }
}

fn reopen(rig: &Rig) -> Result<Updater, UpdateError> {
    Updater::open(&rig.root, TrustedKeys::from_pem(&[&rig.publisher.pem()]).unwrap(), contracts(), rig.clock.clone(), UpdaterConfig::default())
}

/// Installs `version` as the running, confirmed one.
fn install(rig: &Rig, version: &str) {
    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new(version))).unwrap();

    rig.updater.activate(&staged).unwrap();
    rig.updater.begin_boot().unwrap();
    rig.updater.confirm_healthy().unwrap();
}

fn hash_tree(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        for item in fs::read_dir(&current).unwrap().flatten() {
            let path = item.path();

            if path.is_dir() {
                stack.push(path);
            } else if !item.file_name().to_string_lossy().starts_with('.') {
                // The payload and its signed manifest; the `.current` and `.validated` markers move on purpose.
                out.push((path.strip_prefix(dir).unwrap().to_string_lossy().to_string(), sha(&fs::read(&path).unwrap())));
            }
        }
    }

    out.sort();

    out
}

fn is_untrusted(error: &UpdateError) -> bool {
    matches!(error, UpdateError::Untrusted(_))
}

// ---------------------------------------------------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_key_committed_for_the_images_is_a_key_the_updater_can_use() {
    let pem = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../linux/image/cosign.pub")).unwrap();
    let keys = TrustedKeys::from_pem(&[&pem]).unwrap();

    assert_eq!(keys.len(), 1);
    // Nothing the real key's owner did not sign verifies against it.
    assert!(is_untrusted(&keys.verify(b"a manifest", "MEUCIQDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxAiB=").unwrap_err()));
}

#[test]
fn a_host_with_no_key_to_check_against_does_not_install_anything() {
    assert!(is_untrusted(&TrustedKeys::from_pem(&[]).err().unwrap()));
    assert!(is_untrusted(&TrustedKeys::from_pem(&["not a key"]).err().unwrap()));
    assert!(is_untrusted(&TrustedKeys::from_pem(&["-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"]).err().unwrap()));
}

#[test]
fn signatures_are_checked_against_the_exact_bytes_and_any_trusted_key() {
    let (a, b, stranger) = (Publisher::new(), Publisher::new(), Publisher::new());
    let keys = TrustedKeys::from_pem(&[&a.pem(), &b.pem()]).unwrap();

    assert!(keys.verify(b"manifest", &a.sign(b"manifest")).is_ok());
    assert!(keys.verify(b"manifest", &b.sign(b"manifest")).is_ok(), "key rotation: either of the trusted keys");
    assert!(is_untrusted(&keys.verify(b"manifest", &stranger.sign(b"manifest")).unwrap_err()));
    assert!(is_untrusted(&keys.verify(b"manifest!", &a.sign(b"manifest")).unwrap_err()), "one byte different");

    for garbage in ["", "   ", "not base64 !!", "AAAA", &"A".repeat(400)] {
        assert!(is_untrusted(&keys.verify(b"manifest", garbage).unwrap_err()), "{garbage:?}");
    }

    // Whitespace around a base64 signature (a trailing newline, a wrapped line) is tolerated.
    let signature = a.sign(b"manifest");

    assert!(keys.verify(b"manifest", &format!("{}\n", &signature)).is_ok());
}

// ---------------------------------------------------------------------------------------------------------------------
// The bundle is what was signed, or it is refused
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn nothing_unsigned_or_wrongly_signed_is_installed_and_nothing_is_touched() {
    let rig = rig("untrusted");

    install(&rig, "0.1.0");

    let running = hash_tree(&rig.updater.slot_dir(Slot::A));
    let before = rig.updater.snapshot().unwrap();
    let stranger = Publisher::new();

    // Signed by someone else.
    let wrong_key = bundle(&rig.base, &stranger, &Spec::new("0.2.0"));

    assert!(is_untrusted(&rig.updater.stage(&wrong_key).unwrap_err()));

    // No signature file; an empty one; a signature over different bytes; a manifest edited after signing.
    let unsigned = bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"));

    fs::remove_file(unsigned.join("manifest.sig")).unwrap();
    assert!(matches!(rig.updater.stage(&unsigned).unwrap_err(), UpdateError::Invalid(_)));

    fs::write(unsigned.join("manifest.sig"), "").unwrap();
    assert!(is_untrusted(&rig.updater.stage(&unsigned).unwrap_err()));

    let edited = bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"));
    let text = fs::read_to_string(edited.join("manifest.json")).unwrap().replace("0.2.0", "9.9.9");

    fs::write(edited.join("manifest.json"), text).unwrap();
    assert!(is_untrusted(&rig.updater.stage(&edited).unwrap_err()), "a signed manifest cannot be edited");

    // The running version and the state are exactly as they were.
    assert_eq!(hash_tree(&rig.updater.slot_dir(Slot::A)), running);
    assert_eq!(rig.updater.snapshot().unwrap(), before);
    assert!(!rig.updater.slot_dir(Slot::B).exists());
    assert!(!rig.root.join("staging").exists());
}

#[test]
fn a_bundle_that_is_not_what_its_signed_manifest_says_is_refused() {
    let rig = rig("tampered");
    let mut cases: Vec<(&str, PathBuf)> = Vec::new();

    // A byte of a file changed after signing (same size, different hash).
    let flipped = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));

    fs::write(flipped.join("bin/herald-host.exe"), "host 0.1.1").unwrap();
    cases.push(("a changed file", flipped));

    // A longer file.
    let longer = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));

    fs::write(longer.join("resources/gateway.mjs"), "kernel 0.1.0 and then some").unwrap();
    cases.push(("a size mismatch", longer));

    // A listed file missing.
    let missing = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));

    fs::remove_file(missing.join("resources/gateway.mjs")).unwrap();
    cases.push(("a missing file", missing));

    // A file the manifest does not list.
    let extra = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));

    fs::write(extra.join("evil.dll"), "x").unwrap();
    cases.push(("an extra file", extra));

    // A file that is a directory.
    let directory = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));

    fs::remove_file(directory.join("resources/gateway.mjs")).unwrap();
    fs::create_dir(directory.join("resources/gateway.mjs")).unwrap();
    cases.push(("a directory where a file is listed", directory));

    for (what, dir) in &cases {
        let error = rig.updater.stage(dir).unwrap_err();

        assert!(matches!(error, UpdateError::Tampered(_)), "{what}: {error:?}");
    }

    assert!(rig.updater.snapshot().unwrap().current.is_none(), "nothing was installed");
    assert!(!rig.updater.slot_dir(Slot::A).exists() && !rig.root.join("staging").exists());
}

#[test]
fn verifying_a_bundle_on_its_own_checks_every_hash_and_installs_nothing() {
    let rig = rig("verify-only");
    let good = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));
    let bad = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));

    fs::write(bad.join("resources/gateway.mjs"), "kernel 9.9.9").unwrap();

    assert_eq!(rig.updater.verify_bundle(&good).unwrap().version.to_string(), "0.1.0");
    assert!(matches!(rig.updater.verify_bundle(&bad).unwrap_err(), UpdateError::Tampered(_)), "same size, different bytes");
    assert!(rig.updater.snapshot().unwrap().current.is_none() && !rig.updater.slot_dir(Slot::A).exists(), "verifying installs nothing");
}

#[cfg(windows)]
#[test]
fn a_link_inside_a_bundle_is_refused() {
    let rig = rig("link");
    let dir = bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"));
    let outside = scratch("link-outside");

    fs::write(outside.join("secret.txt"), "not part of the update").unwrap();

    let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("resources").join("link")).arg(&outside).output().unwrap();

    assert!(made.status.success());
    assert!(matches!(rig.updater.stage(&dir).unwrap_err(), UpdateError::Tampered(_)));

    fs::remove_dir(dir.join("resources").join("link")).unwrap();
    assert!(rig.updater.stage(&dir).is_ok(), "without the link the same bundle installs");
}

#[test]
fn a_signed_manifest_still_has_to_obey_the_contract_and_the_path_rules() {
    let rig = rig("rules");
    let publisher = &rig.publisher;
    let sign_and_write = |dir: &Path, manifest: serde_json::Value| {
        let bytes = serde_json::to_vec(&manifest).unwrap();

        fs::write(dir.join("manifest.json"), &bytes).unwrap();
        fs::write(dir.join("manifest.sig"), publisher.sign(&bytes)).unwrap();
    };
    let h = sha(b"x");
    let base = |files: serde_json::Value, entry: &str, channel: &str, version: &str| json!({ "schema": 1, "product": "jarod-os", "version": version, "channel": channel, "createdAt": "2026-10-16T12:00:00Z", "entry": entry, "files": files });

    for (what, manifest) in [
        ("a path that climbs out", base(json!([{ "path": "../../Windows/evil.dll", "sha256": h, "size": 1 }]), "a.exe", "stable", "0.1.0")),
        ("an absolute path", base(json!([{ "path": "C:/Windows/evil.dll", "sha256": h, "size": 1 }]), "a.exe", "stable", "0.1.0")),
        ("a device name", base(json!([{ "path": "con.txt", "sha256": h, "size": 1 }, { "path": "a.exe", "sha256": h, "size": 1 }]), "a.exe", "stable", "0.1.0")),
        ("the same file in two cases", base(json!([{ "path": "a.exe", "sha256": h, "size": 1 }, { "path": "A.EXE", "sha256": h, "size": 1 }]), "a.exe", "stable", "0.1.0")),
        ("an entry that is not a file of the update", base(json!([{ "path": "a.exe", "sha256": h, "size": 1 }]), "b.exe", "stable", "0.1.0")),
        ("an unsigned channel", base(json!([{ "path": "a.exe", "sha256": h, "size": 1 }]), "a.exe", "unsigned", "0.1.0")),
        ("a pre-release version", base(json!([{ "path": "a.exe", "sha256": h, "size": 1 }]), "a.exe", "stable", "0.1.0-rc1")),
        (
            "an update larger than this host accepts",
            base(json!([{ "path": "a.exe", "sha256": h, "size": 17_179_869_184u64 }, { "path": "b.exe", "sha256": h, "size": 17_179_869_184u64 }]), "a.exe", "stable", "0.1.0"),
        ),
    ] {
        let dir = rig.base.join(format!("rules-{}", COUNTER.fetch_add(1, Ordering::SeqCst)));

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.exe"), "x").unwrap();
        sign_and_write(&dir, manifest);

        let error = rig.updater.stage(&dir).unwrap_err();

        assert!(matches!(error, UpdateError::Invalid(_)), "{what}: {error:?}");
    }

    assert!(rig.updater.snapshot().unwrap().current.is_none());
}

#[test]
fn only_a_newer_version_installs() {
    let rig = rig("versions");

    install(&rig, "0.2.0");

    for offered in ["0.2.0", "0.1.9", "0.1.0"] {
        let error = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new(offered))).unwrap_err();

        assert!(matches!(error, UpdateError::Downgrade { .. }), "{offered}: {error:?}");
    }

    // Numerically: 0.10.0 is newer than 0.9.0, even though "0.10.0" sorts before "0.9.0" as text.
    install(&rig, "0.9.0");
    assert!(rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.10.0"))).is_ok());
}

// ---------------------------------------------------------------------------------------------------------------------
// A/B slots, the trial, the rollback
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_first_install_runs_with_nothing_to_fall_back_to() {
    let rig = rig("first");
    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.1.0"))).unwrap();

    assert_eq!(staged.slot, Slot::A);
    assert!(rig.updater.snapshot().unwrap().current.is_none(), "staged is not running");

    rig.updater.activate(&staged).unwrap();

    let plan = rig.updater.begin_boot().unwrap();

    assert_eq!((plan.slot, plan.version.as_str(), plan.trial), (Slot::A, "0.1.0", false), "no previous version, so no trial");
    assert!(plan.entry.ends_with("herald-host.exe") && plan.entry.exists());
    assert!(rig.updater.report_failure("it crashed").is_err(), "with nothing to return to, a failure is reported as such");
    rig.updater.confirm_healthy().unwrap();
    assert!(rig.updater.slot_dir(Slot::A).join(".validated").exists() && rig.updater.slot_dir(Slot::A).join(".current").exists());
}

#[test]
fn an_update_is_prepared_in_the_other_slot_and_the_running_version_is_never_touched() {
    let rig = rig("ab");

    install(&rig, "0.1.0");

    let running = hash_tree(&rig.updater.slot_dir(Slot::A));
    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    assert_eq!(staged.slot, Slot::B);
    assert_eq!(hash_tree(&rig.updater.slot_dir(Slot::A)), running, "slot A is byte for byte what it was");
    assert_eq!(rig.updater.snapshot().unwrap().current, Some(Slot::A), "and it is still the one that runs");
    assert_eq!(rig.updater.begin_boot().unwrap().version, "0.1.0");

    rig.updater.activate(&staged).unwrap();

    let state = rig.updater.snapshot().unwrap();

    assert_eq!((state.current, state.previous), (Some(Slot::B), Some(Slot::A)));
    assert!(state.pending.is_some(), "a trial is open");
    assert_eq!(hash_tree(&rig.updater.slot_dir(Slot::A)), running, "the last known good is still intact during the trial");
    assert!(rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.3.0"))).is_err(), "no second update while one is on trial");

    let plan = rig.updater.begin_boot().unwrap();

    assert_eq!((plan.slot, plan.version.as_str(), plan.trial), (Slot::B, "0.2.0", true));
    rig.updater.confirm_healthy().unwrap();

    let state = rig.updater.snapshot().unwrap();

    assert!(state.pending.is_none() && state.record(Slot::B).unwrap().validated);
    assert_eq!(state.previous, Some(Slot::A), "the old version is kept as the previous one");
    assert!(rig.updater.slot_dir(Slot::B).join(".current").exists() && !rig.updater.slot_dir(Slot::A).join(".current").exists());
}

#[test]
fn a_failed_health_check_restores_the_last_good_version_and_blocks_the_bad_one() {
    let rig = rig("fail");

    install(&rig, "0.1.0");

    let good = hash_tree(&rig.updater.slot_dir(Slot::A));
    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();
    assert!(rig.updater.begin_boot().unwrap().trial);

    let restored = rig.updater.report_failure("the gateway did not answer").unwrap();

    assert_eq!(restored, "0.1.0");

    let state = rig.updater.snapshot().unwrap();

    assert_eq!((state.current, state.previous, state.pending.is_none()), (Some(Slot::A), None, true));
    assert_eq!(state.blocked, vec!["0.2.0".to_string()]);
    assert_eq!(hash_tree(&rig.updater.slot_dir(Slot::A)), good);
    assert_eq!(state.history.last().unwrap().event, "rolled-back");
    assert!(state.history.last().unwrap().detail.contains("the gateway did not answer"));

    let plan = rig.updater.begin_boot().unwrap();

    assert_eq!((plan.version.as_str(), plan.trial), ("0.1.0", false));
    assert!(rig.updater.slot_dir(Slot::A).join(".current").exists() && !rig.updater.slot_dir(Slot::B).join(".current").exists());

    // The version that failed is not tried again; a newer one is.
    assert!(matches!(rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap_err(), UpdateError::Blocked(_)));
    assert!(rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.1"))).is_ok());

    // On the person's say-so a blocked version can be offered again.
    assert!(rig.updater.unblock("0.2.0").unwrap());
    assert!(!rig.updater.unblock("0.2.0").unwrap());
}

#[test]
fn an_update_that_never_confirms_within_its_deadline_is_rolled_back_at_the_next_boot() {
    let rig = rig_with("deadline", UpdaterConfig { health_deadline_ms: 60_000, ..UpdaterConfig::default() });

    install(&rig, "0.1.0");

    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();
    rig.clock.0.fetch_add(59_000, Ordering::SeqCst);
    assert!(rig.updater.begin_boot().unwrap().trial, "still inside its deadline");

    // The machine lost power, or the version hung: it never confirmed.
    rig.clock.0.fetch_add(2_000, Ordering::SeqCst);

    let plan = rig.updater.begin_boot().unwrap();

    assert_eq!((plan.version.as_str(), plan.trial), ("0.1.0", false));
    assert!(rig.updater.snapshot().unwrap().history.last().unwrap().detail.contains("no confirmation within the health deadline"));
}

#[test]
fn a_version_that_crash_loops_is_given_up_on_after_a_few_starts() {
    let rig = rig_with("crashloop", UpdaterConfig { max_trial_boots: 3, ..UpdaterConfig::default() });

    install(&rig, "0.1.0");

    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();

    for attempt in 1..=3 {
        let plan = rig.updater.begin_boot().unwrap();

        assert_eq!((plan.version.as_str(), plan.trial), ("0.2.0", true), "start {attempt}");
        // It dies before it can say anything.
    }

    let plan = rig.updater.begin_boot().unwrap();

    assert_eq!((plan.version.as_str(), plan.trial), ("0.1.0", false), "the fourth start is the last good one");
    assert!(rig.updater.snapshot().unwrap().history.last().unwrap().detail.contains("started 3 times without confirming"));
}

#[test]
fn a_slot_whose_files_no_longer_match_what_was_installed_does_not_run() {
    let rig = rig("integrity");

    install(&rig, "0.1.0");

    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();
    rig.updater.begin_boot().unwrap();
    rig.updater.confirm_healthy().unwrap();

    // Someone edits the running version on disk.
    fs::write(rig.updater.slot_dir(Slot::B).join("bin").join("herald-host.exe"), "patched").unwrap();

    let plan = rig.updater.begin_boot().unwrap();

    assert_eq!((plan.version.as_str(), plan.slot), ("0.1.0", Slot::A), "it fell back to the previous version, which verifies");
    assert!(rig.updater.snapshot().unwrap().history.last().unwrap().detail.contains("integrity check failed"));

    // With nothing to fall back to, it refuses to run the tampered version at all.
    fs::write(rig.updater.slot_dir(Slot::A).join("bin").join("herald-host.exe"), "patched too").unwrap();
    assert!(matches!(rig.updater.begin_boot().unwrap_err(), UpdateError::NoFallback(_)));
}

#[test]
fn a_rollback_to_a_previous_version_that_no_longer_verifies_is_refused() {
    let rig = rig("bad-fallback");

    install(&rig, "0.1.0");

    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();
    fs::write(rig.updater.slot_dir(Slot::A).join("resources").join("gateway.mjs"), "tampered last known good").unwrap();

    let error = rig.updater.report_failure("it failed").unwrap_err();

    assert!(matches!(error, UpdateError::NoFallback(_)), "{error:?}");
    assert_eq!(rig.updater.snapshot().unwrap().current, Some(Slot::B), "nothing was switched to something broken");
}

// ---------------------------------------------------------------------------------------------------------------------
// What survives a restart, and a crash
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_trial_and_its_start_count_survive_a_restart() {
    let rig = rig("restart");

    install(&rig, "0.1.0");

    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();
    rig.updater.begin_boot().unwrap();
    rig.updater.begin_boot().unwrap();

    let again = reopen(&rig).unwrap();
    let state = again.snapshot().unwrap();

    assert_eq!(state.pending.as_ref().map(|t| (t.slot, t.boots)), Some((Slot::B, 2)));
    assert_eq!((state.current, state.previous), (Some(Slot::B), Some(Slot::A)));
    assert_eq!(again.begin_boot().unwrap().version, "0.2.0");
}

#[test]
fn a_crash_between_staging_and_activating_leaves_a_state_that_cannot_roll_back_to_the_unvalidated_slot() {
    let rig = rig("crash-staged");

    install(&rig, "0.1.0");

    let staged = rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.2.0"))).unwrap();

    rig.updater.activate(&staged).unwrap();
    rig.updater.begin_boot().unwrap();
    rig.updater.confirm_healthy().unwrap();

    // 0.2.0 is running and confirmed; 0.1.0 is the previous. Stage 0.3.0 (it replaces slot A), then "crash".
    rig.updater.stage(&bundle(&rig.base, &rig.publisher, &Spec::new("0.3.0"))).unwrap();

    let again = reopen(&rig).unwrap();
    let state = again.snapshot().unwrap();

    assert_eq!(state.current, Some(Slot::B));
    assert_eq!(state.previous, None, "the previous version was overwritten by the staged one: it is no longer a fallback");
    assert_eq!(again.begin_boot().unwrap().version, "0.2.0", "the running version carries on");
}

#[test]
fn leftovers_of_a_crash_are_never_used_and_a_state_that_is_not_consistent_stops_the_host() {
    let rig = rig("crash-leftovers");

    install(&rig, "0.1.0");

    fs::create_dir_all(rig.root.join("staging").join("half-copied")).unwrap();
    fs::write(rig.root.join("staging").join("half-copied").join("bin.exe"), "partial").unwrap();
    fs::write(rig.root.join("state.json.tmp"), "{ half a state").unwrap();

    let again = reopen(&rig).unwrap();

    assert!(!rig.root.join("staging").exists() && !rig.root.join("state.json.tmp").exists(), "cleaned up at open");
    assert_eq!(again.begin_boot().unwrap().version, "0.1.0");

    // A state that does not read, is another version, or contradicts itself: refused, never guessed.
    let path = rig.root.join("state.json");
    let good = fs::read_to_string(&path).unwrap();
    let state: State = serde_json::from_str(&good).unwrap();

    for broken in [
        "{ not json".to_string(),
        good.replace("\"version\": 1", "\"version\": 7"),
        serde_json::to_string(&State { current: Some(Slot::A), previous: Some(Slot::A), ..state.clone() }).unwrap(),
        serde_json::to_string(&State { current: Some(Slot::B), ..state.clone() }).unwrap(),
        serde_json::to_string(&State { pending: Some(host_updater::state::Trial { slot: Slot::A, activated_ms: 0, boots: 0 }), ..state.clone() }).unwrap(),
    ] {
        fs::write(&path, broken).unwrap();
        assert!(matches!(reopen(&rig).err(), Some(UpdateError::State(_))));
    }

    fs::write(&path, good).unwrap();
    assert!(reopen(&rig).is_ok());
}

#[test]
fn the_state_file_is_replaced_atomically_and_leaves_no_sibling_behind() {
    let rig = rig("atomic");

    install(&rig, "0.1.0");

    for _ in 0..3 {
        rig.updater.confirm_healthy().unwrap();
    }

    let names: Vec<_> = fs::read_dir(&rig.root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();

    assert!(names.contains(&"state.json".to_string()) && !names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");
}

#[test]
fn the_history_is_kept_and_bounded() {
    let rig = rig("history");

    install(&rig, "0.1.0");

    for _ in 0..80 {
        rig.updater.confirm_healthy().unwrap();
    }

    let state = rig.updater.snapshot().unwrap();

    assert_eq!(state.history.len(), 50);
    assert_eq!(state.history.last().unwrap().event, "confirmed");
}
