//! The adjudicator against the matrix of `contracts/v1` and the rules the TypeScript shell states in
//! `control-authz.test.ts`: two tokens, two surfaces, refusal by default, every decision a valid
//! `c1-control-decision`.

mod common;

use common::{contracts, contracts_dir};
use host_control::adjudicate::{Catalogue, Context, Decision, EmptyCatalogue, StaticCatalogue, adjudicate};
use host_control::request::Request;
use host_control::secrets::Tokens;
use host_control::types::{Client, RefusalCode, Surface, Tier};
use serde_json::{Value, json};
use std::fs;
use std::sync::Arc;

struct Rig {
    tokens: Tokens,
    contracts: Arc<host_control::contracts::Contracts>,
}

impl Rig {
    fn new() -> Rig {
        Rig { tokens: Tokens::mint().unwrap(), contracts: contracts() }
    }

    fn decide(&self, request: Value, surface: Surface, catalogue: &dyn Catalogue) -> Decision {
        let decision = adjudicate(&Request::from_value(request), &Context { tokens: &self.tokens, surface, matrix: &self.contracts.matrix, catalogue });
        let value = serde_json::to_value(&decision).unwrap();

        assert!(
            self.contracts.is_valid("c1-control-decision", &value),
            "a decision that is not a valid c1-control-decision: {value}\n{}",
            self.contracts.explain("c1-control-decision", &value)
        );

        decision
    }
}

fn golden() -> Value {
    serde_json::from_str(&fs::read_to_string(contracts_dir().join("fixtures/c2-authorization-matrix/valid-current.json")).unwrap()).unwrap()
}

fn catalogue() -> Arc<StaticCatalogue> {
    common::catalogue()
}

fn refused(decision: &Decision, client: Option<Client>, code: RefusalCode) {
    assert!(!decision.allowed, "{decision:?}");
    assert_eq!(decision.client, client, "{decision:?}");
    assert_eq!(decision.code, Some(code), "{decision:?}");
}

#[test]
fn no_cmd_no_token_a_wrong_token_all_refuse_before_anything_else() {
    let rig = Rig::new();
    let catalogue = catalogue();

    for surface in [Surface::Panel, Surface::Backend] {
        refused(&rig.decide(json!({}), surface, catalogue.as_ref()), None, RefusalCode::Invalid);
        refused(&rig.decide(json!({ "cmd": "  " }), surface, catalogue.as_ref()), None, RefusalCode::Invalid);
        refused(&rig.decide(json!({ "cmd": 7, "token": rig.tokens.backend() }), surface, catalogue.as_ref()), None, RefusalCode::Invalid);
        refused(&rig.decide(json!({ "cmd": "state" }), surface, catalogue.as_ref()), None, RefusalCode::Unauthenticated);

        for token in [
            json!(""),
            json!("nope"),
            json!(42),
            json!(null),
            json!(["x"]),
            json!({ "token": "x" }),
            json!(format!("{} ", rig.tokens.backend())),
            json!(rig.tokens.backend().to_uppercase()),
        ] {
            refused(&rig.decide(json!({ "cmd": "state", "token": token }), surface, catalogue.as_ref()), None, RefusalCode::Unauthenticated);
        }
    }
}

#[test]
fn a_request_that_is_not_an_object_is_refused_for_lacking_a_cmd() {
    let rig = Rig::new();

    for value in [json!(null), json!([1, 2]), json!("run"), json!(1)] {
        refused(&rig.decide(value, Surface::Panel, &EmptyCatalogue), None, RefusalCode::Invalid);
    }
}

#[test]
fn the_retired_commands_are_refused_loudly_on_every_door_with_either_token() {
    let rig = Rig::new();
    let catalogue = catalogue();

    for surface in [Surface::Panel, Surface::Backend] {
        for (token, client) in [(rig.tokens.backend(), Client::Backend), (rig.tokens.cli(), Client::Cli)] {
            for cmd in ["os", "os-run"] {
                let decision = rig.decide(json!({ "cmd": cmd, "token": token }), surface, catalogue.as_ref());

                refused(&decision, Some(client), RefusalCode::Unsupported);
                assert!(decision.reason.contains("run/list/state"));
            }
        }
    }
}

