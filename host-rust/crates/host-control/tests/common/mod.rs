//! Shared by the integration tests: the real contracts, a controllable clock, a recording executor.
#![allow(dead_code)]

use host_control::adjudicate::{ArgSpec, Catalogue, CatalogueEntry, StaticCatalogue};
use host_control::audit::{AuditEntry, ControlSecurity, MemoryJournal};
use host_control::capability::CapabilityStore;
use host_control::clock::Clock;
use host_control::contracts::Contracts;
use host_control::gate::{ApprovalAsk, ApprovalProvider, BoxFuture, Executor, HostCall, HostControlGate, Outcome};
use host_control::secrets::{Secret, Tokens};
use host_control::types::{Surface, Tier};
use host_control::wire::HostService;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub fn contracts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..").join("contracts").join("v1")
}

pub fn contracts() -> Arc<Contracts> {
    Arc::new(Contracts::load(&contracts_dir()).expect("contracts/v1 must load"))
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

#[derive(Default)]
pub struct RecordingExecutor {
    pub calls: Mutex<Vec<HostCall>>,
}

impl Executor for RecordingExecutor {
    fn run(&self, call: HostCall) -> BoxFuture<Outcome> {
        self.calls.lock().unwrap().push(call.clone());

        Box::pin(async move { Outcome::ok(format!("ran {}", call.command)) })
    }
}

pub fn approver(answer: bool) -> ApprovalProvider {
    Arc::new(move |_: ApprovalAsk| -> BoxFuture<bool> { Box::pin(async move { answer }) })
}

pub fn catalogue() -> Arc<StaticCatalogue> {
    let catalogue = Arc::new(StaticCatalogue::default());
    let string_arg = |name: &str| ArgSpec { name: name.into(), kind: Some("string".into()), required: true, one_of: None };

    catalogue.set(vec![
        CatalogueEntry { id: "page.open".into(), tier: Some(Tier::Read), args: Some(vec![string_arg("name")]) },
        CatalogueEntry { id: "memory.add".into(), tier: Some(Tier::Mutate), args: Some(vec![string_arg("text")]) },
        CatalogueEntry { id: "memory.forget".into(), tier: Some(Tier::Destructive), args: Some(vec![string_arg("match")]) },
    ]);

    catalogue
}

pub struct Door {
    pub backend_token: String,
    pub cli_token: String,
    pub journal: Arc<MemoryJournal>,
    pub gate: Arc<HostControlGate>,
    pub service: Arc<HostService>,
    pub executor: Arc<RecordingExecutor>,
    pub clock: Arc<ManualClock>,
    pub security: Arc<ControlSecurity>,
}

pub struct DoorOptions {
    pub surface: Surface,
    pub approve: Option<ApprovalProvider>,
    pub catalogue: Arc<dyn Catalogue>,
    pub fixed_secrets: Vec<Secret>,
    pub approval_timeout: Option<std::time::Duration>,
}

impl Default for DoorOptions {
    fn default() -> Self {
        DoorOptions { surface: Surface::Panel, approve: Some(approver(true)), catalogue: catalogue(), fixed_secrets: Vec::new(), approval_timeout: None }
    }
}

pub fn door(options: DoorOptions) -> Door {
    let contracts = contracts();
    let tokens = Tokens::mint().unwrap();
    let (backend_token, cli_token) = (tokens.backend().to_string(), tokens.cli().to_string());
    let journal = Arc::new(MemoryJournal::default());
    let clock = ManualClock::new(1_760_616_000_000);
    let security =
        Arc::new(ControlSecurity::new(tokens, options.surface, Arc::new(contracts.matrix.clone()), options.catalogue, journal.clone(), clock.clone(), options.fixed_secrets));
    let mut gate = HostControlGate::new(security.clone(), CapabilityStore::new(clock.clone()), options.approve);

    if let Some(timeout) = options.approval_timeout {
        gate = gate.with_approval_timeout(timeout);
    }

    let gate = Arc::new(gate);
    let executor = Arc::new(RecordingExecutor::default());
    let service = Arc::new(HostService::new(gate.clone(), executor.clone()));

    Door { backend_token, cli_token, journal, gate, service, executor, clock, security }
}

pub fn entry_json(entry: &AuditEntry) -> serde_json::Value {
    serde_json::to_value(entry).unwrap()
}

/// Every journal line is valid against the C3 schema and holds none of the live values in `forbidden`.
pub fn assert_journal_clean(contracts: &Contracts, journal: &MemoryJournal, forbidden: &[&str]) {
    for entry in journal.entries() {
        let value = entry_json(&entry);

        assert!(contracts.is_valid("c3-control-audit-entry", &value), "journal line fails c3: {}\n{value}", contracts.explain("c3-control-audit-entry", &value));

        let text = value.to_string();

        for hidden in forbidden {
            assert!(!text.contains(hidden), "a live value reached the journal: {text}");
        }
    }
}
