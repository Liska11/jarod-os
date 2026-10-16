//! The pipeline behind the adjudicator: approvals, one-shot capabilities spent before execution, every
//! deny path, and a journal that is a valid C3 line each time and never holds a live secret.

mod common;

use common::{Door, DoorOptions, approver, contracts, door};
use host_control::gate::{ApprovalAsk, ApprovalProvider, BoxFuture, Executor, HostCall, Outcome};
use host_control::types::Surface;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

async fn send(door: &Door, request: Value) -> Value {
    door.service.handle_line(&request.to_string()).await
}

fn calls(door: &Door) -> usize {
    door.executor.calls.lock().unwrap().len()
}

fn add(token: &str, text: &str) -> Value {
    json!({ "cmd": "run", "token": token, "command": "memory.add", "args": { "text": text }, "requestId": "r1" })
}

fn clean(door: &Door, hidden: &[&str]) {
    common::assert_journal_clean(&contracts(), &door.journal, hidden);
}

#[tokio::test]
async fn a_read_command_runs_without_asking_anyone() {
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = asked.clone();
    let approve: ApprovalProvider = Arc::new(move |_: ApprovalAsk| -> BoxFuture<bool> {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { true })
    });
    let door = door(DoorOptions { approve: Some(approve), ..DoorOptions::default() });
    let reply = send(&door, json!({ "cmd": "run", "token": door.cli_token, "command": "page.open", "args": { "name": "memory" }, "requestId": "oc9" })).await;

    assert_eq!(reply["ok"], true);
    assert_eq!(reply["code"], "ok");
    assert_eq!(reply["requestId"], "oc9");
    assert_eq!(calls(&door), 1);
    assert_eq!(asked.load(Ordering::SeqCst), 0);

    let [entry] = door.journal.entries().try_into().unwrap();

    assert!(entry.allowed && entry.request_id.as_deref() == Some("oc9"));
    clean(&door, &[&door.cli_token, &door.backend_token]);
}

#[tokio::test]
async fn a_mutation_needs_an_approval_then_a_capability_spent_once() {
    let door = door(DoorOptions::default());
    let token = door.cli_token.clone();

    // 1. First ask: the person says yes, nothing runs, a capability comes back.
    let granted = send(&door, add(&token, "likes tea")).await;

    assert_eq!(granted["code"], "approval-granted");
    assert_eq!(granted["ok"], false);
    assert_eq!(calls(&door), 0, "an approval is not an execution");

    let capability = granted["capability"]["id"].as_str().unwrap().to_string();

    assert!(capability.starts_with("cap_"));
    assert_eq!(granted["capability"]["binding"].as_str().unwrap().len(), 64);

    // 2. The same call with the capability runs, once.
    let mut again = add(&token, "likes tea");

    again["capability"] = json!(capability);

    let done = send(&door, again.clone()).await;

    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(calls(&door), 1);

    // 3. Spending it a second time is a replay, and nothing runs.
    let replay = send(&door, again).await;

    assert_eq!(replay["code"], "replay");
    assert_eq!(calls(&door), 1);

    // The journal tells the whole story and holds neither token nor capability nor nonce.
    let nonce = &capability[17..];

    clean(&door, &[&token, &door.backend_token, &capability, nonce]);

    let codes: Vec<_> = door.journal.entries().iter().map(|e| (e.allowed, e.code.map(|c| c.as_str()))).collect();

    assert_eq!(codes, vec![(true, Some("approval-granted")), (true, Some("ok")), (false, Some("replay"))]);
    assert!(door.journal.entries().iter().all(|entry| entry.approval.as_deref().is_none_or(|a| a.len() == 12)));
    // The attempt that ran and the approval it came from line up on the same fingerprint.
    let approvals: Vec<_> = door.journal.entries().iter().filter_map(|e| e.approval.clone()).collect();

    assert_eq!(approvals.len(), 3);
    assert!(approvals.windows(2).all(|pair| pair[0] == pair[1]));
}

