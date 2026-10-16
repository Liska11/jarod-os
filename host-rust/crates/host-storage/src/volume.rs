//! The storage volume: reservations in, leases out, nothing else.
//!
//! A plugin is never handed the volume. It names itself, a zone, a size and a purpose
//! (`c9-storage-reservation`), the host checks the zone's quota and the space it keeps for itself, and
//! answers with a lease (`c9-storage-lease`): `<root>/<zone>/<plugin>/<lease id>`, created one
//! directory at a time with no link on the way. The lease ends when it is released (the content stays,
//! counted against the zone), discarded (the content goes), or expires (the content becomes eligible
//! for the purge). State is a single JSON file under `<root>/.host`, written atomically; a state the
//! host cannot read is a volume it refuses to open.

use crate::error::StorageError;
use crate::path::{create_dir_checked, ensure_inside, is_reparse};
use crate::purge::{PurgePolicy, PurgeReport};
use crate::space::SpaceProbe;
use crate::zone::{RESERVABLE, Zone};
use host_control::clock::{Clock, iso8601};
use host_control::contracts::Contracts;
use host_control::secrets::random_hex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub const STATE_VERSION: u32 = 1;
pub const HOST_DIR: &str = ".host";
const STATE_FILE: &str = "state.json";
pub const RESERVATION_CONTRACT: &str = "c9-storage-reservation";
pub const LEASE_CONTRACT: &str = "c9-storage-lease";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservationRequest {
    pub plugin: String,
    pub zone: Zone,
    pub requested_bytes: u64,
    pub purpose: String,
}

/// `^[a-z]([a-z0-9._-]{0,62}[a-z0-9_-])?$`, the plugin id of the contracts.
pub fn is_plugin_id(id: &str) -> bool {
    let bytes = id.as_bytes();

    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
        && (bytes.len() == 1 || bytes[bytes.len() - 1] != b'.')
}

/// `lease_` and 16 lowercase hexadecimal characters.
pub fn is_lease_id(id: &str) -> bool {
    id.strip_prefix("lease_").is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

impl ReservationRequest {
    /// From the JSON a plugin sent: validated against the contract first, then read. A request the schema
    /// refuses is never interpreted.
    pub fn from_json(contracts: &Contracts, value: &Value) -> Result<ReservationRequest, StorageError> {
        if !contracts.is_valid(RESERVATION_CONTRACT, value) {
            // A protected zone gets its own answer so the refusal says why.
            if let Some(zone) = value.get("zone").and_then(Value::as_str)
                && let Some(parsed) = Zone::parse(zone)
                && parsed.is_protected()
            {
                return Err(StorageError::ZoneNotReservable(zone.to_string()));
            }

            return Err(StorageError::InvalidRequest(contracts.explain(RESERVATION_CONTRACT, value)));
        }

        let request = ReservationRequest {
            plugin: value["plugin"].as_str().unwrap_or_default().to_string(),
            zone: Zone::reservable(value["zone"].as_str().unwrap_or_default())?,
            requested_bytes: value["requestedBytes"].as_u64().ok_or_else(|| StorageError::InvalidRequest("requestedBytes is not an unsigned integer".into()))?,
            purpose: value["purpose"].as_str().unwrap_or_default().to_string(),
        };

        request.validate()?;

        Ok(request)
    }

    /// The rules of the contract, for a request built in code rather than received.
    pub fn validate(&self) -> Result<(), StorageError> {
        if !is_plugin_id(&self.plugin) {
            return Err(StorageError::InvalidRequest(format!("{:?} is not a plugin id", self.plugin)));
        }

        if !self.zone.is_reservable() {
            return Err(StorageError::ZoneNotReservable(self.zone.name().to_string()));
        }

        if self.requested_bytes == 0 || self.requested_bytes > 1_099_511_627_776 {
            return Err(StorageError::InvalidRequest("requestedBytes is between 1 and 1 TiB".into()));
        }

        if self.purpose.is_empty() || self.purpose.chars().count() > 200 || self.purpose.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
            return Err(StorageError::InvalidRequest("a purpose is one line of 1 to 200 characters".into()));
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub id: String,
    pub plugin: String,
    pub zone: Zone,
    pub path: PathBuf,
    pub granted_bytes: u64,
    pub expires_at_ms: u64,
}

/// `\\?\D:\x` shown as `D:\x`; a UNC path keeps its verbatim form.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();

    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => text,
    }
}

