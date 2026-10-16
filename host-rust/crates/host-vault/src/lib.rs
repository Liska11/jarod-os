//! The host's vault (phase 2.3): the one place a secret lives at rest.
//!
//! API keys, bot tokens and the like are sealed with the operating system's own mechanism (DPAPI on
//! Windows, bound to the user, with the secret's *name* as additional entropy, so a blob copied under
//! another name does not open) and stored one file per secret. Nothing else in the host writes a secret
//! anywhere: not the journal, not a profile, not a log. A secret the vault holds is a secret this process
//! **knows**, so [`Vault::secret_source`] hands the same values to the journal's redaction
//! (`host_control::redact`): a request that carries one has it written as `[REDACTED:vault]`.
//!
//! Fail closed, everywhere: a blob that does not open is an error, never an empty secret; a protector
//! that fails on `put` leaves no file; a vault directory that is a link is refused; plaintext is zeroed
//! when it is dropped; `Debug` never prints a value.

mod protect;

pub use protect::{Protector, ProtectorError};

#[cfg(windows)]
pub use protect::DpapiProtector;

use host_control::secrets::{Secret, SecretKind};
use host_storage::path::{is_reparse, validate_component};
use host_storage::volume::is_plugin_id;
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use zeroize::Zeroize;

const MAGIC: &[u8; 4] = b"JVLT";
const FORMAT: u8 = 1;
const EXTENSION: &str = "sec";
/// A secret is a key or a token, not a file.
pub const MAX_SECRET_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    /// A name that is not a plain, lowercase id (`hermes.api-key`).
    InvalidName(String),
    /// An empty or oversized value.
    InvalidValue(String),
    /// The stored blob does not open: tampered, copied from another name, or sealed for another user.
    /// Never turned into "no secret".
    Corrupt(String),
    Protector(String),
    Io(String),
    /// The vault directory is not what it must be.
    Refused(String),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::InvalidName(name) => write!(f, "{name:?} is not a vault name (lowercase letters, digits, `.`, `_`, `-`; starts with a letter)"),
            VaultError::InvalidValue(why) => write!(f, "invalid secret: {why}"),
            VaultError::Corrupt(name) => write!(f, "the stored secret {name:?} does not open (tampered, moved from another name, or sealed for another user)"),
            VaultError::Protector(why) => write!(f, "the protector failed: {why}"),
            VaultError::Io(why) => write!(f, "vault i/o: {why}"),
            VaultError::Refused(why) => write!(f, "refused: {why}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<ProtectorError> for VaultError {
    fn from(error: ProtectorError) -> Self {
        VaultError::Protector(error.0)
    }
}

impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        VaultError::Io(error.to_string())
    }
}

/// A secret value: zeroed when dropped, and it never prints itself.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> SecretBytes {
        SecretBytes(bytes)
    }

    /// The value. Handle it as briefly as you can and never log it.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn expose_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretBytes({} bytes, [redacted])", self.0.len())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultOp {
    Put,
    Get,
    Delete,
    List,
}

/// Told what happened, never what the value was: an operation, a name, whether it worked.
pub trait VaultObserver: Send + Sync {
    fn event(&self, op: VaultOp, name: &str, ok: bool);
}

pub struct Vault {
    dir: PathBuf,
    protector: Arc<dyn Protector>,
    observer: Option<Arc<dyn VaultObserver>>,
    /// The values this process knows, for redaction: only those that are text. Zeroed with the vault.
    known: Mutex<BTreeMap<String, SecretBytes>>,
}

fn entropy_for(name: &str) -> Vec<u8> {
    let mut entropy = b"jarod-os/vault/v1\0".to_vec();

    entropy.extend_from_slice(name.as_bytes());

    entropy
}

fn check_name(name: &str) -> Result<(), VaultError> {
    if !is_plugin_id(name) || validate_component(name).is_err() {
        return Err(VaultError::InvalidName(name.to_string()));
    }

    Ok(())
}

impl Vault {
    /// Opens (creating on first use) the vault at `dir`, a directory of its own. A link is refused. Any
    /// secret that no longer opens is reported by `get`, not hidden here.
    pub fn open(dir: impl Into<PathBuf>, protector: Arc<dyn Protector>, observer: Option<Arc<dyn VaultObserver>>) -> Result<Vault, VaultError> {
        let dir = dir.into();

        fs::create_dir_all(&dir)?;

        let metadata = fs::symlink_metadata(&dir)?;

        if is_reparse(&metadata) || !metadata.is_dir() {
            return Err(VaultError::Refused(format!("{} is a link or not a directory", dir.display())));
        }

        let vault = Vault { dir: fs::canonicalize(&dir)?, protector, observer, known: Mutex::new(BTreeMap::new()) };

        vault.reload()?;

        Ok(vault)
    }