#[tokio::test]
async fn a_capability_is_bound_to_its_call_and_a_refusal_does_not_spend_it() {
    let door = door(DoorOptions::default());
    let token = door.cli_token.clone();
    let granted = send(&door, add(&token, "likes tea")).await;
    let capability = granted["capability"]["id"].as_str().unwrap().to_string();
    let with = |request: Value| {
        let mut request = request;

        request["capability"] = json!(capability);

        request
    };

    // Other arguments, another command, another surface name: none of them was approved.
    assert_eq!(send(&door, with(add(&token, "likes coffee"))).await["code"], "capability-mismatch");
    assert_eq!(send(&door, with(json!({ "cmd": "run", "token": token, "command": "memory.forget", "args": { "match": "x" } }))).await["code"], "capability-mismatch");
    assert_eq!(calls(&door), 0);

    // The provenance of a call is not part of the binding: it still runs, once.
    let mut renamed = with(add(&token, "likes tea"));

    renamed["source"] = json!("a different caller");

    assert_eq!(send(&door, renamed).await["ok"], true);
    assert_eq!(calls(&door), 1);
}

#[tokio::test]
async fn a_capability_that_was_never_issued_or_is_mangled_is_refused() {
    let door = door(DoorOptions::default());
    let token = door.cli_token.clone();

    for bogus in ["cap_AAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBB", "cap_short", "nonsense", "cap_é"] {
        let mut request = add(&token, "likes tea");

        request["capability"] = json!(bogus);

        let reply = send(&door, request).await;

        assert_eq!(reply["ok"], false, "{bogus}");
        assert!(matches!(reply["code"].as_str(), Some("capability-unavailable") | Some("capability-mismatch")), "{bogus}: {reply}");
    }

    assert_eq!(calls(&door), 0);
    // A capability of the wrong type is a malformed request, refused before anything is spent.
    let mut typed = add(&token, "x");

    typed["capability"] = json!(12);

    assert_eq!(send(&door, typed).await["code"], "invalid");
}

#[tokio::test]
async fn a_capability_expires() {
    let door = door(DoorOptions::default());
    let token = door.cli_token.clone();
    let granted = send(&door, add(&token, "likes tea")).await;
    let mut late = add(&token, "likes tea");

    late["capability"] = granted["capability"]["id"].clone();
    door.clock.advance(120_000);

    assert_eq!(send(&door, late).await["code"], "expired");
    assert_eq!(calls(&door), 0);
}

#[tokio::test]
async fn a_destructive_command_follows_the_same_path() {
    let door = door(DoorOptions::default());
    let token = door.cli_token.clone();
    let request = json!({ "cmd": "run", "token": token, "command": "memory.forget", "args": { "match": "tea" } });
    let granted = send(&door, request.clone()).await;

    assert_eq!(granted["code"], "approval-granted");

    let mut spend = request;

    spend["capability"] = granted["capability"]["id"].clone();

    assert_eq!(send(&door, spend).await["ok"], true);
    assert_eq!(door.journal.entries().last().unwrap().tier.map(|t| t.as_str()), Some("destructive"));
}

#[tokio::test]
async fn no_approver_a_no_a_panic_and_a_silence_all_deny_and_nothing_runs() {
    // No way to ask at all.
    let none = door(DoorOptions { approve: None, ..DoorOptions::default() });
    let reply = send(&none, add(&none.cli_token, "x")).await;

    assert_eq!(reply["code"], "denied-policy");
    assert_eq!(calls(&none), 0);

    // The person says no.
    let no = door(DoorOptions { approve: Some(approver(false)), ..DoorOptions::default() });

    assert_eq!(send(&no, add(&no.cli_token, "x")).await["code"], "denied-approval");
    assert_eq!(calls(&no), 0);

    // The provider panics: that is a no, not a crashed connection.
    let panics: ApprovalProvider = Arc::new(|_: ApprovalAsk| -> BoxFuture<bool> { Box::pin(async { panic!("the dialog fell over") }) });
    let broken = door(DoorOptions { approve: Some(panics), ..DoorOptions::default() });

    assert_eq!(send(&broken, add(&broken.cli_token, "x")).await["code"], "denied-approval");
    assert_eq!(calls(&broken), 0);

    // Nobody answers: it times out into a no instead of holding the request forever.
    let silent: ApprovalProvider = Arc::new(|_: ApprovalAsk| -> BoxFuture<bool> {
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(3600)).await;

            true
        })
    });
    let quiet = door(DoorOptions { approve: Some(silent), approval_timeout: Some(Duration::from_millis(50)), ..DoorOptions::default() });
    let reply = send(&quiet, add(&quiet.cli_token, "x")).await;

    assert_eq!(reply["code"], "denied-approval");
    assert_eq!(calls(&quiet), 0);

    for door in [&none, &no, &broken] {
        clean(door, &[&door.cli_token, &door.backend_token]);
    }
}

