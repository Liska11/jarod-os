//! Stage, activate, boot, confirm, roll back.
//!
//! The running version is never touched while an update is being prepared: the bundle is verified, copied
//! into the **other** slot (hash by hash, as it is copied), and only then does one atomic write of
//! `state.json` point the host at it, as a *trial*. The trial ends one of three ways: the new version says
//! it is healthy (it is validated, the old one stays as the previous version), it says it is not, or it is
//! given up on (it never confirmed within its deadline, or it was started too many times without confirming
//! — the power-cut and crash-loop cases). Every way that is not "healthy" restores the last known good and
//! blocks the failed version from being installed again.

use crate::error::UpdateError;
use crate::manifest::{MAX_MANIFEST_BYTES, Manifest, Version};
use crate::state::{Slot, SlotRecord, State, Trial};
use crate::trust::TrustedKeys;
use host_control::clock::Clock;
use host_control::contracts::Contracts;
use host_storage::path::{create_dir_checked, ensure_inside, is_reparse};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const STATE_FILE: &str = "state.json";
const STAGING: &str = "staging";
const MANIFEST: &str = "manifest.json";
const SIGNATURE: &str = "manifest.sig";
const MAX_SIGNATURE_FILE: u64 = 4096;

#[derive(Clone, Debug)]
pub struct UpdaterConfig {
    /// How long a newly activated version has to confirm it is healthy.
    pub health_deadline_ms: u64,
    /// How many times a trial version may be started without confirming before it is given up on.
    pub max_trial_boots: u32,
    /// The most an update may weigh, in bytes.
    pub max_bundle_bytes: u64,
    /// Re-check a slot's signature and every file hash each time it is booted.
    pub verify_on_boot: bool,
}

impl Default for UpdaterConfig {
    fn default() -> Self {
        UpdaterConfig { health_deadline_ms: 5 * 60_000, max_trial_boots: 3, max_bundle_bytes: 8 * 1024 * 1024 * 1024, verify_on_boot: true }
    }
}

/// An update that has been verified and copied into its slot, not yet activated.
#[derive(Clone, Debug)]
pub struct StagedUpdate {
    pub slot: Slot,
    pub version: Version,
}

/// What the launcher should run.
#[derive(Clone, Debug)]
pub struct BootPlan {
    pub slot: Slot,
    pub dir: PathBuf,
    pub version: String,
    /// The program, inside `dir`.
    pub entry: PathBuf,
    /// A trial: the launcher must run the health check and call `confirm_healthy` or `report_failure`.
    pub trial: bool,
}

pub struct Updater {
    root: PathBuf,
    keys: TrustedKeys,
    contracts: Arc<Contracts>,
    clock: Arc<dyn Clock>,
    config: UpdaterConfig,
    state: Mutex<State>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The bytes of a file the bundle supplies, refusing a link and a file that is not what it should be.
fn read_small(path: &Path, limit: u64, what: &str) -> Result<Vec<u8>, UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| UpdateError::Invalid(format!("the bundle has no {what}")))?;

    if is_reparse(&metadata) || !metadata.is_file() {
        return Err(UpdateError::Invalid(format!("the bundle's {what} is a link or not a file")));
    }

    if metadata.len() > limit {
        return Err(UpdateError::Invalid(format!("the bundle's {what} is larger than {limit} bytes")));
    }

    Ok(fs::read(path)?)
}

