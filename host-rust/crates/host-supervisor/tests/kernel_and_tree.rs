#![cfg(windows)]
//! Two proofs that need a whole program rather than a script:
//!
//! 1. the host's process tree really dies with the host (the supervisor is run as its own process and
//!    killed from outside), and the command refuses what it must refuse;
//! 2. the **current Cordis kernel** (`jarod-core/dist/gateway/gateway.mjs`, the same file Electron launches)
//!    starts under the Rust supervisor, on a throwaway profile, answers its status route, and stops cleanly.

use host_control::contracts::Contracts;
use host_supervisor::{ChildEnv, ChildSpec, HealthRule, NullLog, NullObserver, ReadyRule, RestartPolicy, State, Supervisor, WINDOWS_ESSENTIALS, control_env_names};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("host-supervisor-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn contracts_dir() -> PathBuf {
    repo().join("contracts/v1")
}

fn node() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join("node.exe")).find(|candidate| candidate.exists())
}

fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: a query-only handle, closed before returning; the exit code out pointer is valid.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);

        if handle.is_null() {
            return false;
        }

        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);

        CloseHandle(handle);

        ok != 0 && code == 259
    }
}

fn wait_until(what: &str, timeout: Duration, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();

    while !condition() {
        assert!(started.elapsed() < timeout, "timed out waiting for {what}");

        std::thread::sleep(Duration::from_millis(50));
    }
}

const SUPERVISE: &str = env!("CARGO_BIN_EXE_jarod-supervise");

fn supervise(args: &[&str]) -> Command {
    let mut command = Command::new(SUPERVISE);

    command.env("JAROD_OS_CONTRACTS_DIR", contracts_dir()).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    command
}

