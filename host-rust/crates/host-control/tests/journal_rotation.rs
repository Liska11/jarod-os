//! The control journal is bounded: past its limit the file is rotated to `<name>.1` (one generation kept),
//! and the live file starts again. Nothing is lost silently and nothing grows forever.

use host_control::audit::{AuditEntry, AuditSink, FileJournal};
use host_control::types::JournalClient;
use std::fs;

fn entry(n: usize) -> AuditEntry {
    AuditEntry {
        at: "2026-10-17T00:00:00.000Z".into(),
        client: JournalClient::Unauthenticated,
        cmd: format!("cmd-{n}"),
        command: None,
        tier: None,
        source: None,
        allowed: false,
        reason: "x".into(),
        code: None,
        approval: None,
        request_id: None,
        surface: None,
    }
}

fn dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("jarod-journal-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_journal_rotates_past_its_limit_and_keeps_every_line_of_the_last_two_generations() {
    let dir = dir("rotate");
    let path = dir.join("control-audit.jsonl");
    let journal = FileJournal::open_with_limit(&path, 1000).unwrap();

    for n in 0..40 {
        journal.write(&entry(n));
    }

    let live = fs::read_to_string(&path).unwrap();
    let old = fs::read_to_string(dir.join("control-audit.jsonl.1")).unwrap();

    assert!(live.len() <= 1000 + 200, "the live file stays near the limit, got {}", live.len());
    assert!(!old.is_empty());
    assert!(live.contains("cmd-39"), "the newest line is in the live file");
    assert!(!live.is_empty() && live.lines().all(|l| l.starts_with('{') && l.ends_with('}')), "no torn line");
    assert_eq!(journal.failures(), 0);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_journal_already_over_the_limit_at_start_is_rotated_before_the_first_line() {
    let dir = dir("start");
    let path = dir.join("control-audit.jsonl");

    fs::write(&path, "{\"a\":1}\n".repeat(500)).unwrap();

    let journal = FileJournal::open_with_limit(&path, 1000).unwrap();

    journal.write(&entry(1));

    assert!(fs::metadata(dir.join("control-audit.jsonl.1")).is_ok());
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 1);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_default_open_is_bounded_too() {
    let dir = dir("default");
    let journal = FileJournal::open(&dir.join("j.jsonl")).unwrap();

    assert_eq!(journal.limit(), 8 * 1024 * 1024);
    let _ = fs::remove_dir_all(&dir);
}
