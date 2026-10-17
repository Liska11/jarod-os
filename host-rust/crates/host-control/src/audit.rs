//! The C3 control journal (`control-audit.jsonl`): one JSON line per attempt, never a secret in it.
//!
//! `ControlSecurity` is the host's side of the policy: decide, and record that you decided. Nothing
//! reads the record to make a decision, so a failing sink can never widen access — it is a journal,
//! not a switch. Every line goes through [`redact_secrets`] first (R1 invariant 7), against the two
//! tokens, every live capability and its nonce, and the pipe nonce.

use crate::adjudicate::{Catalogue, Context, Decision, adjudicate};
use crate::clock::Clock;
use crate::contracts::Matrix;
use crate::redact::redact_secrets;
use crate::request::{Request, is_request_id};
use crate::secrets::{Secret, Tokens};
use crate::types::{HostCode, JournalClient, Surface, Tier};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// `c3-control-audit-entry`. The field set is closed on purpose: there is no field in which a
/// credential could be written, and a new field has to be added to the schema before any code can ship it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuditEntry {
    pub at: String,
    pub client: JournalClient,
    pub cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub allowed: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<HostCode>,
    /// An approval this attempt came from, as a 12-hex fingerprint: never the capability itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<Surface>,
}

/// What a caller of [`ControlSecurity::record`] knows; the timestamp, the redaction and the surface
/// are the journal's.
#[derive(Clone, Debug, Default)]
pub struct Attempt {
    pub client: Option<JournalClient>,
    pub cmd: String,
    pub command: Option<String>,
    pub tier: Option<Tier>,
    pub source: Option<String>,
    pub allowed: bool,
    pub reason: String,
    pub code: Option<HostCode>,
    pub approval: Option<String>,
    pub request_id: Option<String>,
}

pub trait AuditSink: Send + Sync {
    fn write(&self, entry: &AuditEntry);
}

/// Keeps entries in memory: the tests read the journal back from here.
#[derive(Default)]
pub struct MemoryJournal {
    entries: Mutex<Vec<AuditEntry>>,
}

impl MemoryJournal {
    pub fn entries(&self) -> Vec<AuditEntry> {
        self.entries.lock().map(|entries| entries.clone()).unwrap_or_default()
    }
}

impl AuditSink for MemoryJournal {
    fn write(&self, entry: &AuditEntry) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.push(entry.clone());
        }
    }
}

/// Default size at which the live journal is rotated to `<name>.1` (one older generation is kept).
pub const DEFAULT_JOURNAL_LIMIT: u64 = 8 * 1024 * 1024;

/// An append-only JSON-lines file, bounded: past its limit it moves to `<name>.1` (replacing the previous
/// generation) and a new file starts. Opening it is part of starting the host: a journal that cannot be
/// opened is a host that does not serve. A line that fails to write later (or a rotation that fails) is a
/// gap in the record, counted, and never a reason to permit or deny anything.
pub struct FileJournal {
    path: PathBuf,
    limit: u64,
    file: Mutex<File>,
    failures: AtomicU64,
}

impl FileJournal {
    pub fn open(path: &Path) -> std::io::Result<FileJournal> {
        FileJournal::open_with_limit(path, DEFAULT_JOURNAL_LIMIT)
    }

    pub fn open_with_limit(path: &Path, limit: u64) -> std::io::Result<FileJournal> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new().create(true).append(true).open(path)?;

        Ok(FileJournal { path: path.to_path_buf(), limit, file: Mutex::new(file), failures: AtomicU64::new(0) })
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    /// How many lines could not be written since the journal was opened.
    pub fn failures(&self) -> u64 {
        self.failures.load(Ordering::Relaxed)
    }

    fn rotated_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();

        name.push(".1");

        PathBuf::from(name)
    }

    /// Called with the lock held, before a line is appended: rotate when the file is at or over the limit.
    fn rotate_if_needed(&self, file: &mut File) -> std::io::Result<()> {
        if file.metadata()?.len() < self.limit {
            return Ok(());
        }

        let old = self.rotated_path();

        // Windows cannot rename over an open file nor onto an existing one: drop the older generation first.
        let _ = fs::remove_file(&old);
        // Close our handle on the live file by swapping in a placeholder opened on the destination later.
        let placeholder = OpenOptions::new().create(true).append(true).open(&self.path)?;
        let live = std::mem::replace(file, placeholder);

        drop(live);
        fs::rename(&self.path, &old)?;
        *file = OpenOptions::new().create(true).append(true).open(&self.path)?;

        Ok(())
    }
}

