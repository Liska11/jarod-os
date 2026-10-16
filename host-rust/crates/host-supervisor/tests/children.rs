#![cfg(windows)]
//! The supervisor against real child processes (Node, one small script per behaviour): ready, graceful
//! stop, a child that ignores the polite stop, a whole process tree, a crash loop, a child that never says
//! it is ready, a health probe that fails, a program that does not exist, and output that carries a token.

use host_control::contracts::Contracts;
use host_control::secrets::{Secret, SecretKind};
use host_supervisor::{ChildEnv, ChildSpec, Event, HealthRule, LogSink, Observer, ReadyRule, RestartPolicy, State, Stream, Supervisor, WINDOWS_ESSENTIALS, control_env_names};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("host-supervisor-{name}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&dir);

    fs::create_dir_all(&dir).unwrap();

    dir
}

fn contracts() -> Contracts {
    Contracts::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/v1")).unwrap()
}

fn node() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|dir| dir.join("node.exe")).find(|candidate| candidate.exists()).expect("node.exe on PATH")
}

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);

    fs::write(&path, body).unwrap();

    path
}

fn parent_env() -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = std::env::vars().collect();

    // A parent that is carrying authority and a provider key, to prove none of it reaches the child.
    vars.push(("HERALD_OS_CONTROL_TOKEN".into(), "PARENT-CONTROL-TOKEN-0123456789".into()));
    vars.push(("herald_os_cli_token".into(), "PARENT-CLI-TOKEN-0123456789".into()));
    vars.push(("JAROD_GATEWAY_TOKEN".into(), "PARENT-GATEWAY-TOKEN-0123456789".into()));
    vars.push(("OPENAI_API_KEY".into(), "sk-parent-provider-key-0123456789".into()));

    vars
}

fn base_env() -> ChildEnv {
    let names = control_env_names(&contracts()).unwrap();

    ChildEnv::new(&names).inherit_allowlisted(&parent_env(), WINDOWS_ESSENTIALS)
}

