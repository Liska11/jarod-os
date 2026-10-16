//! The host's pipeline for one request: who is asking, whether the argument shape matches the
//! command, and — for anything that changes the machine — an approval this process witnessed itself,
//! carried by a one-shot capability that is spent before the call runs.
//!
//! A port of `HostControlGate.submit` (`host-control.ts`). Not ported in this spike: the in-process
//! door (`submitLocal`, plugins and windows have no token) and the per-command argument grammar of
//! the shell surface, which the contracts do not freeze (README, "not frozen").

use crate::adjudicate::{ArgSpec, Decision};
use crate::audit::{Attempt, ControlSecurity};
use crate::capability::{CapabilityOutcome, CapabilityRecord, CapabilityStore, fingerprint};
use crate::request::Request;
use crate::types::{Client, HostCode, JournalClient, Tier};
use serde::Serialize;
use serde_json::{Map, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The one-shot credential a granted approval hands back.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CapabilityGrant {
    pub id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    pub binding: String,
}

/// The reply envelope. Not frozen (the contracts leave it out); this is the shell's shape.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HostReply {
    pub ok: bool,
    pub code: HostCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// The caller's name for the attempt, echoed back untouched when it was well formed.
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<CapabilityGrant>,
}

impl HostReply {
    fn refusal(code: HostCode, error: impl Into<String>, request_id: Option<String>) -> HostReply {
        HostReply { ok: false, code, error: Some(error.into()), summary: None, data: None, request_id, capability: None }
    }
}

/// One call, past validation, on its way to the executor.
#[derive(Clone, Debug)]
pub struct HostCall {
    pub client: Client,
    pub tier: Tier,
    /// The wire command (`run`, `theme`, `ui`, …).
    pub cmd: String,
    pub source: Option<String>,
    /// The call's canonical name: `registry:<id>` or `shell:<cmd>`.
    pub command: String,
    /// The registry command id, for registry calls.
    pub id: Option<String>,
    pub request_id: Option<String>,
    pub args: Value,
}

#[derive(Clone, Debug)]
pub struct ApprovalAsk {
    pub id: String,
    pub client: Client,
    pub tier: Tier,
    pub command: String,
    pub source: Option<String>,
    pub request_id: Option<String>,
    /// One line for the person reading it: what is about to happen.
    pub summary: String,
    /// A short preview of the arguments, for the same person; never journalled.
    pub preview: Option<String>,
}

/// The host's way of asking a person. Returning false, panicking, or never answering denies.
pub type ApprovalProvider = Arc<dyn Fn(ApprovalAsk) -> BoxFuture<bool> + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub ok: bool,
    pub code: Option<HostCode>,
    pub reason: Option<String>,
    pub summary: Option<String>,
    pub data: Option<Value>,
}

impl Outcome {
    pub fn ok(summary: impl Into<String>) -> Outcome {
        Outcome { ok: true, summary: Some(summary.into()), ..Outcome::default() }
    }

    pub fn failed(reason: impl Into<String>) -> Outcome {
        Outcome { ok: false, code: Some(HostCode::ExecutionFailed), reason: Some(reason.into()), ..Outcome::default() }
    }
}

/// What actually does the work once the gate has said yes. The host never executes anything on its
/// own: a call reaches an executor only through a [`Ticket`].
pub trait Executor: Send + Sync {
    fn run(&self, call: HostCall) -> BoxFuture<Outcome>;
}

/// Handed to the caller so it can run the call and then say how it went. Consuming `finish` writes
/// exactly one journal line, so a request cannot end twice.
pub struct Ticket {
    pub call: HostCall,
    security: Arc<ControlSecurity>,
    approval: Option<String>,
}

impl Ticket {
    pub fn finish(self, outcome: &Outcome) {
        let ok = outcome.ok;

        self.security.record(Attempt {
            client: Some(self.call.client.into()),
            cmd: self.call.cmd.clone(),
            command: Some(self.call.id.clone().unwrap_or_else(|| self.call.command.clone())),
            tier: Some(self.call.tier),
            source: self.call.source.clone(),
            allowed: ok,
            reason: outcome.reason.clone().or_else(|| outcome.summary.clone()).unwrap_or_else(|| describe(&self.call)),
            code: Some(outcome.code.unwrap_or(if ok { HostCode::Ok } else { HostCode::ExecutionFailed })),
            approval: self.approval,
            request_id: self.call.request_id.clone(),
        });
    }
}

pub enum GateResult {
    Reply(HostReply),
    Execute(Ticket),
}