impl Lease {
    /// `c9-storage-lease`.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "plugin": self.plugin,
            "zone": self.zone.name(),
            "path": display_path(&self.path),
            "grantedBytes": self.granted_bytes,
            "expiresAt": iso8601(self.expires_at_ms),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LeaseState {
    /// The plugin may still write; its unwritten bytes are promised and counted.
    Active,
    /// Released: the content stays, counted against the zone, eligible for the purge by the zone's rule.
    Kept,
    /// Ran out: the content is waiting for the purge.
    Expired,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Entry {
    pub id: String,
    pub plugin: String,
    pub zone: Zone,
    pub purpose: String,
    pub granted_bytes: u64,
    pub created_ms: u64,
    pub expires_ms: u64,
    pub last_used_ms: u64,
    pub state: LeaseState,
    /// A model in use: never purged, never deduplicated away.
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct State {
    pub version: u32,
    pub entries: Vec<Entry>,
    /// Paths below the root (forward slashes) nothing may delete: the updater's slots, for one.
    #[serde(default)]
    pub protected: BTreeSet<String>,
}

#[derive(Clone, Debug)]
pub struct VolumeConfig {
    pub root: PathBuf,
    /// Per-zone ceiling, in bytes. A zone with none is limited by the free space only.
    pub quotas: HashMap<Zone, u64>,
    /// Space the host keeps for itself: no reservation may take the volume below it.
    pub min_free_bytes: u64,
    pub lease_ttl_ms: u64,
    /// A lease cannot be renewed past this age.
    pub max_lease_age_ms: u64,
    /// One request may not ask for more than this.
    pub max_request_bytes: u64,
}

impl VolumeConfig {
    pub fn new(root: impl Into<PathBuf>) -> VolumeConfig {
        VolumeConfig {
            root: root.into(),
            quotas: HashMap::new(),
            min_free_bytes: 10 * 1024 * 1024 * 1024,
            lease_ttl_ms: 6 * 3_600_000,
            max_lease_age_ms: 7 * 86_400_000,
            max_request_bytes: 1_099_511_627_776,
        }
    }
}

/// What the host offers the rest of itself. A plugin only ever sees `reserve_json`.
pub trait StorageVolume: Send + Sync {
    fn resolve(&self, zone: Zone) -> PathBuf;
    fn available_space(&self) -> Result<u64, StorageError>;
    fn reserve(&self, request: &ReservationRequest) -> Result<Lease, StorageError>;
    /// The reservation ends and the content stays, counted against the zone.
    fn release(&self, lease_id: &str) -> Result<(), StorageError>;
    fn purge_cache(&self, policy: &PurgePolicy) -> Result<PurgeReport, StorageError>;
}

pub struct ZonedVolume {
    pub(crate) config: VolumeConfig,
    pub(crate) contracts: Arc<Contracts>,
    pub(crate) space: Arc<dyn SpaceProbe>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) state: Mutex<State>,
    /// The canonical root, resolved once.
    pub(crate) root: PathBuf,
}

/// The size of everything under `path`, counting files only and never following a link.
pub(crate) fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };

            if is_reparse(&metadata) {
                continue;
            }

            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }

    total
}

