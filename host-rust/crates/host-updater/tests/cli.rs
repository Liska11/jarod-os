//! `jarod-updater`, the binary the shell calls, end to end: real process, real directories, real signatures (a key generated in
//! memory for each test; only its public half is written, for `--test-key`, which a release build does not accept).

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

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("jarod-updater-cli-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

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

fn bundle(base: &Path, signer: &SigningKey, version: &str) -> PathBuf {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let dir = base.join(format!("bundle-{version}"));
    let files = [("bin/jarod-os.exe", format!("host {version}").into_bytes()), ("resources/gateway.mjs", format!("kernel {version}").into_bytes())];

    for (path, bytes) in &files {
        let target = dir.join(path);

        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }

    let manifest = serde_json::to_vec(&json!({
        "schema": 1,
        "product": "jarod-os",
        "version": version,
        "channel": "stable",
        "createdAt": "2026-10-24T12:00:00Z",
        "entry": "bin/jarod-os.exe",
        "files": files.iter().map(|(path, bytes)| json!({ "path": path, "sha256": sha(bytes), "size": bytes.len() })).collect::<Vec<_>>(),
    }))
    .unwrap();
    let signature: Signature = signer.sign(&manifest);

    fs::write(dir.join("manifest.json"), &manifest).unwrap();
    fs::write(dir.join("manifest.sig"), STANDARD.encode(signature.to_der().as_bytes())).unwrap();

    dir
}

struct Rig {
    base: PathBuf,
    root: PathBuf,
    pem: PathBuf,
    signer: SigningKey,
}

fn rig(name: &str) -> Rig {
    let base = scratch(name);
    let signer = key();
    let pem = base.join("test.pub");

    fs::write(&pem, signer.verifying_key().to_public_key_pem(LineEnding::LF).unwrap()).unwrap();

    Rig { root: base.join("updates"), base, pem, signer }
}

impl Rig {
    fn run(&self, args: &[&str]) -> (i32, Value) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_jarod-updater"));

        command.args(args).arg("--root").arg(&self.root).arg("--contracts").arg(contracts_dir()).arg("--test-key").arg(&self.pem);

        let out = command.output().unwrap();
        let line = String::from_utf8_lossy(&out.stdout);

        (out.status.code().unwrap_or(-1), serde_json::from_str(line.trim()).unwrap_or_else(|_| panic!("not one JSON line: {line:?}")))
    }

    fn install(&self, version: &str) -> (i32, Value) {
        let dir = bundle(&self.base, &self.signer, version);

        self.run(&["install", "--bundle", dir.to_str().unwrap()])
    }
}

#[test]
fn first_install_then_a_trial_confirmed() {
    let rig = rig("confirm");
    let (code, out) = rig.run(&["status"]);

    assert_eq!(code, 0);
    assert_eq!(out["state"]["current"], Value::Null);

    let (code, out) = rig.install("1.0.0");

    assert_eq!(code, 0, "{out}");
    assert_eq!(out["installed"]["version"], "1.0.0");
    assert_eq!(out["state"]["pending"], Value::Null, "a first install has nothing to fall back to, so no trial");

    let (code, out) = rig.install("1.1.0");

    assert_eq!(code, 0, "{out}");
    assert_eq!(out["state"]["pending"]["slot"], out["installed"]["slot"]);

    let (code, plan) = rig.run(&["boot"]);

    assert_eq!(code, 0, "{plan}");
    assert_eq!(plan["version"], "1.1.0");
    assert_eq!(plan["trial"], true);
    assert!(plan["entry"].as_str().unwrap().ends_with("jarod-os.exe"));

    let (code, out) = rig.run(&["confirm"]);

    assert_eq!(code, 0, "{out}");
    assert_eq!(out["state"]["pending"], Value::Null);
    assert_eq!(out["state"]["slots"][out["state"]["current"].as_str().unwrap()]["validated"], true);
}

#[test]
fn a_failed_trial_rolls_back_and_blocks_the_version() {
    let rig = rig("rollback");

    assert_eq!(rig.install("1.0.0").0, 0);
    assert_eq!(rig.run(&["confirm"]).0, 0);
    assert_eq!(rig.install("2.0.0").0, 0);

    let (code, out) = rig.run(&["rollback", "--reason", "the window never opened"]);

    assert_eq!(code, 0, "{out}");
    assert_eq!(out["restored"], "1.0.0");
    assert_eq!(out["state"]["blocked"], json!(["2.0.0"]));

    let (code, out) = rig.install("2.0.0");

    assert_eq!((code, out["error"].as_str()), (1, Some("blocked")));
}

#[test]
fn nothing_unsigned_or_tampered_or_older_installs() {
    let rig = rig("refuse");
    let stranger = key();
    let foreign = bundle(&rig.base.join("foreign"), &stranger, "1.0.0");
    let (code, out) = rig.run(&["install", "--bundle", foreign.to_str().unwrap()]);

    assert_eq!((code, out["error"].as_str()), (1, Some("untrusted")), "{out}");

    let edited = bundle(&rig.base.join("edited"), &rig.signer, "1.0.0");

    fs::write(edited.join("bin/jarod-os.exe"), b"not what was signed").unwrap();

    let (code, out) = rig.run(&["verify", "--bundle", edited.to_str().unwrap()]);

    assert_eq!((code, out["error"].as_str()), (1, Some("tampered")), "{out}");
    assert_eq!(rig.run(&["status"]).1["state"]["current"], Value::Null, "nothing was installed");
    assert_eq!(rig.install("1.0.0").0, 0);

    let (code, out) = rig.install("0.9.0");

    assert_eq!((code, out["error"].as_str()), (1, Some("downgrade")), "{out}");
}

#[test]
fn without_a_test_key_only_the_committed_key_is_trusted() {
    let rig = rig("committed");
    let dir = bundle(&rig.base, &rig.signer, "1.0.0");
    let out = Command::new(env!("CARGO_BIN_EXE_jarod-updater"))
        .args(["verify", "--bundle", dir.to_str().unwrap(), "--root", rig.root.to_str().unwrap(), "--contracts", contracts_dir().to_str().unwrap()])
        .output()
        .unwrap();
    let reply: Value = serde_json::from_slice(&out.stdout).unwrap();

    assert_eq!((out.status.code(), reply["error"].as_str()), (Some(1), Some("untrusted")), "{reply}");
}

#[test]
fn a_bad_command_line_is_a_usage_error() {
    let rig = rig("usage");
    let (code, out) = rig.run(&["fly"]);

    assert_eq!((code, out["error"].as_str()), (2, Some("usage")));

    let (code, out) = rig.run(&["install"]);

    assert_eq!((code, out["error"].as_str()), (2, Some("usage")));
}
