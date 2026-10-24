//! The Rust adjudicator in the shadow of the TypeScript one (V-22): it decides, it never rules.
//!
//! The shell keeps its own door and its own decision. When `JAROD_HOST_CONTROL=1` it also hands each request it
//! adjudicated to this process and writes down any answer that differs: the live form of the C2 « golden » check
//! (same request, same context, same decision in TS and in Rust) before the Rust host takes over the door.
//!
//! Nothing here touches the real credentials. The first line gives two tokens minted for this process alone; the
//! shell puts in each request the one matching the client its own door recognised (or none), so authentication is
//! compared by its outcome and the live tokens never leave the shell.
//!
//! ```text
//! jarod-control-shadow [--contracts DIR]          (else JAROD_OS_CONTRACTS_DIR; no built-in copy)
//! stdin, one JSON line each:
//!   {"tokens":{"backend":"…","cli":"…"}}           first, exactly once
//!   {"id":1,"surface":"panel"|"backend","request":{…},"tier":"read"|null,"catalogueReady":true}
//! stdout, one JSON line each:
//!   {"ready":true}                                 once the tokens are accepted
//!   {"id":1,"decision":{"allowed":…,"client":…,"reason":…,"tier"?:…,"code"?:…}}
//!   {"id":1|null,"error":"…"}                      a line it could not read; it keeps going
//! ```
//!
//! Exit 2 before `ready` when the contracts or the tokens are missing: fail closed, nothing compared.

use host_control::adjudicate::{CatalogueEntry, Context, StaticCatalogue, adjudicate};
use host_control::contracts::Contracts;
use host_control::request::Request;
use host_control::secrets::Tokens;
use host_control::types::{Surface, Tier};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::PathBuf;

fn refuse(message: impl std::fmt::Display) -> ! {
    eprintln!("jarod-control-shadow: {message}");
    std::process::exit(2);
}

fn contracts() -> Contracts {
    let mut dir: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);

    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--contracts" => dir = Some(args.next().unwrap_or_else(|| refuse("--contracts needs a value")).into()),
            other => refuse(format!("unknown option {other:?}")),
        }
    }

    match dir {
        Some(dir) => Contracts::load(&dir),
        None => Contracts::load_from_env(),
    }
    .unwrap_or_else(|error| refuse(format!("contracts: {error}")))
}

fn tokens(line: &str) -> Tokens {
    let value: Value = serde_json::from_str(line).unwrap_or_else(|_| refuse("the first line must be {\"tokens\":{…}}"));
    let text = |key: &str| value.pointer(&format!("/tokens/{key}")).and_then(Value::as_str).map(str::to_string).unwrap_or_default();

    Tokens::from_values(text("backend"), text("cli")).unwrap_or_else(|error| refuse(error))
}

fn decide(line: &str, contracts: &Contracts, tokens: &Tokens) -> Value {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return json!({ "id": null, "error": "not JSON" });
    };
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    let surface = match value.get("surface").and_then(Value::as_str).unwrap_or("panel") {
        "panel" => Surface::Panel,
        "backend" => Surface::Backend,
        other => return json!({ "id": id, "error": format!("unknown surface {other:?}") }),
    };
    let request = Request::from_value(value.get("request").cloned().unwrap_or(Value::Null));
    let tier = value.get("tier").and_then(Value::as_str).and_then(Tier::parse);
    let catalogue = StaticCatalogue::default();

    // The shell sends what its catalogue says of this request's command id, and whether that catalogue is loaded:
    // the one entry the adjudicator can look up, so both sides decide from the same knowledge.
    if value.get("catalogueReady").and_then(Value::as_bool) == Some(true) {
        let command = request.command_id();
        catalogue.set(if command.is_empty() { Vec::new() } else { vec![CatalogueEntry { id: command, tier, args: None }] });
    }

    let context = Context { tokens, surface, matrix: &contracts.matrix, catalogue: &catalogue };

    json!({ "id": id, "decision": adjudicate(&request, &context) })
}

fn main() {
    let contracts = contracts();
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let first = match lines.next() {
        Some(Ok(line)) => line,
        _ => refuse("no tokens line on stdin"),
    };
    let tokens = tokens(&first);
    let mut out = std::io::stdout().lock();

    if writeln!(out, "{}", json!({ "ready": true })).and_then(|_| out.flush()).is_err() {
        std::process::exit(1);
    }

    for line in lines {
        let Ok(line) = line else { break };

        if line.trim().is_empty() {
            continue;
        }

        if writeln!(out, "{}", decide(&line, &contracts, &tokens)).and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
