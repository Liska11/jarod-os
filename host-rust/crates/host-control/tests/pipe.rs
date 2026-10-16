#![cfg(windows)]
//! The real transport: a Windows named pipe created with an explicit, protected DACL, the DACL read
//! back off the live object, JSON lines over it, and every way the door is refused to open.

mod common;

use common::{DoorOptions, approver, contracts, contracts_dir};
use host_control::audit::{ControlSecurity, FileJournal};
use host_control::capability::CapabilityStore;
use host_control::clock::SystemClock;
use host_control::endpoint::PipeEndpoint;
use host_control::gate::HostControlGate;
use host_control::pipe::{LiveDacl, PIPE_ACE_MASK, PipeClient, SecuredPipe, assert_dacl, control_pipe_sddl, read_dacl, resolve_principals};
use host_control::secrets::{Secret, SecretKind, Tokens};
use host_control::types::Surface;
use host_control::wire::HostService;
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

struct Live {
    running: Option<host_control::pipe::RunningPipe>,
    endpoint: String,
    cli: String,
    backend: String,
    journal_path: PathBuf,
    executor: Arc<common::RecordingExecutor>,
    nonce: String,
}

fn temp_file(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("host-control-pipe-{name}-{}.jsonl", std::process::id()))
}

/// The whole host, assembled as the binary assembles it: contracts, two minted tokens, a journal file,
/// a gate, a service, a secured pipe.
async fn serve(name: &str, surface: Surface) -> Live {
    let contracts = contracts();
    let tokens = Tokens::mint().unwrap();
    let (cli, backend) = (tokens.cli().to_string(), tokens.backend().to_string());
    let endpoint = PipeEndpoint::fresh().unwrap();
    let journal_path = temp_file(name);
    let _ = fs::remove_file(&journal_path);
    let journal = Arc::new(FileJournal::open(&journal_path).unwrap());
    let clock = Arc::new(SystemClock);
    let nonce = endpoint.nonce().to_string();
    let security = Arc::new(ControlSecurity::new(
        tokens,
        surface,
        Arc::new(contracts.matrix.clone()),
        common::catalogue(),
        journal,
        clock.clone(),
        vec![Secret::new(SecretKind::Nonce, nonce.clone())],
    ));
    let gate = Arc::new(HostControlGate::new(security, CapabilityStore::new(clock), Some(approver(true))));
    let executor = Arc::new(common::RecordingExecutor::default());
    let service = Arc::new(HostService::new(gate, executor.clone()));
    let secured = SecuredPipe::new(endpoint.clone(), resolve_principals().unwrap()).unwrap();
    let running = secured.bind(service).unwrap();

    Live { endpoint: running.serving.endpoint.clone(), running: Some(running), cli, backend, journal_path, executor, nonce }
}

impl Live {
    async fn client(&self) -> PipeClient {
        PipeClient::connect(&self.endpoint).await.unwrap()
    }

