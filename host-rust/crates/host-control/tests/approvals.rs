//! The approval broker, and the FC4 scenarios of `approval-failclosed.test.ts` (the agent loop's tests of the
//! same rule) run against the Rust host: an approval service that fails, throws, never answers or is
//! abandoned means the tool does not run. Plus what is new here: one prompt at a time, the host as the only
//! authority, and a prompt withdrawn when its request is.

mod common;

use common::{Door, DoorOptions, contracts, door};
use host_control::broker::{ApprovalBroker, BrokerEvent, BrokerObserver, ChannelPrompter, Prompter};
use host_control::gate::{ApprovalAsk, BoxFuture};
use host_control::wire::serve_connection;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Default)]
struct Seen(Mutex<Vec<BrokerEvent>>);

impl BrokerObserver for Seen {
    fn event(&self, event: &BrokerEvent) {
        self.0.lock().unwrap().push(event.clone());
    }
}

impl Seen {
    fn count(&self, pick: impl Fn(&BrokerEvent) -> bool) -> usize {
        self.0.lock().unwrap().iter().filter(|e| pick(e)).count()
    }
}

struct Rig {
    door: Door,
    prompter: Arc<ChannelPrompter>,
    asks: tokio::sync::mpsc::UnboundedReceiver<ApprovalAsk>,
    broker: Arc<ApprovalBroker>,
    seen: Arc<Seen>,
}

fn rig(timeout: Option<Duration>) -> Rig {
    let (prompter, asks) = ChannelPrompter::new();
    let prompter = Arc::new(prompter);
    let seen = Arc::new(Seen::default());
    let broker = ApprovalBroker::new(prompter.clone(), Some(seen.clone()));
    let door = door(DoorOptions { approve: Some(broker.provider()), approval_timeout: timeout, ..DoorOptions::default() });

    Rig { door, prompter, asks, broker, seen }
}

fn add(token: &str, text: &str) -> Value {
    json!({ "cmd": "run", "token": token, "command": "memory.add", "args": { "text": text }, "source": "agent", "requestId": "r1" })
}

async fn send(door: &Door, request: Value) -> Value {
    door.service.handle_line(&request.to_string()).await
}

fn calls(door: &Door) -> usize {
    door.executor.calls.lock().unwrap().len()
}

async fn next_ask(asks: &mut tokio::sync::mpsc::UnboundedReceiver<ApprovalAsk>) -> ApprovalAsk {
    tokio::time::timeout(Duration::from_secs(5), asks.recv()).await.expect("an ask within 5 s").expect("the channel is open")
}

#[tokio::test]
async fn the_person_says_yes_through_the_host_window_and_the_call_runs_once() {
    let mut rig = rig(None);
    let token = rig.door.cli_token.clone();
    let service = rig.door.service.clone();
    let asking = tokio::spawn({
        let request = add(&token, "likes tea");

        async move { service.handle_line(&request.to_string()).await }
    });
    let ask = next_ask(&mut rig.asks).await;

    // The window shows who asked and what for; the preview is for the person's eyes.
    assert_eq!((ask.source.as_deref(), ask.client, ask.tier.as_str()), (Some("agent"), host_control::types::Client::Cli, "mutate"));
    assert!(ask.summary.contains("memory.add") && ask.preview.as_deref().is_some_and(|p| p.contains("likes tea")));
    assert!(rig.broker.is_open());
    assert!(rig.prompter.answer(&ask.id, true));

    let granted = asking.await.unwrap();

    assert_eq!(granted["code"], "approval-granted");
    assert!(!rig.broker.is_open(), "the slot is free again");

    // The capability the host minted spends once.
    let mut spend = add(&token, "likes tea");

    spend["capability"] = granted["capability"]["id"].clone();

    assert_eq!(send(&rig.door, spend).await["ok"], true);
    assert_eq!(calls(&rig.door), 1);

    // The preview is shown to the person and never written to the journal.
    let journal: Value = serde_json::to_value(rig.door.journal.entries().iter().map(common::entry_json).collect::<Vec<_>>()).unwrap();

    assert!(!journal.to_string().contains("likes tea"));
    common::assert_journal_clean(&contracts(), &rig.door.journal, &[&token, &rig.door.backend_token]);
}

