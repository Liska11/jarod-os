use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateError {
    /// No trusted key, a missing or malformed signature, or one that does not verify.
    Untrusted(String),
    /// The manifest, or a path in it, breaks a rule of the contract.
    Invalid(String),
    /// What is in the bundle is not what the signed manifest says.
    Tampered(String),
    /// The offered version is not newer than the installed one.
    Downgrade {
        installed: String,
        offered: String,
    },
    /// This version already failed its trial here and is not tried again.
    Blocked(String),
    /// An update is on trial, or an operation does not fit the current state.
    State(String),
    /// There is nothing safe to fall back to.
    NoFallback(String),
    Io(String),
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpdateError::Untrusted(why) => write!(f, "untrusted update: {why}"),
            UpdateError::Invalid(why) => write!(f, "invalid update: {why}"),
            UpdateError::Tampered(why) => write!(f, "the update does not match its signed manifest: {why}"),
            UpdateError::Downgrade { installed, offered } => write!(f, "version {offered} is not newer than the installed {installed}"),
            UpdateError::Blocked(version) => write!(f, "version {version} failed its trial on this machine and is not tried again"),
            UpdateError::State(why) => write!(f, "updater state: {why}"),
            UpdateError::NoFallback(why) => write!(f, "no safe version to fall back to: {why}"),
            UpdateError::Io(why) => write!(f, "updater i/o: {why}"),
        }
    }
}

impl std::error::Error for UpdateError {}

impl From<std::io::Error> for UpdateError {
    fn from(error: std::io::Error) -> Self {
        UpdateError::Io(error.to_string())
    }
}