#[test]
fn killing_the_host_takes_the_whole_process_tree_with_it() {
    let Some(node) = node() else {
        println!("skipped: no node.exe on PATH");

        return;
    };
    let dir = scratch("host-death");
    let pid_file = dir.join("grandchild.pid");
    let body = format!(
        "const {{ spawn }} = require('child_process'); const fs = require('fs');\n\
         const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], {{ stdio: 'ignore' }});\n\
         fs.writeFileSync({pid:?}, String(grandchild.pid));\n\
         console.log('READY port=7'); process.stdin.resume(); setInterval(() => {{}}, 1000);",
        pid = pid_file.to_string_lossy()
    );
    let script = dir.join("tree.js");

    fs::write(&script, body).unwrap();

    let mut host = supervise(&["--name", "tree", "--ready-prefix", "READY port=", "--grace-ms", "300", "--"]).arg(&node).arg(&script).spawn().unwrap();
    let mut stdout = BufReader::new(host.stdout.take().unwrap());
    let mut child_pid = 0u32;

    for _ in 0..50 {
        let mut line = String::new();

        if stdout.read_line(&mut line).unwrap() == 0 {
            break;
        }

        if let Some(rest) = line.trim().strip_prefix("STATE running pid=") {
            child_pid = rest.split_whitespace().next().unwrap().parse().unwrap();

            break;
        }
    }

    assert!(child_pid > 0, "the supervisor announced the child");
    wait_until("the grandchild's pid", Duration::from_secs(10), || pid_file.exists());

    let grandchild: u32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();

    assert!(alive(child_pid) && alive(grandchild));

    // The host is killed from outside, as a crash or a task manager would: no chance to clean up.
    host.kill().unwrap();
    let _ = host.wait();

    wait_until("the tree to end after the host died", Duration::from_secs(10), || !alive(child_pid) && !alive(grandchild));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn closing_the_supervisors_stdin_stops_the_child_and_ends_it_cleanly() {
    let Some(node) = node() else {
        println!("skipped: no node.exe on PATH");

        return;
    };
    let dir = scratch("stdin-close");
    let script = dir.join("ready.js");

    fs::write(&script, "console.log('READY port=4242'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);").unwrap();

    let mut host = supervise(&["--name", "ready", "--ready-prefix", "READY port=", "--"]).arg(&node).arg(&script).spawn().unwrap();
    let mut stdin = host.stdin.take().unwrap();
    let mut stdout = BufReader::new(host.stdout.take().unwrap());
    let mut running = None;
    let mut seen = String::new();

    for _ in 0..50 {
        let mut line = String::new();

        if stdout.read_line(&mut line).unwrap() == 0 {
            break;
        }

        seen.push_str(&line);

        if let Some(rest) = line.trim().strip_prefix("STATE running pid=") {
            running = Some(rest.split_whitespace().next().unwrap().parse::<u32>().unwrap());

            break;
        }
    }

    let pid = running.unwrap_or_else(|| panic!("no running line: {seen}"));

    assert!(seen.contains("port=") || alive(pid));
    stdin.flush().unwrap();
    drop(stdin);

    let mut rest = String::new();

    stdout.read_to_string(&mut rest).unwrap();

    let status = host.wait().unwrap();

    assert!(status.success(), "{rest}");
    assert!(rest.contains("STATE stopped"), "{rest}");
    wait_until("the child to be gone", Duration::from_secs(5), || !alive(pid));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_command_refuses_what_it_must_refuse() {
    let run = |args: &[&str]| -> (Option<i32>, String, String) {
        let output = supervise(args).output().unwrap();

        (output.status.code(), String::from_utf8_lossy(&output.stdout).to_string(), String::from_utf8_lossy(&output.stderr).to_string())
    };

    // No command, no ready rule, an unknown option, a number that is not one.
    for args in
        [&["--ready-prefix", "R"][..], &["--name", "x", "--", "node.exe"], &["--bogus", "1", "--", "node.exe"], &["--ready-prefix", "R", "--grace-ms", "soon", "--", "node.exe"]]
    {
        let (code, stdout, stderr) = run(args);

        assert_eq!(code, Some(2), "{args:?}: {stderr}");
        assert!(stdout.is_empty(), "nothing is announced: {stdout}");
    }

    // A control variable is granted, never set; only a name the contract lists can be granted.
    let (code, _, stderr) = run(&["--ready-prefix", "R", "--set", "JAROD_GATEWAY_TOKEN=x", "--", "node.exe"]);

    assert_eq!(code, Some(2));
    assert!(stderr.contains("grant_control"), "{stderr}");

    let (code, _, stderr) = run(&["--ready-prefix", "R", "--grant", "PATH=x", "--", "node.exe"]);

    assert_eq!(code, Some(2));
    assert!(stderr.contains("not a control variable"), "{stderr}");

    // Without the contracts folder, the command does not run at all (no built-in copy of the C5 list).
    let mut no_contracts = Command::new(SUPERVISE);

    no_contracts.env_remove("JAROD_OS_CONTRACTS_DIR").args(["--ready-prefix", "R", "--", "node.exe"]);

    let output = no_contracts.output().unwrap();

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("contracts"));
}

/// The first file called `name` anywhere under `dir`.
fn find(dir: &Path, name: &str) -> Option<PathBuf> {
    for item in fs::read_dir(dir).ok()?.flatten() {
        let path = item.path();

        if path.file_name().is_some_and(|n| n == name) {
            return Some(path);
        }

        if path.is_dir()
            && let Some(found) = find(&path, name)
        {
            return Some(found);
        }
    }

    None
}

fn http_get(port: u16, path: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();

    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).unwrap();

    let mut response = String::new();

    stream.read_to_string(&mut response).unwrap();

    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);

    (status, body.to_string())
}

