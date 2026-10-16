use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum SandboxError {
    /// The confinement could not be established, so nothing was started.
    Refused(String),
    /// The policy or the command is not acceptable (a workspace that is too broad, a program that is missing…).
    Invalid(String),
    Io(String),
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SandboxError::Refused(why) => write!(f, "not started, the confinement could not be established: {why}"),
            SandboxError::Invalid(why) => write!(f, "invalid sandbox request: {why}"),
            SandboxError::Io(why) => write!(f, "sandbox i/o: {why}"),
        }
    }
}

impl std::error::Error for SandboxError {}

impl From<std::io::Error> for SandboxError {
    fn from(error: std::io::Error) -> Self {
        SandboxError::Io(error.to_string())
    }
}

/// What a confined command may consume. Every limit is enforced by the Job Object, not by the command's goodwill.
#[derive(Clone, Debug)]
pub struct Limits {
    /// The most memory the whole process tree may hold. `None`: no limit (not the default).
    pub memory_bytes: Option<u64>,
    /// The most processes the tree may have alive at once.
    pub max_processes: u32,
    /// After this long the whole tree is ended and the run is reported as timed out.
    pub timeout: Duration,
    /// Each of stdout and stderr is kept up to this many bytes; the rest is read and discarded so the child never blocks.
    pub max_output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { memory_bytes: Some(2 * 1024 * 1024 * 1024), max_processes: 64, timeout: Duration::from_secs(120), max_output_bytes: 1024 * 1024 }
    }
}

/// One command to run confined. `program` is a path; the host resolves a bare name against the system PATH
/// before calling, never the sandbox on its own.
#[derive(Clone, Debug)]
pub struct ConfinedCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Inside the workspace; the workspace itself when `None`.
    pub cwd: Option<PathBuf>,
    /// The only environment the command has (plus `TEMP` and `TMP`, which are the workspace's own `.tmp`).
    pub env: BTreeMap<String, String>,
    pub stdin: Vec<u8>,
}

impl ConfinedCommand {
    pub fn new(program: impl Into<PathBuf>) -> ConfinedCommand {
        ConfinedCommand { program: program.into(), args: Vec::new(), cwd: None, env: BTreeMap::new(), stdin: Vec::new() }
    }

    pub fn args<I: IntoIterator<Item = S>, S: Into<String>>(mut self, args: I) -> ConfinedCommand {
        self.args.extend(args.into_iter().map(Into::into));

        self
    }

    pub fn env(mut self, name: &str, value: &str) -> ConfinedCommand {
        self.env.insert(name.to_string(), value.to_string());

        self
    }
}

#[derive(Clone, Debug)]
pub struct Output {
    /// `None` when the tree was ended before the command could exit by itself (timeout, limit).
    pub exit_code: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub elapsed: Duration,
    /// The AppContainer the command ran as, for the audit line (it no longer exists).
    pub container: String,
}

impl Output {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).to_string()
    }
}
