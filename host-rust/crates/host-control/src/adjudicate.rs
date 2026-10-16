//! The authorization decision for one control request: pure, refusal by default.
//!
//! A port of `adjudicate` in `apps/desktop/electron/shell/control-authz.ts`, with the matrix read
//! from `contracts/v1` (C2) instead of written in code. Same request and context, same answer.

use crate::contracts::Matrix;
use crate::request::Request;
use crate::secrets::{Tokens, same_token};
use crate::types::{Client, RefusalCode, Surface, Tier};
use serde::Serialize;

/// What the renderer's command registry says a command id is worth (not frozen: it is registered at
/// run time). Until the catalogue is loaded nothing is known about an id.
pub trait Catalogue: Send + Sync {
    fn tier_of(&self, id: &str) -> Option<Tier>;
    /// Whether the catalogue is worth consulting yet; an empty one right after launch is not evidence.
    fn ready(&self) -> bool;
    /// The arguments a registry command declares, when its entry says so.
    fn args_of(&self, _id: &str) -> Option<Vec<ArgSpec>> {
        None
    }
}

/// An argument a registry command declares: checked for type and enum before any credential is spent.
#[derive(Clone, Debug)]
pub struct ArgSpec {
    pub name: String,
    /// `string`, `number` or `boolean`; absent means any.
    pub kind: Option<String>,
    pub required: bool,
    pub one_of: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct CatalogueEntry {
    pub id: String,
    pub tier: Option<Tier>,
    pub args: Option<Vec<ArgSpec>>,
}

/// The catalogue the renderer registered, once it has: ids, tiers and argument shapes. Not frozen
/// (it changes with the UI), so it is data given to the host at run time and never a contract.
#[derive(Default)]
pub struct StaticCatalogue {
    entries: std::sync::RwLock<std::collections::HashMap<String, CatalogueEntry>>,
    ready: std::sync::atomic::AtomicBool,
}

impl StaticCatalogue {
    pub fn set(&self, entries: Vec<CatalogueEntry>) {
        if let Ok(mut map) = self.entries.write() {
            *map = entries.into_iter().map(|entry| (entry.id.clone(), entry)).collect();
        }

        self.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Catalogue for StaticCatalogue {
    fn tier_of(&self, id: &str) -> Option<Tier> {
        self.entries.read().ok()?.get(id)?.tier
    }

    fn ready(&self) -> bool {
        self.ready.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn args_of(&self, id: &str) -> Option<Vec<ArgSpec>> {
        self.entries.read().ok()?.get(id)?.args.clone()
    }
}

/// A catalogue that knows nothing and says so: every registry id is then unclassified.
pub struct EmptyCatalogue;

impl Catalogue for EmptyCatalogue {
    fn tier_of(&self, _id: &str) -> Option<Tier> {
        None
    }

    fn ready(&self) -> bool {
        false
    }
}

/// `c1-control-decision`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Decision {
    pub allowed: bool,
    pub client: Option<Client>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<RefusalCode>,
}

fn refuse(client: Option<Client>, code: RefusalCode, reason: impl Into<String>) -> Decision {
    Decision { allowed: false, client, reason: reason.into(), tier: None, code: Some(code) }
}

fn allow(client: Client, reason: impl Into<String>, tier: Option<Tier>) -> Decision {
    Decision { allowed: true, client: Some(client), reason: reason.into(), tier, code: None }
}

pub struct Context<'a> {
    pub tokens: &'a Tokens,
    pub surface: Surface,
    pub matrix: &'a Matrix,
    pub catalogue: &'a dyn Catalogue,
}

/// The shell command's tier for this request; an action the matrix does not list is a refusal.
fn shell_tier(matrix: &Matrix, cmd: &str, request: &Request) -> Result<Option<Tier>, String> {
    let first = request.args().and_then(|args| args.as_array()).and_then(|args| args.iter().find_map(|arg| arg.as_str()));

    match matrix.shell_tier(cmd, first) {
        None => Ok(None),
        Some(result) => result.map(Some),
    }
}

fn registry_tier(context: &Context<'_>, request: &Request) -> Option<Tier> {
    let id = request.command_id();

    if id.is_empty() { None } else { context.catalogue.tier_of(&id) }
}

pub fn adjudicate(request: &Request, context: &Context<'_>) -> Decision {
    let cmd = request.cmd();

    if cmd.is_empty() {
        return refuse(None, RefusalCode::Invalid, "a control request needs a cmd");
    }

    // Both comparisons always run: which token matched is not learnable from how long this took.
    let as_backend = same_token(request.token(), context.tokens.backend());
    let as_cli = same_token(request.token(), context.tokens.cli());

    if !as_backend && !as_cli {
        return refuse(None, RefusalCode::Unauthenticated, "invalid control token");
    }

    let client = if as_backend { Client::Backend } else { Client::Cli };
    let as_cli = as_cli && !as_backend;
    let matrix = context.matrix;

    // The loose `os`/`os-run` interface is gone on every door, and says so.
    if matrix.retired_commands.contains(&cmd) {
        return refuse(Some(client), RefusalCode::Unsupported, format!("{cmd} was replaced by run/list/state"));
    }

    if context.surface == Surface::Backend {
        if client != Client::Backend {
            return refuse(Some(client), RefusalCode::Unauthorized, "the backend shell surface needs the backend token");
        }

        if !matrix.backend_commands.contains(&cmd) {
            return refuse(Some(client), RefusalCode::Unsupported, format!("unknown command {cmd} on the backend shell surface"));
        }

        if cmd == "run" {
            return run_decision(request, context, client);
        }

        if cmd == "list" || cmd == "state" {
            return allow(client, format!("{cmd} reads the command registry"), Some(Tier::Read));
        }

        let tier = if matrix.registry_commands.contains(&cmd) {
            registry_tier(context, request)
        } else {
            match shell_tier(matrix, &cmd, request) {
                Ok(tier) => tier,
                Err(problem) => return refuse(Some(client), RefusalCode::Invalid, problem),
            }
        };

        return allow(client, format!("{cmd} on the backend shell surface"), tier);
    }

    if matrix.registry_commands.contains(&cmd) {
        if client != Client::Backend {
            return refuse(Some(client), RefusalCode::Unauthorized, format!("the {cmd} command needs the backend token"));
        }

        return allow(client, format!("{cmd} runs in the command registry"), registry_tier(context, request));
    }

    // Everything below is the CLI's own surface; the backend token does not open it.
    if !as_cli {
        return refuse(Some(client), RefusalCode::Unauthorized, format!("the {cmd} command needs the CLI token"));
    }

    if cmd == "list" || cmd == "state" {
        return allow(client, format!("{cmd} reads the command registry"), Some(Tier::Read));
    }

    if cmd == "run" {
        return run_decision(request, context, client);
    }

    if !matrix.knows_shell_command(&cmd) {
        return refuse(Some(client), RefusalCode::Unsupported, format!("unknown command {cmd}"));
    }

    match shell_tier(matrix, &cmd, request) {
        Ok(tier) => allow(client, format!("{cmd} is a shell command"), tier),
        Err(problem) => refuse(Some(client), RefusalCode::Invalid, problem),
    }
}

fn run_decision(request: &Request, context: &Context<'_>, client: Client) -> Decision {
    let id = request.command_id();

    if id.is_empty() {
        return refuse(Some(client), RefusalCode::Invalid, "run needs a command id");
    }

    let tier = context.catalogue.tier_of(&id);

    if tier.is_none() && context.catalogue.ready() {
        return refuse(Some(client), RefusalCode::Unsupported, format!("unknown command {id}"));
    }

    allow(client, format!("run runs {id}"), tier)
}