impl ZonedVolume {
    /// Opens (creating on first use) the volume at `config.root`. Any trouble reading the previous
    /// state, or a root or zone that is a link, is an error: the host does not guess.
    pub fn open(config: VolumeConfig, contracts: Arc<Contracts>, space: Arc<dyn SpaceProbe>, clock: Arc<dyn Clock>) -> Result<ZonedVolume, StorageError> {
        fs::create_dir_all(&config.root)?;

        let metadata = fs::symlink_metadata(&config.root)?;

        if is_reparse(&metadata) || !metadata.is_dir() {
            return Err(StorageError::PathRefused(format!("the root {} is a link or not a directory", config.root.display())));
        }

        let root = fs::canonicalize(&config.root)?;

        create_dir_checked(&root, &[HOST_DIR])?;

        for zone in RESERVABLE.iter().chain(crate::zone::PROTECTED.iter()) {
            create_dir_checked(&root, &[zone.name()])?;
        }

        let state_path = root.join(HOST_DIR).join(STATE_FILE);
        let state = match fs::read_to_string(&state_path) {
            Ok(text) => {
                let state: State = serde_json::from_str(&text).map_err(|error| StorageError::State(format!("{} is not readable: {error}", state_path.display())))?;

                if state.version != STATE_VERSION {
                    return Err(StorageError::State(format!("{} is version {}, this host reads version {STATE_VERSION}", state_path.display(), state.version)));
                }

                // The file is on disk, so it is input: an entry that names a path (a plugin called `..`, a lease
                // that is not one of ours) would make the host build a path outside the volume.
                for entry in &state.entries {
                    if !is_plugin_id(&entry.plugin) || !is_lease_id(&entry.id) || !entry.zone.is_reservable() {
                        return Err(StorageError::State(format!("{} holds an entry that is not a lease of this host ({:?}/{:?})", state_path.display(), entry.plugin, entry.id)));
                    }
                }

                for guard in &state.protected {
                    crate::path::safe_relative(guard)
                        .map_err(|error| StorageError::State(format!("{} protects a path the host would not build: {error}", state_path.display())))?;
                }

                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State { version: STATE_VERSION, ..State::default() },
            Err(error) => return Err(StorageError::State(format!("{} cannot be read: {error}", state_path.display()))),
        };

        Ok(ZonedVolume { config, contracts, space, clock, state: Mutex::new(state), root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config(&self) -> &VolumeConfig {
        &self.config
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, State>, StorageError> {
        self.state.lock().map_err(|_| StorageError::State("the storage state lock is poisoned".into()))
    }

    pub(crate) fn zone_dir(&self, zone: Zone) -> PathBuf {
        self.root.join(zone.name())
    }

    pub(crate) fn entry_dir(&self, entry: &Entry) -> PathBuf {
        self.zone_dir(entry.zone).join(&entry.plugin).join(&entry.id)
    }

    /// Atomic: write a sibling, then replace.
    pub(crate) fn persist(&self, state: &State) -> Result<(), StorageError> {
        let dir = self.root.join(HOST_DIR);
        let temporary = dir.join(format!("{STATE_FILE}.tmp"));
        let text = serde_json::to_string_pretty(state).map_err(|error| StorageError::State(error.to_string()))?;

        fs::write(&temporary, text)?;
        fs::rename(&temporary, dir.join(STATE_FILE))?;

        Ok(())
    }

    /// Bytes the active leases of every zone have been promised and not yet written.
    fn promised(&self, state: &State, zone: Option<Zone>) -> u64 {
        state
            .entries
            .iter()
            .filter(|entry| entry.state == LeaseState::Active && zone.is_none_or(|z| z == entry.zone))
            .map(|entry| entry.granted_bytes.saturating_sub(dir_size(&self.entry_dir(entry))))
            .fold(0u64, u64::saturating_add)
    }

    /// What a zone has committed: what is on disk in it, plus what its active leases are still owed.
    pub fn committed(&self, zone: Zone) -> Result<u64, StorageError> {
        let state = self.lock()?;

        Ok(dir_size(&self.zone_dir(zone)).saturating_add(self.promised(&state, Some(zone))))
    }

    /// Leases that have run out stop being promised; their content waits for the purge.
    pub fn expire_leases(&self) -> Result<usize, StorageError> {
        let mut state = self.lock()?;
        let now = self.clock.now_ms();
        let mut expired = 0;

        for entry in state.entries.iter_mut().filter(|entry| entry.state == LeaseState::Active && entry.expires_ms <= now) {
            entry.state = LeaseState::Expired;
            expired += 1;
        }

        if expired > 0 {
            self.persist(&state)?;
        }

        Ok(expired)
    }

    /// The JSON door a plugin uses: validated against the contract, answered with a `c9-storage-lease`.
    pub fn reserve_json(&self, request: &Value) -> Result<Value, StorageError> {
        Ok(self.reserve(&ReservationRequest::from_json(&self.contracts, request)?)?.to_json())
    }

    /// Ends a lease and deletes what it wrote.
    pub fn discard(&self, lease_id: &str) -> Result<u64, StorageError> {
        let mut state = self.lock()?;
        let position = state.entries.iter().position(|entry| entry.id == lease_id).ok_or_else(|| StorageError::UnknownLease(lease_id.to_string()))?;
        let entry = state.entries[position].clone();

        if entry.locked {
            return Err(StorageError::Refused(format!("{lease_id} is locked (in use)")));
        }

        let dir = self.entry_dir(&entry);
        let freed = if dir.exists() {
            let inside = ensure_inside(&self.root, &dir)?;
            let bytes = dir_size(&inside);

            fs::remove_dir_all(&inside)?;

            bytes
        } else {
            0
        };

        state.entries.remove(position);
        self.persist(&state)?;

        Ok(freed)
    }

    /// Extends a lease from now, never past `max_lease_age`.
    pub fn renew(&self, lease_id: &str) -> Result<Lease, StorageError> {
        let mut state = self.lock()?;
        let now = self.clock.now_ms();
        let entry = state.entries.iter_mut().find(|entry| entry.id == lease_id).ok_or_else(|| StorageError::UnknownLease(lease_id.to_string()))?;

        if entry.state != LeaseState::Active {
            return Err(StorageError::Refused(format!("{lease_id} is no longer active")));
        }

        entry.expires_ms = (now + self.config.lease_ttl_ms).min(entry.created_ms + self.config.max_lease_age_ms);

        let lease = self.lease_of(entry);

        self.persist(&state)?;

        Ok(lease)
    }

    /// Marks a lease as used just now: the cache and the models are evicted least recently used first.
    pub fn touch(&self, lease_id: &str) -> Result<(), StorageError> {
        let mut state = self.lock()?;
        let now = self.clock.now_ms();
        let entry = state.entries.iter_mut().find(|entry| entry.id == lease_id).ok_or_else(|| StorageError::UnknownLease(lease_id.to_string()))?;

        entry.last_used_ms = now;

        self.persist(&state)
    }

    /// A model in use is never purged. Locked entries survive every tier.
    pub fn set_locked(&self, lease_id: &str, locked: bool) -> Result<(), StorageError> {
        let mut state = self.lock()?;
        let entry = state.entries.iter_mut().find(|entry| entry.id == lease_id).ok_or_else(|| StorageError::UnknownLease(lease_id.to_string()))?;

        entry.locked = locked;

        self.persist(&state)
    }

    /// Nothing under `relative` (below the root) may be deleted: the updater's current and previous slots.
    pub fn protect(&self, relative: &str) -> Result<(), StorageError> {
        let normal = crate::path::safe_relative(relative)?.to_string_lossy().replace('\\', "/");
        let mut state = self.lock()?;

        state.protected.insert(normal);

        self.persist(&state)
    }

    pub fn unprotect(&self, relative: &str) -> Result<(), StorageError> {
        let normal = crate::path::safe_relative(relative)?.to_string_lossy().replace('\\', "/");
        let mut state = self.lock()?;

        state.protected.remove(&normal);

        self.persist(&state)
    }

    pub(crate) fn lease_of(&self, entry: &Entry) -> Lease {
        Lease {
            id: entry.id.clone(),
            plugin: entry.plugin.clone(),
            zone: entry.zone,
            path: self.entry_dir(entry),
            granted_bytes: entry.granted_bytes,
            expires_at_ms: entry.expires_ms,
        }
    }

    /// Every lease the volume knows, for the report a person reads before a cleanup.
    pub fn leases(&self) -> Result<Vec<(Lease, LeaseState)>, StorageError> {
        let state = self.lock()?;

        Ok(state.entries.iter().map(|entry| (self.lease_of(entry), entry.state)).collect())
    }
}

impl StorageVolume for ZonedVolume {
    fn resolve(&self, zone: Zone) -> PathBuf {
        self.zone_dir(zone)
    }

    fn available_space(&self) -> Result<u64, StorageError> {
        self.space.available(&self.root)
    }

    fn reserve(&self, request: &ReservationRequest) -> Result<Lease, StorageError> {
        request.validate()?;

        if request.requested_bytes > self.config.max_request_bytes {
            return Err(StorageError::InvalidRequest(format!("one request may not ask for more than {} bytes", self.config.max_request_bytes)));
        }

        self.expire_leases()?;

        let mut state = self.lock()?;
        let quota = self.config.quotas.get(&request.zone).copied();

        if let Some(quota) = quota {
            let committed = dir_size(&self.zone_dir(request.zone)).saturating_add(self.promised(&state, Some(request.zone)));

            if committed.saturating_add(request.requested_bytes) > quota {
                return Err(StorageError::QuotaExceeded { zone: request.zone, quota, committed, requested: request.requested_bytes });
            }
        }

        // The space the host keeps for itself, and what every active lease is still owed, come off the top.
        let available = self.space.available(&self.root)?;
        let needed = request.requested_bytes.saturating_add(self.config.min_free_bytes).saturating_add(self.promised(&state, None));

        if available < needed {
            return Err(StorageError::InsufficientSpace { available, needed });
        }

        let now = self.clock.now_ms();
        let id = format!("lease_{}", random_hex(8).map_err(|error| StorageError::State(error.to_string()))?);
        let path = create_dir_checked(&self.root, &[request.zone.name(), &request.plugin, &id])?;
        let entry = Entry {
            id,
            plugin: request.plugin.clone(),
            zone: request.zone,
            purpose: request.purpose.clone(),
            granted_bytes: request.requested_bytes,
            created_ms: now,
            expires_ms: now + self.config.lease_ttl_ms,
            last_used_ms: now,
            state: LeaseState::Active,
            locked: false,
        };
        let lease = Lease { id: entry.id.clone(), plugin: entry.plugin.clone(), zone: entry.zone, path, granted_bytes: entry.granted_bytes, expires_at_ms: entry.expires_ms };

        state.entries.push(entry);

        if let Err(error) = self.persist(&state) {
            // A lease the host cannot remember is a lease it cannot reclaim: undo it.
            state.entries.pop();
            let _ = fs::remove_dir_all(&lease.path);

            return Err(error);
        }

        Ok(lease)
    }

    fn release(&self, lease_id: &str) -> Result<(), StorageError> {
        let mut state = self.lock()?;
        let entry = state.entries.iter_mut().find(|entry| entry.id == lease_id).ok_or_else(|| StorageError::UnknownLease(lease_id.to_string()))?;

        if entry.state == LeaseState::Active {
            entry.state = LeaseState::Kept;
        }

        self.persist(&state)
    }

    fn purge_cache(&self, policy: &PurgePolicy) -> Result<PurgeReport, StorageError> {
        self.purge(policy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_ids_follow_the_contract() {
        for good in ["a", "jarod.models", "jarod.rag", "x1", "a-b_c", "a.b.c"] {
            assert!(is_plugin_id(good), "{good}");
        }

        for bad in ["", "A", "1a", "a.", "-a", ".a", "a b", "a/b", "a\\b", "é", &"a".repeat(65)] {
            assert!(!is_plugin_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn display_path_drops_the_verbatim_prefix_only_for_drive_paths() {
        assert_eq!(display_path(Path::new(r"\\?\D:\Jarod\models")), r"D:\Jarod\models");
        assert_eq!(display_path(Path::new(r"\\?\UNC\server\share")), r"\\?\UNC\server\share");
        assert_eq!(display_path(Path::new("/var/lib/x")), "/var/lib/x");
    }
}