fn spec(dir: &Path, file: &str, env: ChildEnv) -> ChildSpec {
    ChildSpec {
        name: file.into(),
        program: node(),
        args: vec![script(dir, file, "").into_os_string()],
        cwd: Some(dir.to_path_buf()),
        env,
        ready: ReadyRule { prefix: "READY port=".into() },
        ready_timeout: Duration::from_secs(10),
        health: None,
        grace: Duration::from_millis(1500),
        restart: RestartPolicy::never(),
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<Event>>);

impl Observer for Events {
    fn event(&self, _name: &str, event: &Event) {
        self.0.lock().unwrap().push(event.clone());
    }
}

impl Events {
    fn all(&self) -> Vec<Event> {
        self.0.lock().unwrap().clone()
    }

    fn count(&self, matches: impl Fn(&Event) -> bool) -> usize {
        self.all().iter().filter(|e| matches(e)).count()
    }
}

#[derive(Default)]
struct Lines(Mutex<Vec<(Stream, String)>>);

impl LogSink for Lines {
    fn line(&self, _name: &str, stream: Stream, line: &str) {
        self.0.lock().unwrap().push((stream, line.to_string()));
    }
}

impl Lines {
    fn text(&self) -> String {
        self.0.lock().unwrap().iter().map(|(_, l)| l.clone()).collect::<Vec<_>>().join("\n")
    }
}

fn start(spec: ChildSpec, secrets: Vec<Secret>) -> (Supervisor, Arc<Events>, Arc<Lines>) {
    let events = Arc::new(Events::default());
    let lines = Arc::new(Lines::default());
    let supervisor = Supervisor::spawn(spec, events.clone(), lines.clone(), Arc::new(move || secrets.clone()));

    (supervisor, events, lines)
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

async fn eventually(what: &str, timeout: Duration, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();

    while !condition() {
        assert!(started.elapsed() < timeout, "timed out waiting for {what}");

        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

const READY_THEN_WAIT: &str = "console.log('READY port=4242'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);";

#[test]
fn the_environment_probe_child_sees_no_control_name_it_was_not_granted() {
    // Run on the real Windows environment of this machine plus the poisoned parent above.
    let env = base_env().set("HOST_TEST_VALUE", "visible").unwrap().grant_control("jarod_gateway_token", "granted-gateway-token-0123456789").unwrap();
    let names: Vec<&String> = env.vars().keys().collect();

    assert!(names.iter().any(|n| n.as_str() == "JAROD_GATEWAY_TOKEN"), "the one granted name is there");
    assert!(!names.iter().any(|n| n.eq_ignore_ascii_case("HERALD_OS_CONTROL_TOKEN") || n.eq_ignore_ascii_case("HERALD_OS_CLI_TOKEN")), "{names:?}");
    assert!(!names.iter().any(|n| n.as_str() == "OPENAI_API_KEY"), "a provider key is not plumbing");
    assert_eq!(env.vars()["JAROD_GATEWAY_TOKEN"], "granted-gateway-token-0123456789", "the granted value, not the parent's");
}

#[tokio::test]
async fn a_real_child_gets_exactly_the_environment_it_was_built() {
    let dir = scratch("envprobe");
    let probe = "console.log('ENV ' + JSON.stringify(Object.keys(process.env).sort())); console.log('READY port=4242'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);";
    let mut s = spec(&dir, "env-probe.js", base_env().set("HOST_TEST_VALUE", "visible").unwrap().grant_control("JAROD_GATEWAY_TOKEN", "granted-gateway-token-0123456789").unwrap());

    s.args = vec![script(&dir, "env-probe.js", probe).into_os_string()];

    let (mut supervisor, _events, lines) = start(s, vec![]);

    supervisor.wait_running(Duration::from_secs(15)).await.unwrap();
    eventually("the environment line", Duration::from_secs(5), || lines.text().contains("ENV ")).await;

    let line = lines.text().lines().find(|l| l.starts_with("ENV ")).unwrap().to_string();
    let seen: Vec<String> = serde_json::from_str(&line[4..]).unwrap();
    let upper: Vec<String> = seen.iter().map(|n| n.to_ascii_uppercase()).collect();

    assert!(upper.contains(&"JAROD_GATEWAY_TOKEN".to_string()) && upper.contains(&"HOST_TEST_VALUE".to_string()) && upper.contains(&"SYSTEMROOT".to_string()), "{seen:?}");

    for forbidden in ["HERALD_OS_CONTROL_TOKEN", "HERALD_OS_CLI_TOKEN", "HERMES_OS_CONTROL_TOKEN", "HERALD_OS_CONTROL_SOCKET", "OPENAI_API_KEY"] {
        assert!(!upper.contains(&forbidden.to_string()), "{forbidden} reached the child: {seen:?}");
    }

    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn ready_then_a_polite_stop_ends_the_child_without_force() {
    let dir = scratch("ready");
    let mut s = spec(&dir, "ready.js", base_env());

    s.args = vec![script(&dir, "ready.js", READY_THEN_WAIT).into_os_string()];

    let (mut supervisor, events, _lines) = start(s, vec![]);
    let State::Running { pid, port } = supervisor.wait_running(Duration::from_secs(15)).await.unwrap() else { panic!("not running") };

    assert_eq!(port, Some(4242));
    assert!(alive(pid));

    supervisor.stop().await;

    assert!(!alive(pid));
    assert_eq!(events.count(|e| matches!(e, Event::Stopped { graceful: true })), 1, "{:?}", events.all());
    assert_eq!(events.count(|e| matches!(e, Event::Started { .. })), 1, "a deliberate stop is never restarted");
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_child_that_ignores_the_polite_stop_is_ended_after_the_grace_period() {
    let dir = scratch("stubborn");
    let mut s = spec(&dir, "stubborn.js", base_env());

    s.grace = Duration::from_millis(600);
    s.args = vec![script(&dir, "stubborn.js", "console.log('READY port=1'); process.stdin.resume(); setInterval(() => {}, 1000);").into_os_string()];

    let (mut supervisor, events, _lines) = start(s, vec![]);
    let State::Running { pid, .. } = supervisor.wait_running(Duration::from_secs(15)).await.unwrap() else { panic!("not running") };
    let began = Instant::now();

    supervisor.stop().await;

    assert!(began.elapsed() >= Duration::from_millis(550), "it was given its grace period");
    assert!(began.elapsed() < Duration::from_secs(10));
    assert!(!alive(pid));
    assert_eq!(events.count(|e| matches!(e, Event::Stopped { graceful: false })), 1, "{:?}", events.all());
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_whole_process_tree_goes_with_the_child() {
    let dir = scratch("tree");
    let pid_file = dir.join("grandchild.pid");
    let body = format!(
        "const {{ spawn }} = require('child_process'); const fs = require('fs');\n\
         const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], {{ stdio: 'ignore' }});\n\
         fs.writeFileSync({pid:?}, String(grandchild.pid));\n\
         console.log('READY port=7'); process.stdin.resume(); setInterval(() => {{}}, 1000);",
        pid = pid_file.to_string_lossy()
    );
    let mut s = spec(&dir, "tree.js", base_env());

    s.grace = Duration::from_millis(300);
    s.args = vec![script(&dir, "tree.js", &body).into_os_string()];

    let (mut supervisor, _events, _lines) = start(s, vec![]);
    let State::Running { pid, .. } = supervisor.wait_running(Duration::from_secs(15)).await.unwrap() else { panic!("not running") };

    eventually("the grandchild's pid", Duration::from_secs(5), || pid_file.exists()).await;

    let grandchild: u32 = fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();

    assert!(alive(pid) && alive(grandchild), "both are running");

    supervisor.stop().await;

    eventually("the tree to end", Duration::from_secs(5), || !alive(pid) && !alive(grandchild)).await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_crashing_child_is_restarted_with_a_backoff_and_then_given_up_on() {
    let dir = scratch("crash");
    let mut s = spec(&dir, "crash.js", base_env());

    s.restart = RestartPolicy { max_restarts: 2, window: Duration::from_secs(60), backoff_initial: Duration::from_millis(50), backoff_max: Duration::from_millis(400) };
    s.args = vec![script(&dir, "crash.js", "console.log('READY port=9'); setTimeout(() => process.exit(3), 150);").into_os_string()];

    let (mut supervisor, events, _lines) = start(s, vec![]);
    let state = supervisor.wait_for(|s| matches!(s, State::Failed(_)), Duration::from_secs(30)).await.unwrap();

    let State::Failed(reason) = state else { panic!() };

    assert!(reason.contains("exited with 3") && reason.contains("not restarting"), "{reason}");
    assert_eq!(events.count(|e| matches!(e, Event::Started { .. })), 3, "the first start and two restarts: {:?}", events.all());
    assert_eq!(events.count(|e| matches!(e, Event::Exited { code: Some(3), unexpected: true })), 3);
    assert_eq!(events.count(|e| matches!(e, Event::Restarting { .. })), 2);
    assert_eq!(events.count(|e| matches!(e, Event::GaveUp { .. })), 1);

    // The backoff grew: 50 ms, then 100 ms.
    let waits: Vec<Duration> = events.all().into_iter().filter_map(|e| if let Event::Restarting { wait, .. } = e { Some(wait) } else { None }).collect();

    assert_eq!(waits, vec![Duration::from_millis(50), Duration::from_millis(100)]);
    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_child_that_never_says_it_is_ready_is_ended_and_reported() {
    let dir = scratch("never");
    let mut s = spec(&dir, "never.js", base_env());

    s.ready_timeout = Duration::from_millis(700);
    s.args = vec![script(&dir, "never.js", "setInterval(() => {}, 1000);").into_os_string()];

    let (mut supervisor, events, _lines) = start(s, vec![]);
    let State::Failed(reason) = supervisor.wait_for(|s| matches!(s, State::Failed(_)), Duration::from_secs(15)).await.unwrap() else { panic!() };

    assert!(reason.contains("not ready"), "{reason}");
    assert_eq!(events.count(|e| matches!(e, Event::ReadyTimeout)), 1);
    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_program_that_does_not_exist_fails_at_once_without_a_restart_loop() {
    let dir = scratch("missing");
    let mut s = spec(&dir, "x.js", base_env());

    s.program = dir.join("no-such-program.exe");
    s.restart = RestartPolicy { max_restarts: 50, window: Duration::from_secs(60), backoff_initial: Duration::from_millis(10), backoff_max: Duration::from_millis(10) };

    let (mut supervisor, events, _lines) = start(s, vec![]);
    let State::Failed(reason) = supervisor.wait_for(|s| matches!(s, State::Failed(_)), Duration::from_secs(10)).await.unwrap() else { panic!() };

    assert!(reason.contains("cannot start"), "{reason}");
    assert_eq!(events.count(|e| matches!(e, Event::Started { .. })), 0);
    assert_eq!(events.count(|e| matches!(e, Event::Restarting { .. })), 0, "no restart can fix a missing program");
    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

const HEALTH_SERVER: &str = "const http = require('http'); const fs = require('fs'); const flag = process.argv[2];\n\
    const server = http.createServer((req, res) => {\n\
      if (req.url === '/api/status' && !fs.existsSync(flag)) { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({status: 'ok'})); }\n\
      else { res.writeHead(503, {'content-type': 'application/json'}); res.end(JSON.stringify({status: 'sick'})); }\n\
    });\n\
    server.listen(0, '127.0.0.1', () => { console.log('READY port=' + server.address().port); });\n\
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

fn health_rule() -> HealthRule {
    HealthRule { path: "/api/status".into(), field: Some(("status".into(), "ok".into())), interval: Duration::from_millis(150), timeout: Duration::from_secs(2), failures: 3 }
}

#[tokio::test]
async fn a_healthy_child_stays_up_and_an_unhealthy_one_is_restarted() {
    let dir = scratch("health");
    let flag = dir.join("sick.flag");
    let mut s = spec(&dir, "server.js", base_env());

    s.health = Some(health_rule());
    s.args = vec![script(&dir, "server.js", HEALTH_SERVER).into_os_string(), flag.clone().into_os_string()];
    s.restart = RestartPolicy { max_restarts: 1, window: Duration::from_secs(60), backoff_initial: Duration::from_millis(50), backoff_max: Duration::from_millis(50) };

    let (mut supervisor, events, _lines) = start(s, vec![]);
    let State::Running { pid: first, port } = supervisor.wait_running(Duration::from_secs(15)).await.unwrap() else { panic!() };

    assert!(port.is_some_and(|p| p > 1024), "the port the child announced");
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(events.count(|e| matches!(e, Event::HealthFailed { .. })), 0, "a healthy child is left alone");

    // It becomes unwell: three probes fail, the child is ended and started again (and, still unwell, then given up on).
    fs::write(&flag, "sick").unwrap();

    let state = supervisor.wait_for(|s| matches!(s, State::Failed(_)), Duration::from_secs(30)).await.unwrap();

    assert!(matches!(&state, State::Failed(reason) if reason.contains("health probes failed")), "{state:?}");
    assert_eq!(events.count(|e| matches!(e, Event::Started { .. })), 2, "{:?}", events.all());
    assert!(events.count(|e| matches!(e, Event::HealthFailed { consecutive: 3 })) >= 1);
    assert!(!alive(first), "the unwell child's tree was ended");
    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_child_cannot_print_a_secret_the_host_knows_not_even_one_it_was_granted() {
    let dir = scratch("leaky");
    let granted = "granted-gateway-token-0123456789";
    let vault_value = "123456789:AAEhBP0-bot-secret_xyz";
    let body = format!(
        "console.log('using {granted} for the gateway'); console.error('bot={vault_value}');\n\
         console.log('READY port=5'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {{}}, 1000);"
    );
    let mut s = spec(&dir, "leaky.js", base_env().grant_control("JAROD_GATEWAY_TOKEN", granted).unwrap());

    s.args = vec![script(&dir, "leaky.js", &body).into_os_string()];

    let (mut supervisor, _events, lines) = start(s, vec![Secret::new(SecretKind::Vault, vault_value)]);

    supervisor.wait_running(Duration::from_secs(15)).await.unwrap();
    eventually("the child's output", Duration::from_secs(5), || lines.text().contains("bot=")).await;

    let text = lines.text();

    assert!(!text.contains(granted) && !text.contains(vault_value), "{text}");
    assert!(text.contains("using [REDACTED:token] for the gateway") && text.contains("bot=[REDACTED:vault]"), "{text}");

    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_line_without_an_end_cannot_exhaust_the_hosts_memory() {
    let dir = scratch("flood");
    let body = "process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.stdout.write('\\n'); console.log('READY port=6'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);";
    let mut s = spec(&dir, "flood.js", base_env());

    s.args = vec![script(&dir, "flood.js", body).into_os_string()];

    let (mut supervisor, _events, lines) = start(s, vec![]);

    supervisor.wait_running(Duration::from_secs(20)).await.unwrap();
    assert!(lines.0.lock().unwrap().iter().all(|(_, line)| line.len() <= host_supervisor::supervisor::MAX_LINE_BYTES), "no kept line exceeds the bound");
    supervisor.stop().await;
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stopping_during_a_backoff_does_not_restart_anything() {
    let dir = scratch("backoff-stop");
    let mut s = spec(&dir, "crash.js", base_env());

    s.restart = RestartPolicy { max_restarts: 5, window: Duration::from_secs(60), backoff_initial: Duration::from_secs(30), backoff_max: Duration::from_secs(30) };
    s.args = vec![script(&dir, "crash.js", "console.log('READY port=9'); setTimeout(() => process.exit(1), 100);").into_os_string()];

    let (mut supervisor, events, _lines) = start(s, vec![]);

    supervisor.wait_for(|s| matches!(s, State::Backoff { .. }), Duration::from_secs(15)).await.unwrap();

    let began = Instant::now();

    supervisor.stop().await;

    assert!(began.elapsed() < Duration::from_secs(5), "the 30 s backoff was cut short");
    assert_eq!(events.count(|e| matches!(e, Event::Started { .. })), 1);
    let _ = fs::remove_dir_all(&dir);
}
