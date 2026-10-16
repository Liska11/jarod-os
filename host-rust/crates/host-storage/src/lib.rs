//! Storage for the privileged host (phase 2.1, 2.2): zones, leases, quotas and a purge that keeps its order.
//!
//! The NVMe volume is a **controlled zone**, not a safe one: plugins never receive its root. A plugin
//! asks for a reservation (`c9-storage-reservation`: plugin, zone, bytes, purpose) and gets a lease
//! (`c9-storage-lease`): a bounded directory `<root>/<zone>/<plugin>/<lease id>` that the host reclaims
//! when the lease ends. Everything that reaches the disk goes through [`path`], which refuses `..`,
//! absolute paths, drive and stream syntax, device names and any reparse point (junction, symlink).
//!
//! - [`zone`]: the zones; profiles, databases and security logs are never reservable and never purged.
//! - [`path`]: the only way a name becomes a path.
//! - [`volume`]: [`volume::StorageVolume`] and its zoned implementation (reserve, release, quotas).
//! - [`purge`]: the purge plan and its fixed order; the last working version is never removed.
//! - [`maintenance`]: orphans, deduplication, the VHDX inventory.
//! - [`health`]: SMART, temperature and wear, as a trait with a PowerShell probe.
//! - [`space`]: free space, as a trait with the Windows implementation.
//! - [`acl`] (Windows): the zone root gets a protected, user-only DACL, read back.

pub mod error;
pub mod health;
pub mod maintenance;
pub mod path;
pub mod purge;
pub mod space;
pub mod volume;
pub mod zone;

#[cfg(windows)]
pub mod acl;

pub use error::StorageError;
pub use volume::{Lease, ReservationRequest, StorageVolume, VolumeConfig, ZonedVolume};
pub use zone::Zone;
