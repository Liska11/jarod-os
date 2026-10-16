//! The updater of the host (phase 2.5): A/B slots, a signature that cannot be skipped, a trial boot with a
//! health check, and a rollback that is tested rather than hoped for.
//!
//! ```text
//! <root>/slot-a/   an installed version (payload + manifest.json + manifest.sig)
//! <root>/slot-b/   the other one: the update is staged here while the running version is untouched
//! <root>/state.json   which slot is current, which is the last known good, whether a trial is open
//! ```
//!
//! An update is a **bundle**: a directory with `manifest.json` (`c10-update-manifest`), `manifest.sig` (ECDSA
//! P-256 over the exact bytes of the manifest, verified against the key committed for the images,
//! `linux/image/cosign.pub`) and the files the manifest lists. Nothing is installed before the signature, the
//! schema, every hash and size, the file set and the version rule have all passed; `stable` and `edge` are
//! both signed, and there is no switch, variable or flag that turns that off.
//!
//! - [`trust`]: the keys, and the signature check.
//! - [`manifest`]: the manifest, parsed only after it has been verified.
//! - [`updater`]: stage, activate, boot, confirm, roll back.
//! - [`state`]: what survives a restart.

pub mod error;
pub mod manifest;
pub mod state;
pub mod trust;
pub mod updater;

pub use error::UpdateError;
pub use manifest::{Channel, Manifest, Version};
pub use state::Slot;
pub use trust::TrustedKeys;
pub use updater::{BootPlan, StagedUpdate, Updater, UpdaterConfig};