impl AuditSink for FileJournal {
    fn write(&self, entry: &AuditEntry) {
        let written = serde_json::to_string(entry).map_err(std::io::Error::other).and_then(|line| {
            let mut file = self.file.lock().map_err(|_| std::io::Error::other("journal lock poisoned"))?;

            if self.rotate_if_needed(&mut file).is_err() {
                self.failures.fetch_add(1, Ordering::Relaxed);
            }

            file.write_all(format!("{line}\n").as_bytes())?;
            file.flush()
        });

        if written.is_err() {
            self.failures.fetch_add(1, Ordering::Relaxed);
        }
    }
}

type SecretSource = Box<dyn Fn() -> Vec<Secret> + Send + Sync>;

pub struct ControlSecurity {
    tokens: Tokens,
    surface: Surface,
    matrix: Arc<Matrix>,
    catalogue: Arc<dyn Catalogue>,
    sink: Arc<dyn AuditSink>,
    clock: Arc<dyn Clock>,
    fixed: Vec<Secret>,
    sources: Mutex<Vec<SecretSource>>,
}

impl ControlSecurity {
    pub fn new(
        tokens: Tokens,
        surface: Surface,
        matrix: Arc<Matrix>,
        catalogue: Arc<dyn Catalogue>,
        sink: Arc<dyn AuditSink>,
        clock: Arc<dyn Clock>,
        fixed_secrets: Vec<Secret>,
    ) -> ControlSecurity {
        ControlSecurity { tokens, surface, matrix, catalogue, sink, clock, fixed: fixed_secrets, sources: Mutex::new(Vec::new()) }
    }

    pub fn surface(&self) -> Surface {
        self.surface
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    pub fn tier_of(&self, id: &str) -> Option<Tier> {
        self.catalogue.tier_of(id)
    }

    pub fn args_of(&self, id: &str) -> Option<Vec<crate::adjudicate::ArgSpec>> {
        self.catalogue.args_of(id)
    }

    /// Another holder of live values (the capability store) the journal must keep out.
    pub fn add_secret_source(&self, source: impl Fn() -> Vec<Secret> + Send + Sync + 'static) {
        if let Ok(mut sources) = self.sources.lock() {
            sources.push(Box::new(source));
        }
    }

    fn active_secrets(&self) -> Vec<Secret> {
        let mut secrets = vec![Secret::new(crate::secrets::SecretKind::Token, self.tokens.backend()), Secret::new(crate::secrets::SecretKind::Token, self.tokens.cli())];

        secrets.extend(self.fixed.iter().cloned());

        if let Ok(sources) = self.sources.lock() {
            for source in sources.iter() {
                secrets.extend(source());
            }
        }

        secrets
    }

    /// Decide without writing anything: the pipeline records once, with the outcome it reached.
    pub fn adjudicate_only(&self, request: &Request) -> Decision {
        adjudicate(request, &Context { tokens: &self.tokens, surface: self.surface, matrix: &self.matrix, catalogue: self.catalogue.as_ref() })
    }

    /// One line in the journal. Every free-text field is redacted against the live secrets first, and a
    /// request id that stopped being well formed because of it is dropped rather than half kept.
    pub fn record(&self, attempt: Attempt) {
        let secrets = self.active_secrets();
        let clean = |value: &str| redact_secrets(value, &secrets);
        let request_id = attempt.request_id.as_deref().map(clean).filter(|id| is_request_id(id));

        self.sink.write(&AuditEntry {
            at: self.clock.now_iso(),
            client: attempt.client.unwrap_or(JournalClient::Unauthenticated),
            cmd: clean(&attempt.cmd),
            command: attempt.command.as_deref().map(clean).filter(|command| !command.is_empty()),
            tier: attempt.tier,
            source: attempt.source.as_deref().map(clean),
            allowed: attempt.allowed,
            reason: clean(&attempt.reason),
            code: attempt.code,
            approval: attempt.approval,
            request_id,
            surface: Some(self.surface),
        });
    }

    /// A line that never became a request: valid JSON is required before a token, a command or a caller
    /// can be named. Written down without the line itself, which may well have carried a token.
    pub fn malformed(&self, reason: &str) {
        self.record(Attempt { cmd: String::new(), allowed: false, reason: reason.to_string(), code: Some(HostCode::Invalid), ..Attempt::default() });
    }

    /// Decide and write the decision down (the doors that need nothing more than the policy).
    pub fn check(&self, request: &Request) -> Decision {
        let decision = self.adjudicate_only(request);

        self.record(Attempt {
            client: Some(decision.client.map(JournalClient::from).unwrap_or(JournalClient::Unauthenticated)),
            cmd: request.cmd_raw(),
            command: request.command_raw(),
            tier: decision.tier,
            source: request.source(),
            allowed: decision.allowed,
            reason: decision.reason.clone(),
            code: if decision.allowed { None } else { Some(decision.code.map(HostCode::from).unwrap_or(HostCode::Unauthorized)) },
            approval: None,
            request_id: Some(request.request_id()).filter(|id| !id.is_empty()),
        });

        decision
    }
}