fn describe(call: &HostCall) -> String {
    match &call.id {
        Some(id) if call.tier == Tier::Read => format!("read {id}"),
        Some(id) => format!("{} {id}", call.tier.as_str()),
        None => format!("{} {}", call.tier.as_str(), call.cmd),
    }
}

fn preview_of(value: &Value) -> Option<String> {
    let text = serde_json::to_string(value).ok()?;

    Some(if text.chars().count() > 200 { format!("{}…", text.chars().take(200).collect::<String>()) } else { text })
}

pub struct HostControlGate {
    security: Arc<ControlSecurity>,
    capabilities: Arc<Mutex<CapabilityStore>>,
    approve: Option<ApprovalProvider>,
    approval_timeout: Duration,
}

impl HostControlGate {
    /// The gate owns the capability store and tells the security policy about it, so the journal masks
    /// every capability this gate mints.
    pub fn new(security: Arc<ControlSecurity>, capabilities: CapabilityStore, approve: Option<ApprovalProvider>) -> HostControlGate {
        let capabilities = Arc::new(Mutex::new(capabilities));
        let for_journal = capabilities.clone();

        security.add_secret_source(move || for_journal.lock().map(|store| store.secrets()).unwrap_or_default());

        HostControlGate { security, capabilities, approve, approval_timeout: Duration::from_secs(60) }
    }

    pub fn with_approval_timeout(mut self, timeout: Duration) -> HostControlGate {
        self.approval_timeout = timeout;

        self
    }

    pub fn security(&self) -> &Arc<ControlSecurity> {
        &self.security
    }

    /// For tests and diagnostics: how many approvals are waiting to be spent.
    pub fn pending_capabilities(&self) -> usize {
        self.capabilities.lock().map(|mut store| store.len()).unwrap_or(0)
    }

    pub async fn submit(&self, request: &Request) -> GateResult {
        let decision = self.security.adjudicate_only(request);
        let cmd = request.cmd();
        let source = request.source();
        // A name we will not write down is not a name: a malformed id is never echoed or journalled, so
        // an attempt that put a secret where the id belongs cannot get that secret into the journal.
        let request_id = if request.request_id_problem().is_some() { String::new() } else { request.request_id() };
        let request_id = Some(request_id).filter(|id| !id.is_empty());

        let refuse = |code: HostCode, reason: String| -> GateResult {
            self.security.record(Attempt {
                client: Some(decision.client.map(JournalClient::from).unwrap_or(JournalClient::Unauthenticated)),
                cmd: cmd.clone(),
                command: Some(request.command_id()),
                tier: decision.tier,
                source: source.clone(),
                allowed: false,
                reason: reason.clone(),
                code: Some(code),
                approval: None,
                request_id: request_id.clone(),
            });

            GateResult::Reply(HostReply::refusal(code, reason, request_id.clone()))
        };

        if !decision.allowed {
            return refuse(decision.code.map(HostCode::from).unwrap_or(HostCode::Unauthorized), decision.reason.clone());
        }

        let Some(client) = decision.client else {
            // An allowed decision always names its client; anything else is a bug, refused.
            return refuse(HostCode::Unauthorized, "the decision names no client".into());
        };
        let registry_call = takes_object_args(&cmd);

        if let Some(problem) = self.validate(&cmd, request, &decision) {
            return refuse(HostCode::Invalid, problem);
        }

        let id = registry_call.then(|| request.command_id());

        // The catalogue decides what a registry command is worth. Until it is loaded nothing is known
        // about the id, and an unknown command is not a small risk: it is refused, not given a tier.
        if registry_call && id.as_deref().is_some_and(|id| !id.is_empty()) && decision.tier.is_none() {
            return refuse(HostCode::Unsupported, format!("unknown command {}", id.unwrap_or_default()));
        }

        // The tier is whatever the policy said. A decision with no tier for a call that has no
        // catalogue entry is `act` only for a registry call with no id, which `run`/`ui` refuse above
        // or `list`/`state` never reach as mutations.
        let tier = decision.tier.unwrap_or(Tier::Act);
        let call = HostCall {
            client,
            tier,
            cmd: cmd.clone(),
            source,
            command: match &id {
                Some(id) if !id.is_empty() => format!("registry:{id}"),
                _ => format!("shell:{cmd}"),
            },
            id: id.filter(|id| !id.is_empty()),
            request_id,
            args: if registry_call {
                request.args().cloned().unwrap_or_else(|| Value::Object(Map::new()))
            } else {
                request.args().filter(|args| args.is_array()).cloned().unwrap_or_else(|| Value::Array(Vec::new()))
            },
        };

        if !tier.needs_approval() {
            return self.ticket(call, None);
        }

        self.with_approval(request, call).await
    }