#[tokio::test]
async fn a_no_leaves_the_tool_unexecuted_and_a_yes_is_the_witness() {
    let mut rig = rig(None);
    let token = rig.door.cli_token.clone();
    let service = rig.door.service.clone();
    let request = add(&token, "x");
    let refused = tokio::spawn({
        let (service, request) = (service.clone(), request.clone());

        async move { service.handle_line(&request.to_string()).await }
    });
    let ask = next_ask(&mut rig.asks).await;

    rig.prompter.answer(&ask.id, false);

    let reply = refused.await.unwrap();

    assert_eq!(reply["code"], "denied-approval");
    assert_eq!(calls(&rig.door), 0);

    // The witness: the same call, approved, does go through.
    let allowed = tokio::spawn(async move { service.handle_line(&request.to_string()).await });
    let ask = next_ask(&mut rig.asks).await;

    rig.prompter.answer(&ask.id, true);

    assert_eq!(allowed.await.unwrap()["code"], "approval-granted");
}

struct Panics {
    synchronously: bool,
}

impl Prompter for Panics {
    fn prompt(&self, _ask: ApprovalAsk) -> BoxFuture<bool> {
        if self.synchronously {
            panic!("the approval service threw before returning anything");
        }

        Box::pin(async { panic!("the approval service rejected") })
    }
}

#[tokio::test]
async fn fc4_an_approval_service_that_rejects_or_throws_means_the_tool_does_not_run() {
    for synchronously in [false, true] {
        let broker = ApprovalBroker::new(Arc::new(Panics { synchronously }), None);
        let door = door(DoorOptions { approve: Some(broker.provider()), ..DoorOptions::default() });
        let reply = send(&door, add(&door.cli_token, "x")).await;

        assert_eq!(reply["code"], "denied-approval", "synchronously={synchronously}: {reply}");
        assert_eq!(calls(&door), 0);
        assert!(!broker.is_open(), "a prompter that blew up does not leave the slot taken");

        // The connection that carried it is still served: the turn goes to its end without an exception.
        assert_eq!(send(&door, json!({ "cmd": "state", "token": door.cli_token })).await["ok"], true);
    }
}

#[tokio::test]
async fn fc4_an_approval_service_that_never_answers_is_a_no_and_its_prompt_is_withdrawn() {
    let mut rig = rig(Some(Duration::from_millis(80)));
    let token = rig.door.cli_token.clone();
    let reply = send(&rig.door, add(&token, "x")).await;
    let ask = next_ask(&mut rig.asks).await;

    assert_eq!(reply["code"], "denied-approval");
    assert_eq!(calls(&rig.door), 0);

    // The prompt was taken down with the request, and the slot is free for the next one.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(rig.prompter.cancelled().contains(&ask.id), "the window was told to withdraw it");
    assert!(!rig.broker.is_open());
    assert!(!rig.prompter.answer(&ask.id, true), "a late yes to a withdrawn prompt is ignored");
    assert_eq!(rig.seen.count(|e| matches!(e, BrokerEvent::Cancelled { .. })), 1);
}

#[tokio::test]
async fn fc4_a_caller_that_goes_away_withdraws_the_prompt_it_was_waiting_on() {
    let mut rig = rig(None);
    let token = rig.door.cli_token.clone();
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let connection = tokio::spawn(serve_connection(server, rig.door.service.clone()));

    client.write_all(format!("{}\n", add(&token, "x")).as_bytes()).await.unwrap();

    let ask = next_ask(&mut rig.asks).await;

    assert!(rig.broker.is_open());

    // The caller hangs up while the person has not answered yet.
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), connection).await.expect("the connection ends").unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(rig.prompter.cancelled().contains(&ask.id), "the prompt of a caller that is gone is taken down");
    assert!(!rig.broker.is_open());
    assert!(!rig.prompter.answer(&ask.id, true));
    assert_eq!(calls(&rig.door), 0, "and a yes that arrives too late runs nothing");
}