#[test]
fn the_backend_surface_opens_only_to_the_backend_token_and_only_for_its_allow_list() {
    let rig = Rig::new();
    let catalogue = catalogue();
    let golden = golden();
    let allowed: Vec<&str> = golden["backendCommands"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();

    // The CLI token is refused on every command of the backend door.
    for cmd in &allowed {
        refused(
            &rig.decide(json!({ "cmd": cmd, "token": rig.tokens.cli(), "command": "page.open" }), Surface::Backend, catalogue.as_ref()),
            Some(Client::Cli),
            RefusalCode::Unauthorized,
        );
    }

    // The backend token opens exactly the allow-list.
    for cmd in &allowed {
        let decision = rig.decide(json!({ "cmd": cmd, "token": rig.tokens.backend(), "command": "page.open", "args": ["x"] }), Surface::Backend, catalogue.as_ref());

        assert!(decision.allowed, "{cmd}: {decision:?}");
        assert_eq!(decision.client, Some(Client::Backend));
    }

    // Everything else is refused by the policy, not by a dispatcher afterwards.
    for cmd in ["theme", "plugin", "launch", "wallpaper", "branding", "open", "totally-unknown"] {
        refused(&rig.decide(json!({ "cmd": cmd, "token": rig.tokens.backend() }), Surface::Backend, catalogue.as_ref()), Some(Client::Backend), RefusalCode::Unsupported);
    }
}

#[test]
fn on_the_panel_surface_the_registry_is_the_backends_and_the_shell_is_the_clis() {
    let rig = Rig::new();
    let catalogue = catalogue();

    for cmd in ["ui", "ui-list", "ui-state"] {
        let allowed = rig.decide(json!({ "cmd": cmd, "token": rig.tokens.backend(), "command": "memory.add" }), Surface::Panel, catalogue.as_ref());

        assert!(allowed.allowed && allowed.client == Some(Client::Backend), "{cmd}: {allowed:?}");
        refused(
            &rig.decide(json!({ "cmd": cmd, "token": rig.tokens.cli(), "command": "memory.add" }), Surface::Panel, catalogue.as_ref()),
            Some(Client::Cli),
            RefusalCode::Unauthorized,
        );
    }

    for cmd in ["theme", "page", "notify", "plugin", "launch", "wallpaper"] {
        refused(
            &rig.decide(json!({ "cmd": cmd, "token": rig.tokens.backend(), "args": ["x"] }), Surface::Panel, catalogue.as_ref()),
            Some(Client::Backend),
            RefusalCode::Unauthorized,
        );
    }

    for cmd in ["list", "state"] {
        let decision = rig.decide(json!({ "cmd": cmd, "token": rig.tokens.cli() }), Surface::Panel, catalogue.as_ref());

        assert!(decision.allowed && decision.tier == Some(Tier::Read) && decision.client == Some(Client::Cli), "{cmd}: {decision:?}");
        // On the panel surface `list`/`state` are the CLI's too: the backend token reaches them only through `ui-list`/`ui-state`.
        refused(&rig.decide(json!({ "cmd": cmd, "token": rig.tokens.backend() }), Surface::Panel, catalogue.as_ref()), Some(Client::Backend), RefusalCode::Unauthorized);
    }

    refused(&rig.decide(json!({ "cmd": "frobnicate", "token": rig.tokens.cli() }), Surface::Panel, catalogue.as_ref()), Some(Client::Cli), RefusalCode::Unsupported);
}

#[test]
fn the_tier_of_every_shell_command_is_the_matrixs_and_action_dependent_ones_follow_their_action() {
    let rig = Rig::new();
    let golden = golden();
    let catalogue = catalogue();
    let mut checked = 0;

    for entry in golden["shellCommands"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();

        // `ui-list` and `ui-state` are in the table (tier read) but the registry check comes first on
        // every door, so the CLI never reaches them: the backend's token does, and only that.
        if golden["registryCommands"].as_array().unwrap().iter().any(|c| c == name) {
            refused(&rig.decide(json!({ "cmd": name, "token": rig.tokens.cli() }), Surface::Panel, catalogue.as_ref()), Some(Client::Cli), RefusalCode::Unauthorized);
            checked += 1;

            continue;
        }

        if let Some(tier) = entry.get("tier") {
            let tier = Tier::parse(tier.as_str().unwrap()).unwrap();
            let decision = rig.decide(json!({ "cmd": name, "token": rig.tokens.cli(), "args": ["x"] }), Surface::Panel, catalogue.as_ref());

            assert!(decision.allowed, "{name}: {decision:?}");
            assert_eq!(decision.tier, Some(tier), "{name}");
            checked += 1;
        } else {
            let by_action = &entry["tierByAction"];
            let default = by_action["defaultAction"].as_str().unwrap();

            // No argument: the default action's tier.
            let decision = rig.decide(json!({ "cmd": name, "token": rig.tokens.cli() }), Surface::Panel, catalogue.as_ref());

            assert_eq!(decision.tier, Tier::parse(by_action["actions"][default].as_str().unwrap()), "{name} default");

            for (action, tier) in by_action["actions"].as_object().unwrap() {
                let decision = rig.decide(json!({ "cmd": name, "token": rig.tokens.cli(), "args": [action, "target"] }), Surface::Panel, catalogue.as_ref());

                assert_eq!(decision.tier, Tier::parse(tier.as_str().unwrap()), "{name} {action}");
                checked += 1;
            }

            // An action the matrix does not list is refused, never given a guessed tier.
            refused(
                &rig.decide(json!({ "cmd": name, "token": rig.tokens.cli(), "args": ["no-such-action"] }), Surface::Panel, catalogue.as_ref()),
                Some(Client::Cli),
                RefusalCode::Invalid,
            );
        }
    }

    assert!(checked >= 29, "every shell command of the matrix was exercised ({checked})");
}

#[test]
fn run_needs_an_id_and_an_unknown_id_is_refused_once_the_catalogue_is_ready() {
    let rig = Rig::new();
    let ready = catalogue();
    let not_ready = StaticCatalogue::default();

    for surface_token in [(Surface::Panel, rig.tokens.cli()), (Surface::Backend, rig.tokens.backend())] {
        let (surface, token) = surface_token;

        refused(
            &rig.decide(json!({ "cmd": "run", "token": token }), surface, ready.as_ref()),
            Some(if surface == Surface::Panel { Client::Cli } else { Client::Backend }),
            RefusalCode::Invalid,
        );
        refused(
            &rig.decide(json!({ "cmd": "run", "token": token, "command": "no.such" }), surface, ready.as_ref()),
            Some(if surface == Surface::Panel { Client::Cli } else { Client::Backend }),
            RefusalCode::Unsupported,
        );

        let known = rig.decide(json!({ "cmd": "run", "token": token, "command": "memory.forget" }), surface, ready.as_ref());

        assert!(known.allowed);
        assert_eq!(known.tier, Some(Tier::Destructive));

        // Before the renderer has registered anything, an empty catalogue is not evidence: the command is
        // let through to the gate, which refuses a registry call it cannot classify (see gate.rs tests).
        let early = rig.decide(json!({ "cmd": "run", "token": token, "command": "no.such" }), surface, &not_ready);

        assert!(early.allowed && early.tier.is_none());
    }
}

#[test]
fn the_decision_is_pure_and_never_changes_with_repetition() {
    let rig = Rig::new();
    let catalogue = catalogue();
    let request = || json!({ "cmd": "theme", "token": rig.tokens.cli(), "args": ["dark"] });
    let first = rig.decide(request(), Surface::Panel, catalogue.as_ref());

    for _ in 0..200 {
        assert_eq!(rig.decide(request(), Surface::Panel, catalogue.as_ref()), first);
    }
}

/// Refusal by default, tried a thousand ways: nothing that is not exactly a token opens a door, and a
/// token's neighbours do not either.
#[test]
fn nothing_but_an_exact_token_opens_a_door() {
    let rig = Rig::new();
    let catalogue = catalogue();
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let commands = ["ui", "ui-list", "ui-state", "run", "list", "state", "page", "notify", "voice", "theme", "plugin", "os", "os-run", "", " ", "x"];
    let valid = [rig.tokens.backend().to_string(), rig.tokens.cli().to_string()];
    let mut attempts = 0;

    for _ in 0..1000 {
        let base = &valid[(next() % 2) as usize];
        let mut candidate: Vec<char> = base.chars().collect();
        let at = (next() as usize) % candidate.len();

        // One character different, or one more, or one fewer, or empty: never the token.
        match next() % 4 {
            0 => candidate[at] = if candidate[at] == 'A' { 'B' } else { 'A' },
            1 => candidate.push('A'),
            2 => {
                candidate.pop();
            }
            _ => candidate.clear(),
        }

        let candidate: String = candidate.into_iter().collect();
        let cmd = commands[(next() as usize) % commands.len()];
        let surface = if next() % 2 == 0 { Surface::Panel } else { Surface::Backend };
        let decision = rig.decide(json!({ "cmd": cmd, "token": candidate, "command": "page.open", "args": ["x"] }), surface, catalogue.as_ref());

        assert!(!decision.allowed, "{cmd:?} with {candidate:?} on {surface:?} was allowed: {decision:?}");
        attempts += 1;
    }

    assert_eq!(attempts, 1000);
}