    fn journal_lines(&self) -> Vec<Value> {
        fs::read_to_string(&self.journal_path).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    async fn stop(mut self) {
        self.running.take().unwrap().stop().await.unwrap();
        let _ = fs::remove_file(&self.journal_path);
    }
}

#[test]
fn the_principals_are_real_sids_and_the_policy_names_nobody_broad() {
    let principals = resolve_principals().unwrap();

    assert!(!principals.is_empty());

    let sddl = control_pipe_sddl(&principals).unwrap();

    assert!(sddl.starts_with("D:P("), "{sddl}");
    assert_eq!(sddl.matches("(A;;FRFW;;;").count(), principals.len());

    for broad in ["S-1-1-0", "S-1-5-7", "S-1-5-18", "S-1-5-32-544", "S-1-5-11", "S-1-5-32-545"] {
        assert!(control_pipe_sddl(&[broad.to_string()]).is_err(), "{broad} must never be named");
        assert!(control_pipe_sddl(&[principals[0].clone(), broad.to_string()]).is_err(), "{broad} must never be named next to a valid principal");
    }

    for junk in ["", "WD", "Everyone", "S-1", "S-1-", "S-1-5-21-abc", "S-1-5-21-1)(A;;GA;;;WD", "*", "S-1-5-21-1 "] {
        assert!(control_pipe_sddl(&[junk.to_string()]).is_err(), "{junk:?} is not a SID");
    }

    assert!(control_pipe_sddl(&[]).is_err());
}

#[test]
fn a_dacl_that_is_not_exactly_what_was_asked_for_is_refused() {
    let me = vec!["S-1-5-21-1-2-3-1001".to_string()];
    let ace = |sid: &str, mask: u32| (sid.to_string(), mask);

    assert!(assert_dacl(&LiveDacl { aces: vec![ace(&me[0], PIPE_ACE_MASK)], protected: true }, &me).is_ok());
    assert!(assert_dacl(&LiveDacl { aces: vec![ace(&me[0], PIPE_ACE_MASK)], protected: false }, &me).is_err(), "an unprotected DACL can inherit entries");
    assert!(assert_dacl(&LiveDacl { aces: vec![ace(&me[0], PIPE_ACE_MASK), ace("S-1-1-0", 0x120089)], protected: true }, &me).is_err(), "Everyone");
    assert!(assert_dacl(&LiveDacl { aces: vec![ace("S-1-5-21-1-2-3-1002", PIPE_ACE_MASK)], protected: true }, &me).is_err(), "someone else");
    assert!(assert_dacl(&LiveDacl { aces: vec![ace(&me[0], 0x1f01ff)], protected: true }, &me).is_err(), "full control is more than was asked");
    assert!(assert_dacl(&LiveDacl { aces: vec![], protected: true }, &me).is_err(), "an empty DACL grants nobody, not what was asked");
}

#[tokio::test]
async fn the_live_pipe_carries_the_explicit_dacl_and_nothing_else() {
    let live = serve("dacl", Surface::Panel).await;
    let principals = resolve_principals().unwrap();

    // Measured from the outside: open the pipe as a client and read its DACL off the live object.
    let client = ClientOptions::new().open(PipeEndpoint::parse(&live.endpoint).unwrap().path()).unwrap();
    let dacl = read_dacl(&client).unwrap();

    assert!(dacl.protected);
    assert_eq!(dacl.aces.len(), principals.len(), "{:?}", dacl.aces);
    assert!(dacl.aces.iter().all(|(sid, mask)| principals.contains(sid) && *mask == PIPE_ACE_MASK), "{:?}", dacl.aces);
    assert!(!dacl.aces.iter().any(|(sid, _)| ["S-1-1-0", "S-1-5-7", "S-1-5-18", "S-1-5-32-544"].contains(&sid.as_str())), "no broad principal");

    drop(client);
    live.stop().await;
}

#[tokio::test]
async fn the_implicit_dacl_of_a_plain_pipe_is_what_the_check_exists_to_refuse() {
    // A pipe created the ordinary way, as `net.createServer().listen` does, gets the creating token's
    // default DACL. The same check that passes the secured pipe must refuse this one.
    let path = format!(r"\\.\pipe\herald-os-{}", PipeEndpoint::fresh().unwrap().nonce());
    let server = ServerOptions::new().first_pipe_instance(true).create(&path).unwrap();
    let dacl = read_dacl(&server).unwrap();

    assert!(assert_dacl(&dacl, &resolve_principals().unwrap()).is_err(), "the default DACL is not the policy: {:?}", dacl.aces);
}

#[tokio::test]
async fn a_request_goes_through_the_pipe_and_the_journal_is_a_valid_file_of_c3_lines() {
    let live = serve("e2e", Surface::Panel).await;
    let contracts = contracts();
    let mut client = live.client().await;

    // A read command with the CLI token: runs.
    let state = client.send(&json!({ "cmd": "state", "token": live.cli, "requestId": "p1" })).await.unwrap();

    assert_eq!(state["ok"], true, "{state}");
    assert_eq!(state["requestId"], "p1");

    // The wrong token, the backend token on the CLI's door, no token: all refused.
    assert_eq!(client.send(&json!({ "cmd": "state", "token": "nope" })).await.unwrap()["code"], "unauthenticated");
    assert_eq!(client.send(&json!({ "cmd": "state", "token": live.backend })).await.unwrap()["code"], "unauthorized");
    assert_eq!(client.send(&json!({ "cmd": "state" })).await.unwrap()["code"], "unauthenticated");

    // Hostile free text: the live tokens and the pipe's own nonce, in every field a caller controls.
    let hostile = client
        .send(&json!({ "cmd": live.backend, "token": live.cli, "command": live.cli, "source": format!("{} {}", live.backend, live.nonce), "requestId": live.cli }))
        .await
        .unwrap();

    // The reply may hand the caller its own id back (it is well formed); the journal below must not hold it.
    assert_eq!(hostile["ok"], false);

    // Garbage: answered, journalled without the line.
    assert_eq!(client.send_line("{ not json: ").await.map(|reply| serde_json::from_str::<Value>(&reply).unwrap()).unwrap()["error"], "invalid JSON");

    // The approval path, over the wire.
    let mutate = json!({ "cmd": "run", "token": live.cli, "command": "memory.add", "args": { "text": "likes tea" } });
    let granted = client.send(&mutate).await.unwrap();

    assert_eq!(granted["code"], "approval-granted");

    let mut spend = mutate;

    spend["capability"] = granted["capability"]["id"].clone();

    assert_eq!(client.send(&spend).await.unwrap()["ok"], true);
    assert_eq!(client.send(&spend).await.unwrap()["code"], "replay");
    assert_eq!(live.executor.calls.lock().unwrap().len(), 2, "state and the one approved mutation");

    // The journal: one valid line per attempt, and none of the live values in the file.
    let text = fs::read_to_string(&live.journal_path).unwrap();
    let capability = granted["capability"]["id"].as_str().unwrap();

    for line in live.journal_lines() {
        assert!(contracts.is_valid("c3-control-audit-entry", &line), "{line}: {}", contracts.explain("c3-control-audit-entry", &line));
    }

    for hidden in [live.cli.as_str(), live.backend.as_str(), capability, &capability[17..], live.nonce.as_str()] {
        assert!(!text.contains(hidden), "a live value reached control-audit.jsonl");
    }

    assert!(live.journal_lines().len() >= 8);
    drop(client);
    live.stop().await;
}

#[tokio::test]
async fn the_backend_door_over_the_pipe_refuses_the_cli_token() {
    let live = serve("backend", Surface::Backend).await;
    let mut client = live.client().await;

    assert_eq!(client.send(&json!({ "cmd": "state", "token": live.cli })).await.unwrap()["code"], "unauthorized");
    assert_eq!(client.send(&json!({ "cmd": "state", "token": live.backend })).await.unwrap()["ok"], true);
    assert_eq!(client.send(&json!({ "cmd": "theme", "token": live.backend, "args": ["dark"] })).await.unwrap()["code"], "unsupported");
    drop(client);
    live.stop().await;
}

#[tokio::test]
async fn a_second_host_cannot_claim_a_name_that_is_taken() {
    let live = serve("first", Surface::Panel).await;
    let endpoint = PipeEndpoint::parse(&live.endpoint).unwrap();
    let service = {
        let contracts = contracts();
        let door = common::door(DoorOptions::default());
        let _ = contracts;

        door.service.clone()
    };
    let squatter = SecuredPipe::new(endpoint, resolve_principals().unwrap()).unwrap();

    assert!(squatter.bind(service).is_err(), "FILE_FLAG_FIRST_PIPE_INSTANCE: the name is already served");

    // The legitimate host is unaffected.
    let mut client = live.client().await;

    assert_eq!(client.send(&json!({ "cmd": "state", "token": live.cli })).await.unwrap()["ok"], true);
    drop(client);
    live.stop().await;
}

#[tokio::test]
async fn a_line_that_never_ends_drops_the_connection_and_the_host_carries_on() {
    let live = serve("flood", Surface::Panel).await;
    let path = PipeEndpoint::parse(&live.endpoint).unwrap().path();
    let mut flood = ClientOptions::new().open(&path).unwrap();
    let chunk = vec![b'x'; 64 * 1024];
    let mut dropped = false;

    // Just over the limit, with no newline: the host must hang up instead of buffering it.
    for _ in 0..(1_000_000 / chunk.len() + 4) {
        if flood.write_all(&chunk).await.is_err() {
            dropped = true;

            break;
        }
    }

    if !dropped {
        let mut sink = [0u8; 16];

        dropped = matches!(tokio::time::timeout(std::time::Duration::from_secs(10), flood.read(&mut sink)).await, Ok(Ok(0)) | Ok(Err(_)));
    }

    assert!(dropped, "the connection must be closed by the host");

    let mut client = live.client().await;

    assert_eq!(client.send(&json!({ "cmd": "state", "token": live.cli })).await.unwrap()["ok"], true);
    drop(client);
    live.stop().await;
}

#[tokio::test]
async fn the_accept_loop_serves_many_clients_one_after_the_other_and_at_once() {
    let live = Arc::new(serve("many", Surface::Panel).await);

    for _ in 0..25 {
        let mut client = live.client().await;

        assert_eq!(client.send(&json!({ "cmd": "state", "token": live.cli })).await.unwrap()["ok"], true);
    }

    let mut tasks = Vec::new();

    for number in 0..16 {
        let live = live.clone();

        tasks.push(tokio::spawn(async move {
            let mut client = live.client().await;
            let reply = client.send(&json!({ "cmd": "state", "token": live.cli, "requestId": format!("c{number}") })).await.unwrap();

            assert_eq!(reply["requestId"], format!("c{number}"));
            reply["ok"] == true
        }));
    }

    for task in tasks {
        assert!(task.await.unwrap());
    }

    Arc::try_unwrap(live).ok().expect("no client left").stop().await;
}

#[tokio::test]
async fn the_client_refuses_anything_but_the_strict_endpoint() {
    for bad in
        ["tcp://127.0.0.1:5000", "http://localhost", "pipe://herald-os-0123456789ABCDEF", "pipe://herald-os-0123", "pipe://anything", r"\\.\pipe\herald-os-0123456789abcdef", ""]
    {
        assert!(PipeClient::connect(bad).await.is_err(), "{bad:?} must be refused before any connection is tried");
    }

    // A well-formed endpoint nobody is serving is an error too, and says so.
    let nobody = PipeEndpoint::fresh().unwrap();

    assert!(PipeClient::connect(&nobody.endpoint()).await.is_err());
}

#[tokio::test]
async fn once_stopped_the_door_is_closed() {
    let live = serve("stop", Surface::Panel).await;
    let endpoint = live.endpoint.clone();
    let mut client = live.client().await;

    assert_eq!(client.send(&json!({ "cmd": "state", "token": live.cli })).await.unwrap()["ok"], true);
    drop(client);
    live.stop().await;

    assert!(PipeClient::connect(&endpoint).await.is_err());
}

#[tokio::test]
async fn a_policy_that_names_a_broad_principal_never_creates_the_pipe() {
    let endpoint = PipeEndpoint::fresh().unwrap();

    assert!(SecuredPipe::new(endpoint.clone(), vec!["S-1-1-0".to_string()]).is_err());
    assert!(PipeClient::connect(&endpoint.endpoint()).await.is_err(), "no pipe exists under that name");
    let _ = contracts_dir();
}
