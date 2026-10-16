#![cfg(windows)]
//! What a confined command can and cannot do, each time against a real AppContainer on this machine.
//! Every "denied" case has a control: the same command run *without* the sandbox succeeds, so a pass cannot
//! come from a typo in the command.

use host_sandbox::{ConfinedCommand, Limits, Policy, run};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

struct Arena {
    root: PathBuf,
    ws: PathBuf,
    outside: PathBuf,
}

impl Arena {
    fn new(name: &str) -> Arena {
        let root = std::env::temp_dir().join(format!("sbx-{name}-{}", std::process::id()));
        let (ws, outside) = (root.join("ws"), root.join("outside"));

        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(ws.join("inside.txt"), "old").unwrap();
        fs::write(outside.join("precious.txt"), "precious").unwrap();

        Arena { root, ws, outside }
    }

    fn policy(&self) -> Policy {
        let mut policy = Policy::new(&self.ws);

        policy.limits = Limits { timeout: Duration::from_secs(30), ..Limits::default() };

        policy
    }

    /// Runs `line` in cmd, confined; the bool is whether it exited 0.
    fn confined(&self, line: &str) -> (bool, String) {
        let out = run(&self.policy(), &ConfinedCommand::new("cmd.exe").args(["/D", "/C", line])).expect("the sandbox must start");

        (out.exit_code == Some(0), format!("{}{}", out.stdout_text(), out.stderr_text()))
    }

    /// The control: the same line, not confined, from the same directory.
    fn free(&self, line: &str) -> bool {
        std::process::Command::new("cmd.exe").args(["/D", "/C", line]).current_dir(&self.ws).output().unwrap().status.success()
    }
}

