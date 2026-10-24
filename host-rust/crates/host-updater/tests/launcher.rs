//! `jarod-launcher` end to end (Windows): real processes, real slots, real signatures (a key made in memory for each test). The "app"
//! in each bundle is a copy of `cmd.exe`, so a test can make it exit with an error, exit cleanly, or confirm its own trial through
//! `jarod-updater` the way Jarod-OS does — from the environment the launcher gives it.
#![cfg(windows)]

use host_control::secrets::random_bytes;
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::pkcs8::{EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn contracts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/v1")
}

fn key() -> SigningKey {
    loop {
        let mut bytes = [0u8; 32];

        random_bytes(&mut bytes).unwrap();

        if let Ok(key) = SigningKey::from_slice(&bytes) {
            return key;
        }
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

struct Rig {
    base: PathBuf,
    root: PathBuf,
    pem: PathBuf,
    signer: SigningKey,
}

fn rig(name: &str) -> Rig {
    let base = std::env::temp_dir().join(format!("jarod-launcher-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&base);

    fs::create_dir_all(&base).unwrap();

    let signer = key();
    let pem = base.join("test.pub");

    fs::write(&pem, signer.verifying_key().to_public_key_pem(LineEnding::LF).unwrap()).unwrap();

    Rig { root: base.join("updates"), base, pem, signer }
}

impl Rig {
    /// A bundle whose entry is a copy of cmd.exe, installed through `jarod-updater install`.
    fn install(&self, version: &str) -> Value {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let dir = self.base.join(format!("bundle-{version}"));
        let cmd = fs::read(Path::new(&std::env::var("SystemRoot").unwrap()).join("System32").join("cmd.exe")).unwrap();
        let marker = format!("version {version}").into_bytes();

        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::write(dir.join("bin").join("app.exe"), &cmd).unwrap();
        fs::write(dir.join("version.txt"), &marker).unwrap();

        let manifest = serde_json::to_vec(&json!({
            "schema": 1, "product": "jarod-os", "version": version, "channel": "stable", "createdAt": "2026-10-24T12:00:00Z",
            "entry": "bin/app.exe",
            "files": [
                { "path": "bin/app.exe", "sha256": sha(&cmd), "size": cmd.len() },
                { "path": "version.txt", "sha256": sha(&marker), "size": marker.len() },
            ],
        }))
        .unwrap();
        let signature: Signature = self.signer.sign(&manifest);

        fs::write(dir.join("manifest.json"), &manifest).unwrap();
        fs::write(dir.join("manifest.sig"), STANDARD.encode(signature.to_der().as_bytes())).unwrap();

        self.updater(&["install", "--bundle", dir.to_str().unwrap()])
    }

    fn updater(&self, args: &[&str]) -> Value {
        let out = Command::new(env!("CARGO_BIN_EXE_jarod-updater"))
            .args(args)
            .arg("--root")
            .arg(&self.root)
            .arg("--contracts")
            .arg(contracts_dir())
            .arg("--test-key")
            .arg(&self.pem)
            .output()
            .unwrap();

        serde_json::from_slice(&out.stdout).unwrap()
    }

    fn state(&self) -> Value {
        self.updater(&["status"])["state"].clone()
    }

    /// Starts the launcher with `cmd /d /c LINE` as the app's arguments; returns its exit code.
    fn launch(&self, line: &str) -> i32 {
        Command::new(env!("CARGO_BIN_EXE_jarod-launcher"))
            .arg("--root")
            .arg(&self.root)
            .arg("--contracts")
            .arg(contracts_dir())
            .arg("--test-key")
            .arg(&self.pem)
            .args(["--", "/d", "/c", line])
            .status()
            .unwrap()
            .code()
            .unwrap()
    }

    fn log(&self) -> String {
        fs::read_to_string(self.root.join("launcher.log")).unwrap_or_default()
    }
}

fn current_version(state: &Value) -> String {
    state["slots"][state["current"].as_str().unwrap()]["version"].as_str().unwrap().to_string()
}

#[test]
fn nothing_installed_starts_nothing() {
    let rig = rig("empty");

    assert_eq!(rig.launch("exit 0"), 3);
    assert!(rig.log().contains("nothing started"), "{}", rig.log());
}

#[test]
fn a_trial_that_exits_with_an_error_is_rolled_back_and_blocked() {
    let rig = rig("crash");

    rig.install("1.0.0");
    assert_eq!(rig.launch("exit 0"), 0, "a validated slot runs");

    rig.install("1.1.0");
    // The trial flag reaches the app: it fails only because it is on trial.
    assert_eq!(rig.launch("if defined JAROD_UPDATER_TRIAL (exit 7) else (exit 0)"), 7);

    let state = rig.state();

    assert_eq!(current_version(&state), "1.0.0");
    assert_eq!(state["blocked"], json!(["1.1.0"]));
    assert_eq!(state["pending"], Value::Null);
    assert!(rig.log().contains("trial failed (exited with code 7 before confirming): back to 1.0.0"), "{}", rig.log());
    assert_eq!(rig.launch("if defined JAROD_UPDATER_TRIAL (exit 7) else (exit 0)"), 0, "back on the old version, not on trial");
}

#[test]
fn a_trial_that_confirms_itself_is_kept_even_if_it_exits_with_an_error_later() {
    let rig = rig("confirm");

    rig.install("1.0.0");
    rig.install("2.0.0");

    // What Jarod-OS does once its core is ready: confirm through the updater the launcher named. Then it crashes on the way out.
    let code = rig.launch("%JAROD_UPDATER_BIN% confirm --root %JAROD_UPDATER_ROOT% --contracts %JAROD_OS_CONTRACTS_DIR% >nul & exit 5");
    let state = rig.state();

    assert_eq!(code, 5);
    assert_eq!(current_version(&state), "2.0.0", "{}", rig.log());
    assert_eq!(state["pending"], Value::Null);
    assert_eq!(state["slots"][state["current"].as_str().unwrap()]["validated"], true);
    assert!(rig.log().contains("nothing to roll back"), "{}", rig.log());
}

#[test]
fn a_trial_that_never_confirms_is_given_up_on_after_its_starts() {
    let rig = rig("loop");

    rig.install("1.0.0");
    rig.install("3.0.0");

    // Clean exits without confirming: each is only a start; the fourth start is the old version.
    for _ in 0..3 {
        assert_eq!(rig.launch("if defined JAROD_UPDATER_TRIAL (exit 0) else (exit 1)"), 0);
    }

    assert_eq!(rig.launch("if defined JAROD_UPDATER_TRIAL (exit 0) else (exit 1)"), 1, "rolled back before the start: not on trial");
    assert_eq!(current_version(&rig.state()), "1.0.0");
    assert_eq!(rig.state()["blocked"], json!(["3.0.0"]));
}

#[test]
fn a_slot_whose_files_were_changed_after_install_does_not_run() {
    let rig = rig("tamper");
    let installed = rig.install("1.0.0");
    let slot = installed["installed"]["slot"].as_str().unwrap();

    fs::write(rig.root.join(format!("slot-{slot}")).join("version.txt"), b"changed").unwrap();

    assert_eq!(rig.launch("exit 0"), 3);
    assert!(rig.log().contains("nothing started"), "{}", rig.log());
}
