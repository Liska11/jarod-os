//! `jarod-control-shadow`, as the shell drives it (V-22): fail closed before `ready`, then one decision per line,
//! the same as `adjudicate` in this crate, and a bad line answered without stopping the process.

mod common;

use common::contracts_dir;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_jarod-control-shadow");
const BACKEND: &str = "shadow-backend-token-0123456789abcdef";
const CLI: &str = "shadow-cli-token-0123456789abcdefghij";

/// Runs the binary with these stdin lines and returns its exit status and stdout lines.
fn run(args: &[&str], lines: &[Value]) -> (Option<i32>, Vec<Value>) {
    let mut child = Command::new(BIN).env_remove("JAROD_OS_CONTRACTS_DIR").args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();

        for line in lines {
            let _ = writeln!(stdin, "{line}");
        }
        let _ = writeln!(stdin, "this is not json");
    }
    let out: Vec<Value> = BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok).map(|line| serde_json::from_str(&line).unwrap()).collect();

    (child.wait().unwrap().code(), out)
}

fn tokens() -> Value {
    json!({ "tokens": { "backend": BACKEND, "cli": CLI } })
}

#[test]
fn without_contracts_or_tokens_it_refuses_before_ready() {
    let contracts = contracts_dir();
    let dir = contracts.to_str().unwrap();

    let (code, out) = run(&[], &[tokens()]);
    assert_eq!((code, out.len()), (Some(2), 0), "no contracts: exit 2, nothing on stdout");

    let (code, out) = run(&["--contracts", dir], &[json!({ "tokens": { "backend": "short", "cli": CLI } })]);
    assert_eq!((code, out.len()), (Some(2), 0), "a short token: exit 2");

    let (code, out) = run(&["--contracts", dir], &[json!({ "tokens": { "backend": CLI, "cli": CLI } })]);
    assert_eq!((code, out.len()), (Some(2), 0), "one token for both doors: exit 2");
}

#[test]
fn one_decision_per_line_and_a_bad_line_does_not_stop_it() {
    let contracts = contracts_dir();
    let lines = [
        tokens(),
        json!({ "id": 1, "surface": "panel", "request": { "cmd": "list", "token": "wrong-token-wrong-token-wrong" } }),
        json!({ "id": 2, "surface": "panel", "request": { "cmd": "list", "token": CLI } }),
        json!({ "id": 3, "surface": "panel", "request": { "cmd": "os", "token": CLI } }),
        json!({ "id": 4, "surface": "panel", "request": { "cmd": "ui", "token": CLI, "command": "x" } }),
        json!({ "id": 5, "surface": "backend", "request": { "cmd": "run", "token": BACKEND, "command": "nope" }, "tier": null, "catalogueReady": true }),
        json!({ "id": 6, "surface": "backend", "request": { "cmd": "run", "token": BACKEND, "command": "nope" }, "tier": null, "catalogueReady": false }),
        json!({ "id": 7, "surface": "backend", "request": { "cmd": "run", "token": BACKEND, "command": " theme.set " }, "tier": "mutate", "catalogueReady": true }),
        json!({ "id": 8, "surface": "attic", "request": { "cmd": "list", "token": CLI } }),
    ];
    let (code, out) = run(&["--contracts", contracts.to_str().unwrap()], &lines);

    assert_eq!(code, Some(0));
    assert_eq!(out[0], json!({ "ready": true }));

    let decision = |id: u64| out.iter().find(|line| line["id"] == id).unwrap()["decision"].clone();

    assert_eq!(decision(1)["code"], "unauthenticated");
    assert_eq!(decision(1)["client"], Value::Null);
    assert_eq!((decision(2)["allowed"].clone(), decision(2)["client"].clone(), decision(2)["tier"].clone()), (json!(true), json!("cli"), json!("read")));
    assert_eq!(decision(3)["code"], "unsupported");
    assert_eq!(decision(4)["code"], "unauthorized");
    assert_eq!(decision(5)["code"], "unsupported", "a catalogue that is loaded and does not know the id");
    assert_eq!((decision(6)["allowed"].clone(), decision(6).get("tier").cloned()), (json!(true), None), "an empty catalogue right after launch is not evidence");
    assert_eq!(decision(7)["tier"], "mutate", "the id is looked up trimmed, as the shell does");
    assert!(out.iter().any(|line| line["id"] == 8 && line["error"].is_string()));
    assert_eq!(out.last().unwrap()["error"], "not JSON");
}