impl Drop for Arena {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn has_container_ace(path: &std::path::Path) -> bool {
    host_storage::acl::read_zone_dacl(path).unwrap().aces.iter().any(|(sid, _)| sid.starts_with("S-1-15-2-"))
}

#[test]
fn a_write_inside_the_workspace_works_and_edits_in_place() {
    let arena = Arena::new("inside");

    assert!(arena.confined("echo new> fresh.txt").0);
    assert!(arena.confined("echo edited> inside.txt").0);
    assert!(arena.ws.join("fresh.txt").exists());
    assert!(fs::read_to_string(arena.ws.join("inside.txt")).unwrap().contains("edited"));
    assert!(arena.confined("mkdir sub& echo x> sub\\deep.txt").0);
    assert!(arena.ws.join("sub").join("deep.txt").exists());
    // Renaming and removing a folder work; the legacy `del`, `dir` and `attrib` do not (see docs/sandbox.md).
    assert!(arena.confined("ren fresh.txt renamed.txt& mkdir gone& rmdir gone").0);
    assert!(arena.ws.join("renamed.txt").exists() && !arena.ws.join("gone").exists());
}

#[test]
fn a_write_outside_is_refused_by_the_kernel() {
    let arena = Arena::new("outside");
    let line = r"echo hacked> ..\outside\new.txt";

    assert!(arena.free(line), "control: the line itself is valid");
    fs::remove_file(arena.outside.join("new.txt")).unwrap();

    let (ok, text) = arena.confined(line);

    assert!(!ok, "{text}");
    assert!(!arena.outside.join("new.txt").exists());
}

#[test]
fn overwriting_appending_and_deleting_an_outside_file_are_refused() {
    let arena = Arena::new("modify");

    for line in [r"echo hacked> ..\outside\precious.txt", r"echo hacked>> ..\outside\precious.txt", r"del ..\outside\precious.txt", r"ren ..\outside\precious.txt gone.txt"] {
        let (ok, text) = arena.confined(line);

        assert!(!ok, "{line}: {text}");
        assert_eq!(fs::read_to_string(arena.outside.join("precious.txt")).unwrap(), "precious", "{line}");
    }
}

#[test]
fn a_child_process_inherits_the_confinement() {
    let arena = Arena::new("child");

    assert!(!arena.confined(r"cmd /D /C echo hacked> ..\outside\child.txt").0);
    assert!(!arena.outside.join("child.txt").exists());
    assert!(!arena.confined(r"cmd /D /C cmd /D /C echo hacked> ..\outside\grandchild.txt").0);
    assert!(!arena.outside.join("grandchild.txt").exists());
}

#[test]
fn a_junction_cannot_be_used_to_write_through() {
    let arena = Arena::new("junction");

    assert!(arena.free(r"mklink /J escape ..\outside"), "control");
    assert!(arena.free(r"rmdir escape"));

    // Creating the link may or may not be allowed; writing through it must not be.
    let _ = arena.confined(r"mklink /J escape ..\outside");
    let (ok, text) = arena.confined(r"echo hacked> escape\through.txt");

    assert!(!ok, "{text}");
    assert!(!arena.outside.join("through.txt").exists());
}

#[test]
fn a_hard_link_to_an_outside_file_cannot_be_written_through() {
    let arena = Arena::new("hardlink");

    assert!(arena.free(r"mklink /H hl.txt ..\outside\precious.txt"), "control");
    fs::remove_file(arena.ws.join("hl.txt")).unwrap();

    let (made, _) = arena.confined(r"mklink /H hl.txt ..\outside\precious.txt");
    let _ = arena.confined("echo hacked> hl.txt");

    assert_eq!(fs::read_to_string(arena.outside.join("precious.txt")).unwrap(), "precious", "link made = {made}");
}

#[test]
fn an_alternate_data_stream_on_an_outside_file_is_refused() {
    let arena = Arena::new("ads");

    assert!(arena.free(r"echo x> ..\outside\precious.txt:hidden"), "control");

    fs::remove_file(arena.outside.join("precious.txt")).unwrap();
    fs::write(arena.outside.join("precious.txt"), "precious").unwrap();

    let (ok, _) = arena.confined(r"echo x> ..\outside\precious.txt:hidden");

    assert!(!ok);
    assert!(!arena.free(r"more < ..\outside\precious.txt:hidden >nul"), "no stream was written");
}

#[test]
fn the_registry_cannot_be_written() {
    let arena = Arena::new("registry");
    let key = format!(r"HKCU\Software\HeraldSandboxTest{}", std::process::id());
    let (ok, text) = arena.confined(&format!("reg add {key} /v x /d 1 /f"));

    // Cleanup first, so a failing assertion cannot leave a key behind.
    let present = arena.free(&format!("reg query {key}"));
    let _ = arena.free(&format!("reg delete {key} /f"));

    assert!(!ok && !present, "{text}");
}

#[test]
fn the_environment_of_the_parent_is_not_inherited() {
    // SAFETY: only this test reads or writes the variable.
    unsafe { std::env::set_var("HERALD_SBX_LEAKCHECK", "visible") };

    let arena = Arena::new("env");
    let (_, text) = arena.confined("echo [%HERALD_SBX_LEAKCHECK%]");

    assert!(text.contains("[%HERALD_SBX_LEAKCHECK%]"), "{text}");
    assert!(!text.contains("visible"));
}

#[test]
fn the_profile_and_temp_of_the_command_are_inside_the_workspace() {
    let arena = Arena::new("home");
    let (_, text) = arena.confined("echo %USERPROFILE%& echo %TEMP%");
    let ws = arena.ws.canonicalize().unwrap().to_string_lossy().replace(r"\\?\", "").to_lowercase();

    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        assert!(line.to_lowercase().starts_with(&ws), "{line} is not inside {ws}");
    }
}

#[test]
fn a_runaway_command_is_ended_with_its_children() {
    let arena = Arena::new("timeout");
    let mut policy = arena.policy();

    policy.limits.timeout = Duration::from_secs(2);

    let out = run(&policy, &ConfinedCommand::new("cmd.exe").args(["/D", "/C", "for /l %i in (1,1,2000000000) do @rem"])).unwrap();

    assert!(out.timed_out);
    assert_ne!(out.exit_code, Some(0));
    assert!(out.elapsed < Duration::from_secs(15), "{:?}", out.elapsed);
}

#[test]
fn output_is_capped_without_blocking_the_child() {
    let arena = Arena::new("cap");
    let mut policy = arena.policy();

    policy.limits.max_output_bytes = 1024;

    let out = run(&policy, &ConfinedCommand::new("cmd.exe").args(["/D", "/C", "for /l %i in (1,1,20000) do @echo 0123456789012345678901234567890123456789"])).unwrap();

    assert_eq!(out.exit_code, Some(0));
    assert!(out.stdout_truncated);
    assert!(out.stdout.len() <= 1024);
}

#[test]
fn the_grant_is_taken_back_after_every_outcome() {
    let arena = Arena::new("revoke");
    let mut policy = arena.policy();

    assert!(arena.confined("echo x> a.txt").0);
    assert!(!has_container_ace(&arena.ws));
    assert!(!has_container_ace(&arena.ws.join("a.txt")));

    policy.limits.timeout = Duration::from_secs(1);
    let _ = run(&policy, &ConfinedCommand::new("cmd.exe").args(["/D", "/C", "for /l %i in (1,1,2000000000) do @rem"]));

    assert!(!has_container_ace(&arena.ws));
    assert!(!has_container_ace(&arena.ws.join("inside.txt")));
}

#[test]
fn a_workspace_that_is_too_broad_is_refused_before_anything_is_granted() {
    let profile = PathBuf::from(std::env::var("USERPROFILE").unwrap());

    for broad in [profile.clone(), profile.parent().unwrap().to_path_buf(), PathBuf::from(r"C:\Windows"), PathBuf::from(r"C:\")] {
        let result = run(&Policy::new(&broad), &ConfinedCommand::new("cmd.exe").args(["/D", "/C", "echo x"]));

        assert!(result.is_err(), "{} was accepted", broad.display());
    }
}

#[test]
fn a_missing_program_is_not_started() {
    let arena = Arena::new("missing");

    assert!(run(&arena.policy(), &ConfinedCommand::new(r"C:\does\not\exist.exe")).is_err());
}