#[tokio::test]
async fn a_malformed_call_is_refused_before_anyone_is_asked() {
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = asked.clone();
    let approve: ApprovalProvider = Arc::new(move |_: ApprovalAsk| -> BoxFuture<bool> {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { true })
    });
    let door = door(DoorOptions { approve: Some(approve), ..DoorOptions::default() });
    let token = door.cli_token.clone();

    for (request, reason) in [
        (json!({ "cmd": "run", "token": token, "command": "memory.add", "args": ["not", "an", "object"] }), "JSON object"),
        (json!({ "cmd": "run", "token": token, "command": "memory.add", "args": null }), "JSON object"),
        (json!({ "cmd": "run", "token": token, "command": "memory.add", "args": {} }), "needs text"),
        (json!({ "cmd": "run", "token": token, "command": "memory.add", "args": { "text": 7 } }), "as a string"),
        (json!({ "cmd": "run", "token": token, "command": "memory.add", "args": { "text": "x", "extra": 1 } }), "does not take extra"),
        (json!({ "cmd": "theme", "token": token, "args": { "not": "a list" } }), "list of strings"),
        (json!({ "cmd": "theme", "token": token, "args": ["a", 1] }), "list of strings"),
    ] {
        let reply = send(&door, request.clone()).await;

        assert_eq!(reply["code"], "invalid", "{request}: {reply}");
        assert!(reply["error"].as_str().unwrap().contains(reason), "{reply}");
    }

    assert_eq!(asked.load(Ordering::SeqCst), 0);
    assert_eq!(calls(&door), 0);
}

#[tokio::test]
async fn a_registry_command_the_host_cannot_classify_is_refused_not_guessed() {
    // Before the renderer has registered a catalogue nothing is known about an id.
    let door = door(DoorOptions { catalogue: Arc::new(host_control::adjudicate::StaticCatalogue::default()), ..DoorOptions::default() });
    let reply = send(&door, json!({ "cmd": "run", "token": door.cli_token, "command": "memory.forget", "args": { "match": "x" } })).await;

    assert_eq!(reply["code"], "unsupported");
    assert_eq!(calls(&door), 0);
}

#[tokio::test]
async fn a_secret_put_in_a_free_text_field_never_reaches_the_journal() {
    let door = door(DoorOptions::default());
    let (cli, backend) = (door.cli_token.clone(), door.backend_token.clone());

    // The other door's token as the source, the CLI token as an unknown command id (the reason echoes
    // it) and as the request id, the backend token as the cmd.
    send(&door, json!({ "cmd": "run", "token": cli, "command": backend.clone(), "source": backend.clone(), "requestId": cli.clone() })).await;
    send(&door, json!({ "cmd": backend.clone(), "token": cli })).await;
    send(&door, json!({ "cmd": "state", "token": backend, "source": cli })).await;

    // A live capability, used as the source of a later attempt, and its nonce on its own.
    let granted = send(&door, add(&cli, "likes tea")).await;
    let capability = granted["capability"]["id"].as_str().unwrap().to_string();
    let nonce = capability[17..].to_string();
    let mut attempt = add(&cli, "likes coffee");

    attempt["source"] = json!(format!("via {capability} and {nonce}"));
    attempt["capability"] = json!(capability);
    send(&door, attempt).await;

    let text = serde_json::to_string(&door.journal.entries().iter().map(common::entry_json).collect::<Vec<_>>()).unwrap();

    for hidden in [&cli, &backend, &capability, &nonce] {
        assert!(!text.contains(hidden.as_str()), "a live secret reached the journal");
    }

    assert!(text.contains("[REDACTED:token]") && text.contains("[REDACTED:capability]"));
    clean(&door, &[&cli, &backend, &capability, &nonce]);
}

