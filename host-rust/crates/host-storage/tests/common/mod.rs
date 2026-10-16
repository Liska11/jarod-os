//! Shared by the storage tests: the real contracts, a clock and a disk that a test can move.
#![allow(dead_code)]

use host_control::clock::Clock;
use host_control::contracts::Contracts;
use host_storage::space::FixedSpace;
use host_storage::volume::{VolumeConfig, ZonedVolume};
use host_storage::zone::Zone;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub const GIB: u64 = 1024 * 1024 * 1024;

pub fn contracts() -> Arc<Contracts> {
    Arc::new(Contracts::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/v1")).expect("contracts/v1 must load"))
}

pub struct ManualClock(pub AtomicU64);

impl ManualClock {
    pub fn new(start: u64) -> Arc<ManualClock> {
        Arc::new(ManualClock(AtomicU64::new(start)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub const DAY: u64 = 86_400_000;
pub const START: u64 = 1_760_616_000_000;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("host-storage-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

pub struct Rig {
    pub root: PathBuf,
    pub volume: ZonedVolume,
    pub clock: Arc<ManualClock>,
    pub space: Arc<FixedSpace>,
}

pub fn rig(name: &str) -> Rig {
    rig_with(name, |_| {})
}

pub fn rig_with(name: &str, tune: impl FnOnce(&mut VolumeConfig)) -> Rig {
    let root = scratch(name);
    let clock = ManualClock::new(START);
    let space = Arc::new(FixedSpace::new(2048 * GIB));
    let mut config = VolumeConfig::new(root.join("volume"));

    config.min_free_bytes = 0;
    tune(&mut config);

    let volume = ZonedVolume::open(config, contracts(), space.clone(), clock.clone()).unwrap();

    Rig { root, volume, clock, space }
}

pub fn reopen(rig: &Rig) -> Result<ZonedVolume, host_storage::StorageError> {
    let mut config = VolumeConfig::new(rig.volume.root().to_path_buf());

    config.min_free_bytes = rig.volume.config().min_free_bytes;

    ZonedVolume::open(config, contracts(), rig.space.clone(), rig.clock.clone())
}

pub fn request(plugin: &str, zone: Zone, bytes: u64) -> host_storage::ReservationRequest {
    host_storage::ReservationRequest { plugin: plugin.into(), zone, requested_bytes: bytes, purpose: "a test".into() }
}

pub fn write(path: &Path, bytes: usize) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }

    fs::write(path, vec![b'x'; bytes]).unwrap();
}

pub fn cleanup(rig: &Rig) {
    let _ = fs::remove_dir_all(&rig.root);
}