    /// Windows: the vault directory also gets a protected DACL naming only this user (the sealing is DPAPI
    /// per user already; the ACL keeps other accounts from even reading the files).
    #[cfg(windows)]
    pub fn open_hardened(dir: impl Into<PathBuf>, protector: Arc<dyn Protector>, observer: Option<Arc<dyn VaultObserver>>) -> Result<Vault, VaultError> {
        let dir = dir.into();

        fs::create_dir_all(&dir)?;

        let sid = host_storage::acl::current_user().map_err(|error| VaultError::Refused(error.to_string()))?;

        host_storage::acl::harden_zone_root(&dir, &sid).map_err(|error| VaultError::Refused(error.to_string()))?;

        Vault::open(dir, protector, observer)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.{EXTENSION}"))
    }

    fn notify(&self, op: VaultOp, name: &str, ok: bool) {
        if let Some(observer) = &self.observer {
            observer.event(op, name, ok);
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<String, SecretBytes>>, VaultError> {
        self.known.lock().map_err(|_| VaultError::Io("the vault lock is poisoned".into()))
    }

    /// Reads every stored secret into memory, so redaction knows them. One that does not open is left
    /// out of `known` (and `get` will say why); it never stops the others.
    fn reload(&self) -> Result<(), VaultError> {
        let mut known = self.lock()?;

        known.clear();

        for name in self.names()? {
            if let Ok(Some(value)) = self.read(&name) {
                known.insert(name, value);
            }
        }

        Ok(())
    }

    fn names(&self) -> Result<Vec<String>, VaultError> {
        let mut names: Vec<String> = fs::read_dir(&self.dir)?
            .flatten()
            .filter_map(|item| {
                let path = item.path();

                (path.extension().and_then(|e| e.to_str()) == Some(EXTENSION)).then(|| path.file_stem().map(|s| s.to_string_lossy().to_string())).flatten()
            })
            .filter(|name| check_name(name).is_ok())
            .collect();

        names.sort();

        Ok(names)
    }

    fn read(&self, name: &str) -> Result<Option<SecretBytes>, VaultError> {
        let path = self.file(name);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };

        if bytes.len() <= MAGIC.len() + 1 || &bytes[..MAGIC.len()] != MAGIC || bytes[MAGIC.len()] != FORMAT {
            return Err(VaultError::Corrupt(name.to_string()));
        }

        match self.protector.unprotect(&bytes[MAGIC.len() + 1..], &entropy_for(name)) {
            Ok(plain) => Ok(Some(SecretBytes(plain))),
            Err(_) => Err(VaultError::Corrupt(name.to_string())),
        }
    }

    /// Seals `value` under `name`. The previous value, if any, is replaced atomically; on any failure the
    /// previous value is untouched and no partial file is left.
    pub fn put(&self, name: &str, value: &[u8]) -> Result<(), VaultError> {
        let result = self.put_inner(name, value);

        self.notify(VaultOp::Put, name, result.is_ok());

        result
    }

    fn put_inner(&self, name: &str, value: &[u8]) -> Result<(), VaultError> {
        check_name(name)?;

        if value.is_empty() || value.len() > MAX_SECRET_BYTES {
            return Err(VaultError::InvalidValue(format!("a secret is between 1 and {MAX_SECRET_BYTES} bytes")));
        }

        let sealed = self.protector.protect(value, &entropy_for(name))?;
        let mut file = Vec::with_capacity(MAGIC.len() + 1 + sealed.len());

        file.extend_from_slice(MAGIC);
        file.push(FORMAT);
        file.extend_from_slice(&sealed);

        let temporary = self.dir.join(format!("{name}.{EXTENSION}.tmp"));

        fs::write(&temporary, &file)?;

        if let Err(error) = fs::rename(&temporary, self.file(name)) {
            let _ = fs::remove_file(&temporary);

            return Err(error.into());
        }

        let mut known = self.lock()?;

        known.insert(name.to_string(), SecretBytes(value.to_vec()));

        Ok(())
    }

    /// The secret, `None` if there is none under that name, an error if there is one that does not open.
    pub fn get(&self, name: &str) -> Result<Option<SecretBytes>, VaultError> {
        let result = check_name(name).and_then(|()| self.read(name));

        self.notify(VaultOp::Get, name, result.is_ok());

        result
    }

    pub fn delete(&self, name: &str) -> Result<bool, VaultError> {
        let result = check_name(name).and_then(|()| match fs::remove_file(self.file(name)) {
            Ok(()) => {
                self.lock()?.remove(name);

                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        });

        self.notify(VaultOp::Delete, name, result.is_ok());

        result
    }

    /// The names, never the values.
    pub fn list(&self) -> Result<Vec<String>, VaultError> {
        let result = self.names();

        self.notify(VaultOp::List, "", result.is_ok());

        result
    }

    /// Every value this process holds that is text, as the journal's redaction wants it. Hand it to
    /// `ControlSecurity::add_secret_source(vault.secret_source())`.
    pub fn known_secrets(&self) -> Vec<Secret> {
        self.known.lock().map(|known| known.values().filter_map(|value| value.expose_str().map(|text| Secret::new(SecretKind::Vault, text))).collect()).unwrap_or_default()
    }

    /// A closure over this vault for `add_secret_source`.
    pub fn secret_source(self: &Arc<Self>) -> impl Fn() -> Vec<Secret> + Send + Sync + 'static {
        let vault = self.clone();

        move || vault.known_secrets()
    }
}