/// Every file of the bundle, relative, forward slashes; a link anywhere is an error.
fn bundle_files(bundle: &Path) -> Result<Vec<String>, UpdateError> {
    let mut out = Vec::new();
    let mut stack = vec![bundle.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for item in fs::read_dir(&dir)? {
            let path = item?.path();
            let metadata = fs::symlink_metadata(&path)?;

            if is_reparse(&metadata) {
                return Err(UpdateError::Tampered(format!("{} is a link inside the bundle", path.display())));
            }

            if metadata.is_dir() {
                stack.push(path);
            } else {
                out.push(path.strip_prefix(bundle).map_err(|_| UpdateError::Io("a path outside the bundle".into()))?.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    Ok(out)
}

impl Updater {
    /// Opens (creating on first use) the updater at `root`. A `state.json` that does not read back as a
    /// consistent state, or a root that is a link, stops here; a half-finished staging directory from a crash
    /// is removed.
    pub fn open(root: impl Into<PathBuf>, keys: TrustedKeys, contracts: Arc<Contracts>, clock: Arc<dyn Clock>, config: UpdaterConfig) -> Result<Updater, UpdateError> {
        let root = root.into();

        fs::create_dir_all(&root)?;

        let metadata = fs::symlink_metadata(&root)?;

        if is_reparse(&metadata) || !metadata.is_dir() {
            return Err(UpdateError::State(format!("{} is a link or not a directory", root.display())));
        }

        if keys.is_empty() {
            return Err(UpdateError::Untrusted("no trusted key".into()));
        }

        let root = fs::canonicalize(&root)?;
        let state = match fs::read_to_string(root.join(STATE_FILE)) {
            Ok(text) => {
                let state: State = serde_json::from_str(&text).map_err(|error| UpdateError::State(format!("state.json does not read: {error}")))?;

                state.check()?;

                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(error) => return Err(UpdateError::State(format!("state.json cannot be read: {error}"))),
        };

        // A crash during a copy leaves a staging directory and possibly a state-file sibling: neither is ever used.
        let _ = fs::remove_dir_all(root.join(STAGING));
        let _ = fs::remove_file(root.join(format!("{STATE_FILE}.tmp")));

        Ok(Updater { root, keys, contracts, clock, config, state: Mutex::new(state) })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, UpdateError> {
        self.state.lock().map_err(|_| UpdateError::State("the updater lock is poisoned".into()))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn slot_dir(&self, slot: Slot) -> PathBuf {
        self.root.join(slot.dir_name())
    }

    fn persist(&self, state: &State) -> Result<(), UpdateError> {
        let text = serde_json::to_string_pretty(state).map_err(|error| UpdateError::State(error.to_string()))?;
        let temporary = self.root.join(format!("{STATE_FILE}.tmp"));

        {
            let mut file = File::create(&temporary)?;

            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }

        fs::rename(&temporary, self.root.join(STATE_FILE))?;

        Ok(())
    }

    /// A copy of the current state, for the person and for tests.
    pub fn snapshot(&self) -> Result<State, UpdateError> {
        Ok(self.lock()?.clone())
    }

    /// The signature, the schema, the version and the file set; every hash and size. Nothing is installed.
    pub fn verify_bundle(&self, bundle: &Path) -> Result<Manifest, UpdateError> {
        let manifest_bytes = read_small(&bundle.join(MANIFEST), MAX_MANIFEST_BYTES as u64, "manifest.json")?;
        let signature = read_small(&bundle.join(SIGNATURE), MAX_SIGNATURE_FILE, "manifest.sig")?;

        // First: is this what a trusted party signed? Nothing in the manifest is read before that is true.
        self.keys.verify(&manifest_bytes, &String::from_utf8_lossy(&signature))?;

        let manifest = Manifest::parse(&self.contracts, &manifest_bytes, self.config.max_bundle_bytes)?;
        let listed: HashSet<&str> = manifest.files.iter().map(|file| file.path.as_str()).collect();

        // The bundle holds exactly what was signed: nothing missing, nothing extra, no link.
        for present in bundle_files(bundle)? {
            if present != MANIFEST && present != SIGNATURE && !listed.contains(present.as_str()) {
                return Err(UpdateError::Tampered(format!("{present:?} is in the bundle and not in the signed manifest")));
            }
        }

        for file in &manifest.files {
            let path = bundle.join(&file.path);
            let metadata = fs::symlink_metadata(&path).map_err(|_| UpdateError::Tampered(format!("{:?} is listed and missing", file.path)))?;

            if is_reparse(&metadata) || !metadata.is_file() {
                return Err(UpdateError::Tampered(format!("{:?} is a link or not a file", file.path)));
            }

            if metadata.len() != file.size {
                return Err(UpdateError::Tampered(format!("{:?} is {} bytes, the manifest says {}", file.path, metadata.len(), file.size)));
            }

            if sha256_file(&path)? != file.sha256 {
                return Err(UpdateError::Tampered(format!("{:?} does not match its hash", file.path)));
            }
        }

        Ok(manifest)
    }

    /// Verifies `bundle` and copies it into the slot that is not running. The running version is untouched.
    pub fn stage(&self, bundle: &Path) -> Result<StagedUpdate, UpdateError> {
        let mut state = self.lock()?;

        if state.pending.is_some() {
            return Err(UpdateError::State("an update is on trial; it must be confirmed or rolled back before another is staged".into()));
        }

        let manifest = self.verify_bundle(bundle)?;
        let installed = state.current.and_then(|slot| state.record(slot)).map(|record| record.version.clone());

        if state.blocked.iter().any(|version| *version == manifest.version.to_string()) {
            return Err(UpdateError::Blocked(manifest.version.to_string()));
        }

        if let Some(installed) = &installed
            && Version::parse(installed).is_some_and(|current| manifest.version <= current)
        {
            return Err(UpdateError::Downgrade { installed: installed.clone(), offered: manifest.version.to_string() });
        }

        let target = state.current.map(Slot::other).unwrap_or(Slot::A);
        let staging = self.root.join(STAGING);

        let _ = fs::remove_dir_all(&staging);
        fs::create_dir(&staging)?;

        let copied = (|| -> Result<(), UpdateError> {
            for file in &manifest.files {
                let parts: Vec<&str> = file.path.split('/').collect();
                let (name, parents) = parts.split_last().ok_or_else(|| UpdateError::Invalid("an empty path".into()))?;
                let directory = create_dir_checked(&staging, parents).map_err(|error| UpdateError::Invalid(error.to_string()))?;
                let destination = directory.join(name);

                // Copied and hashed in one pass, so what lands is what was measured, not what was there a moment ago.
                let mut source = File::open(bundle.join(&file.path))?;
                let mut target_file = File::create(&destination)?;
                let mut hasher = Sha256::new();
                let mut buffer = vec![0u8; 1 << 20];
                let mut written = 0u64;

                loop {
                    let read = source.read(&mut buffer)?;

                    if read == 0 {
                        break;
                    }

                    hasher.update(&buffer[..read]);
                    target_file.write_all(&buffer[..read])?;
                    written += read as u64;
                }

                target_file.sync_all()?;

                if written != file.size || hex(&hasher.finalize()) != file.sha256 {
                    return Err(UpdateError::Tampered(format!("{:?} changed while it was being copied", file.path)));
                }
            }

            fs::copy(bundle.join(MANIFEST), staging.join(MANIFEST))?;
            fs::copy(bundle.join(SIGNATURE), staging.join(SIGNATURE))?;

            Ok(())
        })();

        if let Err(error) = copied {
            let _ = fs::remove_dir_all(&staging);

            return Err(error);
        }

        // The inactive slot is replaced as a whole: its old content is the version before the last good one.
        let slot_dir = self.slot_dir(target);

        if slot_dir.exists() {
            fs::remove_dir_all(&slot_dir)?;
        }

        fs::rename(&staging, &slot_dir)?;

        // Staging replaces whatever the inactive slot held. If that was the previous version, it is gone: it is
        // no longer a fallback, and must not be mistaken for one if the host restarts before this is activated.
        if state.previous == Some(target) {
            state.previous = None;
        }

        state.slots.remove(target.name());
        state.slots.insert(target.name().into(), SlotRecord { version: manifest.version.to_string(), validated: false });

        let now = self.clock.now_ms();

        state.push_history(now, "staged", &manifest.version.to_string(), &format!("slot {}", target.name()));
        self.persist(&state)?;

        Ok(StagedUpdate { slot: target, version: manifest.version })
    }

    /// Points the host at the staged slot, as a trial when there is a last known good to fall back to.
    pub fn activate(&self, staged: &StagedUpdate) -> Result<(), UpdateError> {
        let mut state = self.lock()?;

        if state.pending.is_some() {
            return Err(UpdateError::State("an update is already on trial".into()));
        }

        if state.record(staged.slot).map(|record| record.version.as_str()) != Some(staged.version.to_string().as_str()) {
            return Err(UpdateError::State("the staged slot no longer holds that version".into()));
        }

        if state.current == Some(staged.slot) {
            return Err(UpdateError::State("the staged slot is the one already running".into()));
        }

        let now = self.clock.now_ms();
        let fallback = state.current;

        state.previous = fallback;
        state.current = Some(staged.slot);
        state.pending = fallback.map(|_| Trial { slot: staged.slot, activated_ms: now, boots: 0 });
        state.push_history(now, "activated", &staged.version.to_string(), if fallback.is_some() { "on trial" } else { "first install, no trial: nothing to fall back to" });
        self.persist(&state)?;
        self.mark_current(state.current, state.previous);

        Ok(())
    }

    /// The launcher asks what to run. During a trial this counts the start; a trial that has run out of time or
    /// of starts is rolled back here, before anything is run. A slot that no longer verifies is not run.
    pub fn begin_boot(&self) -> Result<BootPlan, UpdateError> {
        let mut state = self.lock()?;
        let now = self.clock.now_ms();

        if let Some(trial) = state.pending.clone() {
            let expired = now.saturating_sub(trial.activated_ms) > self.config.health_deadline_ms;
            let exhausted = trial.boots >= self.config.max_trial_boots;

            if expired || exhausted {
                let why = if exhausted { format!("started {} times without confirming", trial.boots) } else { "no confirmation within the health deadline".to_string() };

                self.roll_back_locked(&mut state, &why)?;
            }
        }

        let slot = state.current.ok_or_else(|| UpdateError::NoFallback("nothing is installed".into()))?;

        if self.config.verify_on_boot
            && let Err(error) = self.verify_slot(slot)
        {
            // The files on disk are not what was signed: that version does not run.
            if state.pending.is_some() || state.previous.is_some() {
                self.roll_back_locked(&mut state, &format!("integrity check failed: {error}"))?;
            } else {
                return Err(UpdateError::NoFallback(format!("{error}; and there is no previous version")));
            }
        }

        let slot = state.current.ok_or_else(|| UpdateError::NoFallback("nothing is installed".into()))?;
        let trial = state.pending.is_some();

        if let Some(open) = state.pending.as_mut() {
            open.boots += 1;
        }

        self.persist(&state)?;

        let record = state.record(slot).cloned().ok_or_else(|| UpdateError::State("the current slot has no record".into()))?;
        let dir = self.slot_dir(slot);
        let manifest = Manifest::parse(&self.contracts, &fs::read(dir.join(MANIFEST))?, self.config.max_bundle_bytes)?;

        Ok(BootPlan { slot, entry: dir.join(manifest.entry.replace('/', "\\")), dir, version: record.version, trial })
    }

    /// The running version says it is healthy.
    pub fn confirm_healthy(&self) -> Result<(), UpdateError> {
        let mut state = self.lock()?;
        let slot = state.current.ok_or_else(|| UpdateError::NoFallback("nothing is installed".into()))?;
        let now = self.clock.now_ms();

        if let Some(record) = state.slots.get_mut(slot.name()) {
            record.validated = true;
        }

        let version = state.record(slot).map(|r| r.version.clone()).unwrap_or_default();

        state.pending = None;
        state.push_history(now, "confirmed", &version, "healthy");
        self.persist(&state)?;
        let _ = fs::write(self.slot_dir(slot).join(".validated"), b"1");
        self.mark_current(state.current, state.previous);

        Ok(())
    }

    /// The running version says it is not healthy. Returns the version that is running afterwards.
    pub fn report_failure(&self, reason: &str) -> Result<String, UpdateError> {
        let mut state = self.lock()?;

        self.roll_back_locked(&mut state, reason)
    }

    /// Lets a blocked version be installed again, on the person's say-so.
    pub fn unblock(&self, version: &str) -> Result<bool, UpdateError> {
        let mut state = self.lock()?;
        let before = state.blocked.len();

        state.blocked.retain(|blocked| blocked != version);

        let changed = state.blocked.len() != before;

        if changed {
            self.persist(&state)?;
        }

        Ok(changed)
    }

    /// Restores the previous slot (it must verify), blocks the version that failed, and records why.
    fn roll_back_locked(&self, state: &mut State, reason: &str) -> Result<String, UpdateError> {
        let failing = state.current.ok_or_else(|| UpdateError::NoFallback("nothing is installed".into()))?;
        let fallback = state.previous.ok_or_else(|| UpdateError::NoFallback(format!("{reason}; and there is no previous version to return to")))?;

        // The last known good must itself still be good: a rollback to something broken is not a rollback.
        self.verify_slot(fallback).map_err(|error| UpdateError::NoFallback(format!("{reason}; and the previous version no longer verifies: {error}")))?;

        let now = self.clock.now_ms();
        let failed_version = state.record(failing).map(|r| r.version.clone()).unwrap_or_default();
        let restored_version = state.record(fallback).map(|r| r.version.clone()).unwrap_or_default();

        if !state.blocked.contains(&failed_version) && !failed_version.is_empty() {
            state.blocked.push(failed_version.clone());
        }

        state.current = Some(fallback);
        state.previous = None;
        state.pending = None;
        state.push_history(now, "rolled-back", &failed_version, &format!("{reason}; back to {restored_version}"));
        self.persist(state)?;
        self.mark_current(state.current, state.previous);

        Ok(restored_version)
    }

    /// Signature and every hash of an installed slot, against the manifest it carries.
    pub fn verify_slot(&self, slot: Slot) -> Result<(), UpdateError> {
        let dir = self.slot_dir(slot);

        ensure_inside(&self.root, &dir).map_err(|error| UpdateError::Tampered(error.to_string()))?;

        let manifest_bytes = read_small(&dir.join(MANIFEST), MAX_MANIFEST_BYTES as u64, "manifest.json")?;
        let signature = read_small(&dir.join(SIGNATURE), MAX_SIGNATURE_FILE, "manifest.sig")?;

        self.keys.verify(&manifest_bytes, &String::from_utf8_lossy(&signature))?;

        let manifest = Manifest::parse(&self.contracts, &manifest_bytes, self.config.max_bundle_bytes)?;

        for file in &manifest.files {
            let path = dir.join(&file.path);
            let metadata = fs::symlink_metadata(&path).map_err(|_| UpdateError::Tampered(format!("{:?} is missing from the installed slot", file.path)))?;

            if is_reparse(&metadata) || !metadata.is_file() || metadata.len() != file.size || sha256_file(&path)? != file.sha256 {
                return Err(UpdateError::Tampered(format!("{:?} is not what was installed", file.path)));
            }
        }

        Ok(())
    }

    /// `.current` on the running slot and none elsewhere; the purge of the storage zone reads these markers.
    fn mark_current(&self, current: Option<Slot>, _previous: Option<Slot>) {
        for slot in [Slot::A, Slot::B] {
            let marker = self.slot_dir(slot).join(".current");

            if Some(slot) == current {
                let _ = fs::write(&marker, b"1");
            } else {
                let _ = fs::remove_file(&marker);
            }
        }
    }
}

fn sha256_file(path: &Path) -> Result<String, UpdateError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];

    loop {
        let read = file.read(&mut buffer)?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Ok(hex(&hasher.finalize()))
}