    /// Shape and argument validation, before any credential is spent on it.
    fn validate(&self, cmd: &str, request: &Request, decision: &Decision) -> Option<String> {
        if let Some(args) = request.args() {
            if takes_object_args(cmd) {
                if !args.is_object() {
                    return Some(format!("{cmd} takes its arguments as a JSON object"));
                }
            } else if !args.as_array().is_some_and(|items| items.iter().all(Value::is_string)) {
                return Some(format!("{cmd} takes its arguments as a list of strings"));
            }
        }

        if request.has_token_of_wrong_type() {
            return Some("a token is a string".into());
        }

        if request.capability_of_wrong_type() {
            return Some("a capability is a string".into());
        }

        if let Some(problem) = request.request_id_problem() {
            return Some(problem);
        }

        if takes_object_args(cmd) {
            let id = request.command_id();

            if let (false, Some(tier)) = (id.is_empty(), decision.tier) {
                return self.validate_registry_args(&id, request.args(), tier);
            }
        }

        None
    }

    /// A registry command's declared arguments. Declared keys are checked for type and enum; a key the
    /// catalogue does not declare is refused for `mutate`/`destructive` (an unexpected argument is
    /// exactly how a command does something other than what it says) and tolerated for `read`/`act`.
    fn validate_registry_args(&self, id: &str, args: Option<&Value>, tier: Tier) -> Option<String> {
        let declared: Vec<ArgSpec> = self.security.args_of(id)?;
        let empty = Map::new();
        let params = args.and_then(Value::as_object).unwrap_or(&empty);

        for spec in &declared {
            let Some(value) = params.get(&spec.name) else {
                if spec.required {
                    return Some(format!("{id} needs {}", spec.name));
                }

                continue;
            };

            match spec.kind.as_deref() {
                Some("string") if !value.is_string() => return Some(format!("{id} takes {} as a string", spec.name)),
                Some("number") if !value.is_number() => return Some(format!("{id} takes {} as a number", spec.name)),
                Some("boolean") if !value.is_boolean() => return Some(format!("{id} takes {} as a boolean", spec.name)),
                _ => {}
            }

            if let Some(options) = &spec.one_of
                && !value.as_str().is_some_and(|text| options.iter().any(|option| option == text))
            {
                return Some(format!("{id} takes {} as one of {}", spec.name, options.join(", ")));
            }
        }

        if tier.needs_approval() {
            for key in params.keys() {
                if !declared.iter().any(|spec| &spec.name == key) {
                    return Some(format!("{id} does not take {key}"));
                }
            }
        }

        None
    }

    /// The `mutate`/`destructive` path. A capability that checks out is spent *before* the call runs.
    async fn with_approval(&self, request: &Request, call: HostCall) -> GateResult {
        let presented = request.capability();
        let binding = request.binding_arguments();

        if !presented.is_empty() {
            let check = match self.capabilities.lock() {
                Ok(mut store) => store.spend(&presented, &call.command, &binding),
                Err(_) => return self.refuse_call(&call, HostCode::CapabilityUnavailable, "the capability store is unavailable".into(), None),
            };

            if check.outcome != CapabilityOutcome::Ok || check.record.is_none() {
                let code = match check.outcome {
                    CapabilityOutcome::Expired => HostCode::Expired,
                    CapabilityOutcome::Mismatch | CapabilityOutcome::Malformed => HostCode::CapabilityMismatch,
                    CapabilityOutcome::Replayed => HostCode::Replay,
                    _ => HostCode::CapabilityUnavailable,
                };
                let print = check.record.as_ref().map(fingerprint);

                return self.refuse_call(&call, code, format!("{}; ask again without a capability to be approved", check.reason), print);
            }

            return self.ticket(call, check.record);
        }

        let approval = match self.ask_approval(&call, preview_of(&binding)).await {
            Ok(ask_id) => ask_id,
            Err(result) => return *result,
        };
        let record = match self.capabilities.lock() {
            Ok(mut store) => store.grant(&call.command, &binding, Some(approval)),
            Err(_) => return self.refuse_call(&call, HostCode::CapabilityUnavailable, "the capability store is unavailable".into(), None),
        };
        let Ok(record) = record else {
            return self.refuse_call(&call, HostCode::CapabilityUnavailable, "no secure randomness: the host cannot mint a capability".into(), None);
        };

        self.security.record(Attempt {
            client: Some(call.client.into()),
            cmd: call.cmd.clone(),
            command: Some(call.id.clone().unwrap_or_else(|| call.command.clone())),
            tier: Some(call.tier),
            source: call.source.clone(),
            allowed: true,
            reason: format!("approved {}; send it again with the capability to spend it once", call.command),
            code: Some(HostCode::ApprovalGranted),
            approval: Some(fingerprint(&record)),
            request_id: call.request_id.clone(),
        });

        GateResult::Reply(HostReply {
            ok: false,
            code: HostCode::ApprovalGranted,
            error: Some("approved: send the same call again with the capability".into()),
            summary: None,
            data: None,
            request_id: call.request_id.clone(),
            capability: Some(CapabilityGrant { id: record.id.clone(), expires_at: record.expires_at, binding: record.binding.clone() }),
        })
    }

