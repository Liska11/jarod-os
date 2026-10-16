//! The zones of the controlled volume.
//!
//! Seven are **reservable**: a plugin may ask for space in them. Three are **protected**: the host's own
//! profiles, databases and security logs. A protected zone is never reservable, never purged and never
//! deduplicated, whatever a policy says (rule 7 of the purge order: "never profiles, databases or
//! security logs without an explicit policy" — and there is no such policy in this crate).

use crate::error::StorageError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Zone {
    Models,
    Downloads,
    Updates,
    Sandboxes,
    Cache,
    Temp,
    Artifacts,
    Profiles,
    Databases,
    SecurityLogs,
}

pub const RESERVABLE: [Zone; 7] = [Zone::Models, Zone::Downloads, Zone::Updates, Zone::Sandboxes, Zone::Cache, Zone::Temp, Zone::Artifacts];
pub const PROTECTED: [Zone; 3] = [Zone::Profiles, Zone::Databases, Zone::SecurityLogs];

impl Zone {
    pub fn name(self) -> &'static str {
        match self {
            Zone::Models => "models",
            Zone::Downloads => "downloads",
            Zone::Updates => "updates",
            Zone::Sandboxes => "sandboxes",
            Zone::Cache => "cache",
            Zone::Temp => "temp",
            Zone::Artifacts => "artifacts",
            Zone::Profiles => "profiles",
            Zone::Databases => "databases",
            Zone::SecurityLogs => "security-logs",
        }
    }

    pub fn parse(name: &str) -> Option<Zone> {
        RESERVABLE.iter().chain(PROTECTED.iter()).copied().find(|zone| zone.name() == name)
    }

    pub fn is_reservable(self) -> bool {
        RESERVABLE.contains(&self)
    }

    pub fn is_protected(self) -> bool {
        PROTECTED.contains(&self)
    }

    /// A zone a plugin asked for by name: only the reservable ones, and a protected one is a distinct error.
    pub fn reservable(name: &str) -> Result<Zone, StorageError> {
        match Zone::parse(name) {
            Some(zone) if zone.is_reservable() => Ok(zone),
            _ => Err(StorageError::ZoneNotReservable(name.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_protected_zones_are_never_reservable() {
        for name in ["profiles", "databases", "security-logs", "nope", "", "MODELS", "../models"] {
            assert!(Zone::reservable(name).is_err(), "{name:?}");
        }

        for zone in RESERVABLE {
            assert_eq!(Zone::reservable(zone.name()), Ok(zone));
            assert!(!zone.is_protected());
        }

        for zone in PROTECTED {
            assert!(zone.is_protected() && !zone.is_reservable());
        }
    }
}
