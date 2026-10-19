#![cfg(windows)]
//! The binary, as a user would run it: every missing prerequisite is a refusal to serve (exit status 2,
//! nothing announced on stdout), and the one good start announces its endpoint only once the door is
//! open and serves a real client.

mod common;

use common::contracts_dir;
use host_control::pipe::PipeClient;
use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_jarod-host-spike");

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("host-control-bin-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

fn command(contracts: Option<&Path>, journal: &Path, tokens: &Path) -> Command {
    let mut command = Command::new(BIN);

    command.env_remove("JAROD_OS_CONTRACTS_DIR");

    if let Some(contracts) = contracts {
        command.env("JAROD_OS_CONTRACTS_DIR", contracts);
    }

    command.arg("--journal").arg(journal).arg("--token-dir").arg(tokens).stdout(Stdio::piped()).stderr(Stdio::piped());

    command
}

/// Runs to completion and returns (status code, stdout, stderr).
fn refusal(mut command: Command) -> (Option<i32>, String, String) {
    let output = command.output().unwrap();

    (output.status.code(), String::from_utf8_lossy(&output.stdout).to_string(), String::from_utf8_lossy(&output.stderr).to_string())
}

#[test]
fn it_refuses_to_serve_when_a_prerequisite_is_missing_and_announces_nothing() {
    let dir = scratch("refusals");
    let (journal, tokens) = (dir.join("control-audit.jsonl"), dir.join("tokens"));
    let contracts = contracts_dir();

    // No contracts folder named at all, and one that does not exist.
    for (case, folder) in [("unset", None), ("missing", Some(Path::new("Z:/no/such/contracts")))] {
        let (code, out, err) = refusal(command(folder, &journal, &tokens));

        assert_eq!(code, Some(2), "{case}: {err}");
        assert!(out.is_empty(), "{case}: nothing may be announced: {out}");
        assert!(err.contains("contracts"), "{case}: {err}");
    }

    // A contracts folder missing its golden matrix.
    let damaged = dir.join("contracts");

    copy(&contracts, &damaged);
    fs::remove_file(damaged.join("fixtures/c2-authorization-matrix/valid-current.json")).unwrap();

    let (code, out, err) = refusal(command(Some(&damaged), &journal, &tokens));

    assert_eq!((code, out.as_str()), (Some(2), ""), "{err}");

    // A journal that cannot be opened.
    let (code, out, err) = refusal(command(Some(&contracts), Path::new("Z:/no/such/drive/control-audit.jsonl"), &tokens));

    assert_eq!((code, out.as_str()), (Some(2), ""), "{err}");
    assert!(err.contains("journal"), "{err}");

    // A token file that already exists: never overwritten, the start stops.
    fs::create_dir_all(&tokens).unwrap();
    fs::write(tokens.join("cli.token"), "planted").unwrap();

    let (code, out, err) = refusal(command(Some(&contracts), &journal, &tokens));

    assert_eq!((code, out.as_str()), (Some(2), ""), "{err}");
    assert_eq!(fs::read_to_string(tokens.join("cli.token")).unwrap(), "planted");

    // Bad command line.
    let (code, out, _) = refusal({
        let mut bad = command(Some(&contracts), &journal, &tokens);

        bad.arg("--surface").arg("everywhere");

        bad
    });

    assert_eq!((code, out.as_str()), (Some(2), ""));

    let _ = fs::remove_dir_all(&dir);
}

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();

    for item in fs::read_dir(from).unwrap() {
        let item = item.unwrap();

        if item.file_type().unwrap().is_dir() {
            copy(&item.path(), &to.join(item.file_name()));
        } else {
            fs::copy(item.path(), to.join(item.file_name())).unwrap();
        }
    }
}

struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The host's own console as the approval window: the person types at the host, never at the caller.
#[tokio::test]
async fn the_console_is_the_approval_window_and_only_a_typed_yes_is_a_yes() {
    use std::io::Write;

    for (typed, expected) in [
        (Some("y\n"), "approval-granted"),
        (Some("yes\n"), "approval-granted"),
        (Some("n\n"), "denied-approval"),
        (Some("sure\n"), "denied-approval"),
        (Some("\n"), "denied-approval"),
        (None, "denied-approval"),
    ] {
        let dir = scratch("console");
        let (journal, tokens) = (dir.join("control-audit.jsonl"), dir.join("tokens"));
        let mut command = command(Some(&contracts_dir()), &journal, &tokens);

        command.arg("--approve-on-console").stdin(Stdio::piped());

        let mut child = command.spawn().unwrap();
        let mut first = String::new();

        BufReader::new(child.stdout.take().unwrap()).read_line(&mut first).unwrap();

        let mut host = Running(child);
        let cli = fs::read_to_string(tokens.join("cli.token")).unwrap();
        let mut client = PipeClient::connect(first.trim()).await.unwrap();
        let request = json!({ "cmd": "theme", "token": cli, "args": ["dark"], "source": "agent" });
        let asking = tokio::spawn(async move { client.send(&request).await.unwrap() });

        // The request is waiting for the person; the person answers at the host's console.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        let mut input = host.0.stdin.take().unwrap();

        match typed {
            Some(line) => {
                input.write_all(line.as_bytes()).unwrap();
                input.flush().unwrap();
            }
            None => drop(input),
        }

        let reply = tokio::time::timeout(std::time::Duration::from_secs(10), asking).await.expect("a reply within 10 s").unwrap();

        assert_eq!(reply["code"], expected, "typed {typed:?}: {reply}");

        drop(host);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[tokio::test]
async fn a_good_start_announces_its_endpoint_once_the_door_is_open_and_serves_a_client() {
    let dir = scratch("serve");
    let (journal, tokens) = (dir.join("control-audit.jsonl"), dir.join("tokens"));
    let mut child = command(Some(&contracts_dir()), &journal, &tokens).spawn().unwrap();
    let mut first = String::new();

    BufReader::new(child.stdout.take().unwrap()).read_line(&mut first).unwrap();

    let host = Running(child);
    let endpoint = first.trim().to_string();

    assert!(endpoint.starts_with("pipe://herald-os-") && endpoint.len() == "pipe://herald-os-".len() + 16, "{endpoint:?}");

    let cli = fs::read_to_string(tokens.join("cli.token")).unwrap();
    let backend = fs::read_to_string(tokens.join("backend.token")).unwrap();
    let mut client = PipeClient::connect(&endpoint).await.unwrap();

    assert_eq!(client.send(&json!({ "cmd": "state", "token": cli })).await.unwrap()["ok"], true);
    assert_eq!(client.send(&json!({ "cmd": "state", "token": backend })).await.unwrap()["code"], "unauthorized");
    // No approval channel in the spike: a mutation is refused, never silently approved.
    assert_eq!(client.send(&json!({ "cmd": "theme", "token": cli, "args": ["dark"] })).await.unwrap()["code"], "denied-policy");

    let text = fs::read_to_string(&journal).unwrap();
    let nonce = &endpoint["pipe://herald-os-".len()..];

    assert!(text.lines().count() >= 3);

    for hidden in [cli.as_str(), backend.as_str(), nonce] {
        assert!(!text.contains(hidden), "a live value reached the journal file");
    }

    drop(client);
    drop(host);
    let _ = fs::remove_dir_all(&dir);
}