#[tokio::test]
async fn a_request_id_that_is_not_an_id_is_neither_echoed_nor_written_down() {
    let door = door(DoorOptions::default());
    let reply = send(&door, json!({ "cmd": "state", "token": door.cli_token, "requestId": "has a space" })).await;

    assert_eq!(reply["code"], "invalid");
    assert!(reply.get("requestId").is_none());
    assert!(door.journal.entries().iter().all(|entry| entry.request_id.is_none()));
}

#[tokio::test]
async fn a_failed_execution_is_journalled_as_a_failure() {
    struct Failing;

    impl Executor for Failing {
        fn run(&self, _call: HostCall) -> BoxFuture<Outcome> {
            Box::pin(async { Outcome::failed("the window did not answer") })
        }
    }

    let door = door(DoorOptions::default());
    let service = host_control::wire::HostService::new(door.gate.clone(), Arc::new(Failing));
    let reply = service.handle_line(&json!({ "cmd": "run", "token": door.cli_token, "command": "page.open", "args": { "name": "x" } }).to_string()).await;

    assert_eq!(reply["ok"], false);
    assert_eq!(reply["code"], "execution-failed");

    let entry = door.journal.entries().pop().unwrap();

    assert!(!entry.allowed);
    assert_eq!(entry.code.map(|c| c.as_str()), Some("execution-failed"));
}

#[tokio::test]
async fn two_requests_racing_on_one_capability_run_exactly_one_call() {
    let door = Arc::new(door(DoorOptions::default()));
    let token = door.cli_token.clone();
    let granted = send(&door, add(&token, "likes tea")).await;
    let mut spend = add(&token, "likes tea");

    spend["capability"] = granted["capability"]["id"].clone();

    let mut tasks = Vec::new();

    for _ in 0..32 {
        let (door, request) = (door.clone(), spend.clone());

        tasks.push(tokio::spawn(async move { send(&door, request).await }));
    }

    let mut ok = 0;
    let mut replayed = 0;

    for task in tasks {
        let reply = task.await.unwrap();

        match reply["code"].as_str() {
            Some("ok") => ok += 1,
            Some("replay") => replayed += 1,
            other => panic!("unexpected outcome {other:?}"),
        }
    }

    assert_eq!((ok, replayed), (1, 31));
    assert_eq!(calls(&door), 1);
}

#[tokio::test]
async fn the_backend_door_has_the_same_rules() {
    let door = door(DoorOptions { surface: Surface::Backend, ..DoorOptions::default() });

    // The CLI token does not open the backend door at all.
    assert_eq!(send(&door, add(&door.cli_token, "x")).await["code"], "unauthorized");
    // The backend token runs a registry command through the same approval path.
    let granted = send(&door, add(&door.backend_token, "x")).await;

    assert_eq!(granted["code"], "approval-granted");
    assert_eq!(door.journal.entries().last().unwrap().surface, Some(Surface::Backend));
    clean(&door, &[&door.cli_token, &door.backend_token]);
}

#[tokio::test]
async fn garbage_on_the_wire_is_journalled_without_the_line_and_answered_plainly() {
    let door = door(DoorOptions::default());
    let reply = door.service.handle_line("this is not JSON, and carries a token: abcdefghijklmnopqrstuvwxyz012345").await;

    assert_eq!(reply, json!({ "ok": false, "error": "invalid JSON" }));

    let entry = door.journal.entries().pop().unwrap();

    assert_eq!((entry.reason.as_str(), entry.allowed), ("invalid JSON", false));
    assert!(!serde_json::to_string(&entry).unwrap().contains("abcdefghijklmnop"));
}
