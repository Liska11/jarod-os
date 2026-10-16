//! The manifest of an update: parsed only after its signature has been checked, validated against
//! `c10-update-manifest`, and held to rules the schema cannot state (no duplicate path in any case, no
//! device name, the entry is one of the files).

use crate::error::UpdateError;
use host_control::contracts::Contracts;
use host_storage::path::validate_component;
use serde::Deserialize;
use std::collections::HashSet;
use std::fmt;

pub const MANIFEST_CONTRACT: &str = "c10-update-manifest";
/// A manifest is a list, not a payload.
pub const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    /// `major.minor.patch`, decimal, no leading zero, nothing else.
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.split('.');
        let number = |part: Option<&str>| -> Option<u64> {
            let part = part?;

            if part.is_empty() || (part.len() > 1 && part.starts_with('0')) || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }

            part.parse().ok()
        };
        let version = Version { major: number(parts.next())?, minor: number(parts.next())?, patch: number(parts.next())? };

        parts.next().is_none().then_some(version)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Edge,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct Raw {
    version: String,
    channel: Channel,
    #[serde(rename = "createdAt")]
    created_at: String,
    entry: String,
    files: Vec<FileEntry>,
}

#[derive(Clone, Debug)]
pub struct Manifest {
    pub version: Version,
    pub channel: Channel,
    pub created_at: String,
    pub entry: String,
    pub files: Vec<FileEntry>,
}

impl Manifest {
    /// `bytes` are the manifest as signed. The signature has already been verified by the caller; this
    /// refuses everything the contract and the extra rules refuse.
    pub fn parse(contracts: &Contracts, bytes: &[u8], max_total_bytes: u64) -> Result<Manifest, UpdateError> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(UpdateError::Invalid("the manifest is far larger than a list of files should be".into()));
        }

        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| UpdateError::Invalid(format!("the manifest is not JSON: {error}")))?;

        if !contracts.is_valid(MANIFEST_CONTRACT, &value) {
            return Err(UpdateError::Invalid(contracts.explain(MANIFEST_CONTRACT, &value)));
        }

        let raw: Raw = serde_json::from_value(value).map_err(|error| UpdateError::Invalid(error.to_string()))?;
        let version = Version::parse(&raw.version).ok_or_else(|| UpdateError::Invalid(format!("{:?} is not a version", raw.version)))?;
        let mut seen = HashSet::new();
        let mut total = 0u64;

        for file in &raw.files {
            for component in file.path.split('/') {
                validate_component(component).map_err(|error| UpdateError::Invalid(format!("{:?}: {error}", file.path)))?;
            }

            // Windows treats `A.TXT` and `a.txt` as one file: two entries that differ only in case are one file twice.
            if !seen.insert(file.path.to_ascii_lowercase()) {
                return Err(UpdateError::Invalid(format!("{:?} is listed twice (paths are compared without case)", file.path)));
            }

            total = total.saturating_add(file.size);
        }

        if total > max_total_bytes {
            return Err(UpdateError::Invalid(format!("the update is {total} bytes, more than the {max_total_bytes} this host accepts")));
        }

        if !raw.files.iter().any(|file| file.path == raw.entry) {
            return Err(UpdateError::Invalid(format!("the entry {:?} is not one of the files", raw.entry)));
        }

        Ok(Manifest { version, channel: raw.channel, created_at: raw.created_at, entry: raw.entry, files: raw.files })
    }
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn versions_are_strict_and_ordered() {
        assert!(Version::parse("0.2.0").unwrap() < Version::parse("0.10.0").unwrap(), "numerically, not as text");
        assert!(Version::parse("1.0.0").unwrap() > Version::parse("0.99.99").unwrap());
        assert_eq!(Version::parse("10.20.30").unwrap().to_string(), "10.20.30");

        for bad in ["", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.-3", "1.2.3-rc1", "v1.2.3", "1.2.x", " 1.2.3", "1..3", "99999999999999999999.0.0"] {
            assert!(Version::parse(bad).is_none(), "{bad:?}");
        }
    }
}
