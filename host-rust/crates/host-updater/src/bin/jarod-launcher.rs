//! `jarod-launcher`: the small, stable program that starts Jarod-OS from the slot the updater chose (V-21).
//!
//! ```text
//! <install>\jarod-launcher.exe     this program; never replaced by an update
//! <install>\jarod-updater.exe      the updater's command line (the app calls it to confirm a trial)
//! <install>\contracts\v1\          the contracts the manifests are checked against
//! %LOCALAPPDATA%\Jarod-OS\updates\  the updater's root (slot-a, slot-b, state.json); --root moves it
//!
//! jarod-launcher [--root DIR] [--contracts DIR] [--test-key FILE] [-- ARGS FOR THE APP]
//! ```
//!
//! One start: `begin_boot` (which rolls an expired or crash-looping trial back BEFORE anything runs, and refuses a slot whose files
//! no longer verify), then the slot's entry runs with `JAROD_UPDATER_ROOT`, `JAROD_UPDATER_BIN`, `JAROD_OS_CONTRACTS_DIR`,
//! `JAROD_HOST_UPDATER=1` and, during a trial, `JAROD_UPDATER_TRIAL=1`. The app confirms its own health (electron/main.ts calls
//! `jarod-updater confirm` once its core is ready). When a trial version exits with an error before it confirmed, it is reported as
//! failed here, which restores the last known good and blocks it. A clean exit before confirming is only a start: the deadline and
//! the start count of the updater decide. The launcher exits with the app's exit code; what it did goes to `<root>\launcher.log`.
//!
//! `--test-key` exists in a debug build only, as for `jarod-updater`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use host_control::clock::{Clock, SystemClock};
use host_control::contracts::Contracts;
use host_updater::{TrustedKeys, UpdateError, Updater, UpdaterConfig};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

const COMMITTED_KEY: &str = include_str!("../../../../../linux/image/cosign.pub");
const UPDATER: &str = if cfg!(windows) { "jarod-updater.exe" } else { "jarod-updater" };

struct Launch {
    root: PathBuf,
    contracts: Option<PathBuf>,
    test_key: Option<String>,
    app_args: Vec<String>,
    home: PathBuf,
}

fn note(root: &Path, line: &str) {
    eprintln!("jarod-launcher: {line}");

    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(root.join("launcher.log")) {
        let _ = writeln!(file, "{} {line}", SystemClock.now_iso());
    }
}

fn parse() -> Result<Launch, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let home = exe.parent().map(Path::to_path_buf).ok_or("the launcher has no folder")?;
    // The slots weigh as much as the app twice: they go to the machine's local data (never roamed), not beside a launcher that may sit in a
    // folder the person cannot write to.
    let root = std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("Jarod-OS").join("updates")).unwrap_or_else(|| home.join("updates"));
    let mut launch = Launch { root, contracts: None, test_key: None, app_args: Vec::new(), home: home.clone() };
    let mut items = std::env::args().skip(1);

    while let Some(flag) = items.next() {
        let mut value = || items.next().ok_or(format!("{flag} needs a value"));

        match flag.as_str() {
            "--root" => launch.root = PathBuf::from(value()?),
            "--contracts" => launch.contracts = Some(PathBuf::from(value()?)),
            "--test-key" if cfg!(debug_assertions) => launch.test_key = Some(std::fs::read_to_string(value()?).map_err(|error| format!("--test-key: {error}"))?),
            "--" => {
                launch.app_args = items.collect();
                break;
            }
            other => return Err(format!("unknown option {other}")),
        }
    }

    if launch.contracts.is_none() && std::env::var_os("JAROD_OS_CONTRACTS_DIR").is_none() {
        let shipped = home.join("contracts").join("v1");

        if shipped.join("index.json").is_file() {
            launch.contracts = Some(shipped);
        }
    }

    Ok(launch)
}

fn open(launch: &Launch) -> Result<Updater, UpdateError> {
    let contracts = match &launch.contracts {
        Some(dir) => Contracts::load(dir),
        None => Contracts::load_from_env(),
    }
    .map_err(|error| UpdateError::State(format!("contracts: {error}")))?;
    let pem = launch.test_key.as_deref().unwrap_or(COMMITTED_KEY);

    Updater::open(&launch.root, TrustedKeys::from_pem(&[pem])?, Arc::new(contracts), Arc::new(SystemClock), UpdaterConfig::default())
}

fn main() {
    let launch = match parse() {
        Ok(launch) => launch,
        Err(why) => {
            eprintln!("jarod-launcher: {why}");
            std::process::exit(2);
        }
    };

    let _ = std::fs::create_dir_all(&launch.root);

    let plan = match open(&launch).and_then(|updater| updater.begin_boot()) {
        Ok(plan) => plan,
        Err(error) => {
            note(&launch.root, &format!("nothing started: {error}"));
            std::process::exit(3);
        }
    };

    note(&launch.root, &format!("starting {} from slot {} ({})", plan.version, plan.slot.name(), if plan.trial { "on trial" } else { "not on trial" }));

    let mut command = Command::new(&plan.entry);

    command
        .args(&launch.app_args)
        .current_dir(&plan.dir)
        .env("JAROD_HOST_UPDATER", "1")
        .env("JAROD_UPDATER_ROOT", &launch.root)
        .env("JAROD_UPDATER_BIN", launch.home.join(UPDATER))
        .env("JAROD_UPDATER_SLOT", plan.slot.name())
        .env("JAROD_UPDATER_VERSION", &plan.version);

    if let Some(contracts) = &launch.contracts {
        command.env("JAROD_OS_CONTRACTS_DIR", contracts);
    }

    if plan.trial {
        command.env("JAROD_UPDATER_TRIAL", "1");
    } else {
        command.env_remove("JAROD_UPDATER_TRIAL");
    }

    let status = match command.status() {
        Ok(status) => status,
        Err(error) => {
            note(&launch.root, &format!("{} did not start: {error}", plan.entry.display()));

            if plan.trial {
                fail_trial(&launch, plan.slot, &format!("the program did not start: {error}"));
            }

            std::process::exit(4);
        }
    };
    let code = status.code().unwrap_or(1);

    note(&launch.root, &format!("{} exited with code {code}", plan.version));

    if plan.trial && code != 0 {
        fail_trial(&launch, plan.slot, &format!("exited with code {code} before confirming"));
    }

    std::process::exit(code);
}

/// The trial version failed — unless it confirmed meanwhile: the app writes `state.json` through `jarod-updater` while it runs, so the
/// state is read again here rather than trusted from before the start.
fn fail_trial(launch: &Launch, slot: host_updater::Slot, reason: &str) {
    match open(launch) {
        Ok(updater) => match updater.snapshot() {
            Ok(state) if state.pending.as_ref().map(|trial| trial.slot) == Some(slot) => match updater.report_failure(reason) {
                Ok(restored) => note(&launch.root, &format!("trial failed ({reason}): back to {restored}")),
                Err(error) => note(&launch.root, &format!("trial failed ({reason}) and the rollback was refused: {error}")),
            },
            Ok(_) => note(&launch.root, &format!("exit after the trial was closed ({reason}): nothing to roll back")),
            Err(error) => note(&launch.root, &format!("state unreadable after the exit: {error}")),
        },
        Err(error) => note(&launch.root, &format!("updater unavailable after the exit: {error}")),
    }
}
