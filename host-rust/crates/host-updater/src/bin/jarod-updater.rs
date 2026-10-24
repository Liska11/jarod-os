//! `jarod-updater`: the way the shell (and a person) uses the A/B updater.
//!
//! ```text
//! jarod-updater status   --root DIR
//! jarod-updater verify   --root DIR --bundle DIR
//! jarod-updater install  --root DIR --bundle DIR      stage into the other slot, then activate (a trial when there is a fallback)
//! jarod-updater boot     --root DIR                   what the launcher should run (counts a trial start, may roll back first)
//! jarod-updater confirm  --root DIR                   the running version is healthy
//! jarod-updater rollback --root DIR --reason TEXT     the running version is not healthy: back to the last known good
//! ```
//!
//! Each command prints one JSON line and exits 0 when it did what it says; `{"ok":false,"error":KIND,"detail":…}` with exit 1 when
//! the updater refused (KIND is one of `untrusted`, `invalid`, `tampered`, `downgrade`, `blocked`, `state`, `no-fallback`, `io`,
//! `contracts`); exit 2 for a command line that does not parse.
//!
//! The only trusted key is the one committed for the images (`linux/image/cosign.pub`), compiled in. There is no switch, variable
//! or flag that turns the signature off in a release build. A debug build (tests only) also accepts `--test-key FILE`, a public key
//! made for one test; a release build refuses that option like any unknown one.

use host_control::clock::SystemClock;
use host_control::contracts::Contracts;
use host_updater::{TrustedKeys, UpdateError, Updater, UpdaterConfig};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const COMMITTED_KEY: &str = include_str!("../../../../../linux/image/cosign.pub");

fn usage(why: &str) -> ! {
    println!("{}", json!({ "ok": false, "error": "usage", "detail": why }));
    std::process::exit(2);
}

fn refused(kind: &str, detail: impl Into<String>) -> ! {
    println!("{}", json!({ "ok": false, "error": kind, "detail": detail.into() }));
    std::process::exit(1);
}

fn kind(error: &UpdateError) -> &'static str {
    match error {
        UpdateError::Untrusted(_) => "untrusted",
        UpdateError::Invalid(_) => "invalid",
        UpdateError::Tampered(_) => "tampered",
        UpdateError::Downgrade { .. } => "downgrade",
        UpdateError::Blocked(_) => "blocked",
        UpdateError::State(_) => "state",
        UpdateError::NoFallback(_) => "no-fallback",
        UpdateError::Io(_) => "io",
    }
}

fn or_refuse<T>(result: Result<T, UpdateError>) -> T {
    result.unwrap_or_else(|error| refused(kind(&error), error.to_string()))
}

struct Args {
    root: Option<PathBuf>,
    bundle: Option<PathBuf>,
    reason: Option<String>,
    contracts: Option<PathBuf>,
    test_key: Option<PathBuf>,
}

fn parse(rest: &[String]) -> Args {
    let mut args = Args { root: None, bundle: None, reason: None, contracts: None, test_key: None };
    let mut items = rest.iter();

    while let Some(flag) = items.next() {
        let mut value = || items.next().cloned().unwrap_or_else(|| usage(&format!("{flag} needs a value")));

        match flag.as_str() {
            "--root" => args.root = Some(PathBuf::from(value())),
            "--bundle" => args.bundle = Some(PathBuf::from(value())),
            "--reason" => args.reason = Some(value()),
            "--contracts" => args.contracts = Some(PathBuf::from(value())),
            "--test-key" if cfg!(debug_assertions) => args.test_key = Some(PathBuf::from(value())),
            other => usage(&format!("unknown option {other}")),
        }
    }

    args
}

fn open(args: &Args) -> Updater {
    let root = args.root.clone().unwrap_or_else(|| usage("--root is required"));
    let contracts = match &args.contracts {
        Some(dir) => Contracts::load(dir),
        None => Contracts::load_from_env(),
    }
    .unwrap_or_else(|error| refused("contracts", error.to_string()));
    let test_key = args.test_key.as_ref().map(|file| std::fs::read_to_string(file).unwrap_or_else(|error| usage(&format!("--test-key: {error}"))));
    let pems: Vec<&str> = match &test_key {
        Some(pem) => vec![pem.as_str()],
        None => vec![COMMITTED_KEY],
    };
    let keys = or_refuse(TrustedKeys::from_pem(&pems));

    or_refuse(Updater::open(root, keys, Arc::new(contracts), Arc::new(SystemClock), UpdaterConfig::default()))
}

fn bundle(args: &Args) -> &Path {
    args.bundle.as_deref().unwrap_or_else(|| usage("--bundle is required"))
}

fn status(updater: &Updater) -> Value {
    let state = or_refuse(updater.snapshot());

    json!({ "ok": true, "state": state })
}

fn main() {
    let all: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = all.first() else { usage("a command is required: status, verify, install, boot, confirm or rollback") };
    let args = parse(&all[1..]);

    let out = match command.as_str() {
        "status" => status(&open(&args)),
        "verify" => {
            let updater = open(&args);
            let manifest = or_refuse(updater.verify_bundle(bundle(&args)));

            json!({ "ok": true, "version": manifest.version.to_string(), "entry": manifest.entry, "files": manifest.files.len() })
        }
        "install" => {
            let updater = open(&args);
            let staged = or_refuse(updater.stage(bundle(&args)));

            or_refuse(updater.activate(&staged));

            let mut out = status(&updater);

            out["installed"] = json!({ "slot": staged.slot, "version": staged.version.to_string() });
            out
        }
        "boot" => {
            let updater = open(&args);
            let plan = or_refuse(updater.begin_boot());

            json!({ "ok": true, "slot": plan.slot, "version": plan.version, "entry": plan.entry, "trial": plan.trial })
        }
        "confirm" => {
            let updater = open(&args);

            or_refuse(updater.confirm_healthy());
            status(&updater)
        }
        "rollback" => {
            let reason = args.reason.clone().unwrap_or_else(|| usage("--reason is required"));
            let updater = open(&args);
            let restored = or_refuse(updater.report_failure(&reason));
            let mut out = status(&updater);

            out["restored"] = json!(restored);
            out
        }
        other => usage(&format!("unknown command {other}")),
    };

    println!("{out}");
}