#[tokio::test]
async fn one_prompt_at_a_time_and_a_second_request_is_denied_not_queued() {
    let mut rig = rig(None);
    let token = rig.door.cli_token.clone();
    let mut tasks = Vec::new();

    for number in 0..8 {
        let service = rig.door.service.clone();
        let mut request = add(&token, &format!("text {number}"));

        request["requestId"] = json!(format!("c{number}"));
        tasks.push(tokio::spawn(async move { service.handle_line(&request.to_string()).await }));
    }

    // Exactly one reaches the person; the other seven are told no straight away.
    let ask = next_ask(&mut rig.asks).await;
    let mut denied = 0;
    let mut pending = Vec::new();

    for task in tasks {
        if task.is_finished() {
            let reply = task.await.unwrap();

            assert_eq!(reply["code"], "denied-approval");
            denied += 1;
        } else {
            pending.push(task);
        }
    }

    // Give the remaining ones a moment to be refused too.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(rig.asks.try_recv().is_err(), "no second prompt was ever shown");
    assert_eq!(rig.seen.count(|e| matches!(e, BrokerEvent::Asked { .. })), 1);
    assert_eq!(rig.seen.count(|e| matches!(e, BrokerEvent::Busy { .. })), 7);
    assert!(denied <= 7);

    rig.prompter.answer(&ask.id, true);

    let mut granted = 0;
    let mut refused = 0;

    for task in pending {
        match task.await.unwrap()["code"].as_str() {
            Some("approval-granted") => granted += 1,
            Some("denied-approval") => refused += 1,
            other => panic!("unexpected {other:?}"),
        }
    }

    assert_eq!(granted + denied + refused, 8);
    assert_eq!(granted, 1, "only the request that was shown to the person");

    // Once it is answered the slot is free, and the next request is asked.
    let service = rig.door.service.clone();
    let again = tokio::spawn(async move { service.handle_line(&add(&token, "next").to_string()).await });
    let next = next_ask(&mut rig.asks).await;

    assert_ne!(next.id, ask.id);
    rig.prompter.answer(&next.id, false);
    assert_eq!(again.await.unwrap()["code"], "denied-approval");
}

#[tokio::test]
async fn nothing_that_can_be_sent_to_the_host_answers_an_approval() {
    let mut rig = rig(None);
    let contracts = contracts();
    let matrix = &contracts.matrix;

    // No command of the matrix, on any door, is an answer.
    let all: Vec<&String> = matrix
        .backend_commands
        .iter()
        .chain(&matrix.registry_commands)
        .chain(&matrix.typed_registry_commands)
        .chain(&matrix.retired_commands)
        .chain(matrix.shell_commands.keys())
        .collect();

    assert!(all.iter().all(|name| !["approve", "answer", "grant", "allow", "confirm", "approval"].iter().any(|word| name.contains(word))), "{all:?}");

    for cmd in ["approve", "answer", "approval", "approvals.answer", "grant"] {
        for token in [&rig.door.cli_token, &rig.door.backend_token] {
            let reply = send(&rig.door, json!({ "cmd": cmd, "token": token, "command": "x", "args": ["yes"] })).await;

            assert_eq!(reply["ok"], false, "{cmd}: {reply}");
            assert!(matches!(reply["code"].as_str(), Some("unsupported") | Some("unauthorized")), "{cmd}: {reply}");
        }
    }

    // A request cannot carry its own approval: forged fields are ignored and the person is still asked.
    let token = rig.door.cli_token.clone();
    let service = rig.door.service.clone();
    let mut forged = add(&token, "x");

    forged["approved"] = json!(true);
    forged["approval"] = json!("ap_forged");
    forged["capability"] = json!("cap_AAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBB");

    let forged_reply = send(&rig.door, forged.clone()).await;

    assert_eq!(forged_reply["ok"], false, "{forged_reply}");
    assert_eq!(calls(&rig.door), 0);

    forged.as_object_mut().unwrap().remove("capability");

    let asking = tokio::spawn(async move { service.handle_line(&forged.to_string()).await });
    let ask = next_ask(&mut rig.asks).await;

    // The answer is the host's alone: an invented id, a repeated answer, an answer to nothing.
    assert!(!rig.prompter.answer("ask_invented", true));
    assert!(rig.prompter.answer(&ask.id, false));
    assert!(!rig.prompter.answer(&ask.id, true), "an answer counts once");
    assert_eq!(asking.await.unwrap()["code"], "denied-approval");
    assert_eq!(calls(&rig.door), 0);
}

#[tokio::test]
async fn a_window_that_is_gone_is_a_no() {
    let (prompter, asks) = ChannelPrompter::new();

    drop(asks);

    let broker = ApprovalBroker::new(Arc::new(prompter), None);
    let door = door(DoorOptions { approve: Some(broker.provider()), ..DoorOptions::default() });

    assert_eq!(send(&door, add(&door.cli_token, "x")).await["code"], "denied-approval");
    assert_eq!(calls(&door), 0);
    assert!(!broker.is_open());
}