    fn refuse_call(&self, call: &HostCall, code: HostCode, reason: String, approval: Option<String>) -> GateResult {
        self.security.record(Attempt {
            client: Some(call.client.into()),
            cmd: call.cmd.clone(),
            command: Some(call.id.clone().unwrap_or_else(|| call.command.clone())),
            tier: Some(call.tier),
            source: call.source.clone(),
            allowed: false,
            reason: reason.clone(),
            code: Some(code),
            approval,
            request_id: call.request_id.clone(),
        });

        GateResult::Reply(HostReply::refusal(code, reason, call.request_id.clone()))
    }

    /// Ask the person, and nothing else: no credential is minted here. A missing provider, a panicking
    /// one and a silent one all deny.
    async fn ask_approval(&self, call: &HostCall, preview: Option<String>) -> Result<String, Box<GateResult>> {
        let Some(approve) = self.approve.clone() else {
            return Err(Box::new(
                self.refuse_call(call, HostCode::DeniedPolicy, "this shell has no way to ask for approval, so a mutation cannot be authorised".into(), None)
                    .replace_error("no approval channel is available"),
            ));
        };

        // Unique and unguessable, not derived from the clock: two asks in the same millisecond are two asks.
        let Ok(random) = crate::secrets::random_hex(8) else {
            return Err(Box::new(
                self.refuse_call(call, HostCode::DeniedPolicy, "no secure randomness: the host cannot name an approval".into(), None)
                    .replace_error("no approval channel is available"),
            ));
        };
        let ask = ApprovalAsk {
            id: format!("ask_{random}"),
            client: call.client,
            tier: call.tier,
            command: call.command.clone(),
            source: call.source.clone(),
            request_id: call.request_id.clone(),
            summary: describe(call),
            preview,
        };
        let ask_id = ask.id.clone();
        // A provider that panics must deny, not take the connection down: run it as its own task.
        // `approve(ask)` itself runs inside the task too: a provider that panics before it even returns a
        // future must be a "no", not an unwound connection.
        // Dropping the handle of a spawned task would leave it running; this one aborts on drop, so whatever
        // ends this request (a timeout, or the caller going away and this future being dropped) also ends
        // the prompt: the dialog or the broker's single slot is released instead of left open for no one.
        let mut pending = AbortOnDrop(tokio::spawn(async move { approve(ask).await }));
        let approved = match tokio::time::timeout(self.approval_timeout, &mut pending.0).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => false,
        };

        if approved {
            return Ok(ask_id);
        }

        Err(Box::new(
            self.refuse_call(call, HostCode::DeniedApproval, format!("the {} command {} was not approved", call.tier.as_str(), call.command), None)
                .replace_error("the request was not approved"),
        ))
    }

    fn ticket(&self, call: HostCall, capability: Option<CapabilityRecord>) -> GateResult {
        GateResult::Execute(Ticket { call, security: self.security.clone(), approval: capability.as_ref().map(fingerprint) })
    }
}

impl GateResult {
    /// The caller's message differs from the journal's reason for the approval refusals (the journal
    /// is precise, the reply is short), as in the shell.
    fn replace_error(self, error: &str) -> GateResult {
        match self {
            GateResult::Reply(mut reply) => {
                reply.error = Some(error.to_string());

                GateResult::Reply(reply)
            }
            other => other,
        }
    }
}

/// A spawned task that is aborted when its handle is dropped.
struct AbortOnDrop(tokio::task::JoinHandle<bool>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn takes_object_args(cmd: &str) -> bool {
    cmd == "run" || cmd == "ui"
}