/// The current kernel, started by the Rust supervisor on a throwaway profile.
#[tokio::test]
async fn the_current_cordis_kernel_starts_under_the_rust_supervisor_and_stops_cleanly() {
    let gateway = repo().join("jarod-core/dist/gateway/gateway.mjs");
    let Some(node) = node() else {
        println!("skipped: no node.exe on PATH");

        return;
    };

    if !gateway.exists() {
        println!("skipped: {} is not built (pnpm run build in jarod-core)", gateway.display());

        return;
    }

    let root = scratch("kernel");
    let (profile, workspace, appdata) = (root.join("profile"), root.join("workspace"), root.join("appdata"));

    for dir in [&profile, &workspace, &appdata] {
        fs::create_dir_all(dir).unwrap();
    }

    // The kernel's own files are all under `root`: nothing of the real profile, the real AppData or the real
    // workspace is visible to it.
    let contracts = Contracts::load(&contracts_dir()).unwrap();
    let names = control_env_names(&contracts).unwrap();
    let parent: Vec<(String, String)> = std::env::vars().chain([("JAROD_OS_CONTROL_TOKEN".to_string(), "PARENT-CONTROL-TOKEN-0123456789".to_string())]).collect();
    let gateway_token = "gateway-token-minted-by-the-host-0123456789";
    let env = ChildEnv::new(&names)
        .inherit_allowlisted(&parent, WINDOWS_ESSENTIALS)
        .set("JAROD_HOME", &profile.to_string_lossy())
        .unwrap()
        .set("JAROD_WORKSPACE", &workspace.to_string_lossy())
        .unwrap()
        .set("APPDATA", &appdata.to_string_lossy())
        .unwrap()
        .set("LOCALAPPDATA", &appdata.to_string_lossy())
        .unwrap()
        .set("TEMP", &appdata.to_string_lossy())
        .unwrap()
        .set("TMP", &appdata.to_string_lossy())
        .unwrap()
        .grant_control("JAROD_GATEWAY_TOKEN", gateway_token)
        .unwrap();
    let spec = ChildSpec {
        name: "cordis".into(),
        program: node,
        args: vec![gateway.into_os_string(), "--init".into(), "--exit-on-stdin-close".into(), "--workspace".into(), workspace.clone().into_os_string()],
        cwd: Some(repo().join("jarod-core/dist/gateway")),
        env,
        ready: ReadyRule { prefix: "HERMES_BACKEND_READY port=".into() },
        ready_timeout: Duration::from_secs(90),
        health: Some(HealthRule {
            path: "/api/status".into(),
            field: Some(("status".into(), "ok".into())),
            interval: Duration::from_secs(2),
            timeout: Duration::from_secs(5),
            failures: 3,
        }),
        grace: Duration::from_secs(20),
        restart: RestartPolicy::never(),
    };
    let mut supervisor = Supervisor::spawn(spec, Arc::new(NullObserver), Arc::new(NullLog), Arc::new(Vec::new));
    let State::Running { pid, port } = supervisor.wait_running(Duration::from_secs(100)).await.unwrap_or_else(|why| panic!("the kernel did not start: {why}")) else {
        panic!("not running")
    };
    let port = port.expect("the kernel announces its port");

    // The kernel answers its public status route: this is the probe the Electron shell uses today.
    let (status, body) = tokio::task::spawn_blocking(move || http_get(port, "/api/status")).await.unwrap();

    assert_eq!(status, 200, "{body}");

    let json: serde_json::Value = serde_json::from_str(body.trim()).unwrap();

    assert_eq!((json["status"].as_str(), json["backend"].as_str()), (Some("ok"), Some("jarod")), "{body}");

    // It opened the profile it was given and nothing else: the data is under the throwaway root.
    assert!(fs::read_dir(&profile).unwrap().count() > 0, "the kernel wrote its profile where it was told");
    let listing = fs::read_dir(&profile).unwrap().flatten().map(|e| e.path().display().to_string()).collect::<Vec<_>>();
    assert!(find(&profile, "gateway.json").is_some(), "its gateway file, which it removes when it stops: {listing:?}");

    supervisor.stop().await;

    assert!(!alive(pid), "the kernel is gone");
    assert!(find(&profile, "gateway.json").is_none(), "a clean stop: the kernel removed the token file it had written");
    let _ = fs::remove_dir_all(&root);
    let _ = Path::new("");
}
