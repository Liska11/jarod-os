use crate::zone::Zone;
use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum StorageError {
    /// The request is not what `c9-storage-reservation` describes.
    InvalidRequest(String),
    /// The zone is not one a plugin may reserve (profiles, databases, security logs).
    ZoneNotReservable(String),
    QuotaExceeded {
        zone: Zone,
        quota: u64,
        committed: u64,
        requested: u64,
    },
    InsufficientSpace {
        available: u64,
        needed: u64,
    },
    UnknownLease(String),
    /// A name or path that would leave its zone, or cross a reparse point, or is not a plain name.
    PathRefused(String),
    /// A purge or a deletion the rules forbid (protected, locked, last working version, wrong zone).
    Refused(String),
    Io(String),
    /// The volume's own state cannot be read or trusted: the host stops rather than guess.
    State(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageError::InvalidRequest(why) => write!(f, "invalid storage request: {why}"),
            StorageError::ZoneNotReservable(zone) => write!(f, "the zone {zone:?} cannot be reserved by a plugin"),
            StorageError::QuotaExceeded { zone, quota, committed, requested } => {
                write!(f, "the {} zone is limited to {quota} bytes, {committed} are committed and {requested} were requested", zone.name())
            }
            StorageError::InsufficientSpace { available, needed } => write!(f, "{needed} bytes are needed (with the space kept for the host) and {available} are free"),
            StorageError::UnknownLease(id) => write!(f, "no such lease: {id}"),
            StorageError::PathRefused(why) => write!(f, "path refused: {why}"),
            StorageError::Refused(why) => write!(f, "refused: {why}"),
            StorageError::Io(why) => write!(f, "storage i/o: {why}"),
            StorageError::State(why) => write!(f, "the storage state cannot be trusted: {why}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        StorageError::Io(error.to_string())
    }
}
