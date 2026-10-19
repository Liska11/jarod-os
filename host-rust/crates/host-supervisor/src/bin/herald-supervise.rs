//! `herald-supervise`: the supervisor as a command, for the host's scripts and for tests.
//!
//! ```text
//! herald-supervise --name <n> --ready-prefix <p> [--ready-timeout-ms N] [--grace-ms N] [--max-restarts N]
//!                  [--cwd <dir>] [--allow NAME]... [--set K=V]... [--grant NAME=V]... -- <program> [args…]
//! ```
//!
//! The child's environment is the Windows essentials plus `--allow`ed names plus `--set` values; the
//! control names of `c5-control-env-names` (loaded from the folder `JAROD_OS_CONTRACTS_DIR` names) are
//! never inherited and are given only with `--grant`. Prints one line per
//! change (`STATE …`) and the child's own output, redacted, as `LOG <stream> <line>`. Closing its stdin
//! (or Ctrl-C) stops the child politely and exits. If this process is killed, the Job Object ends the tree.

#[cfg(not(windows))]
fn main() {
    eprintln!("herald-supervise: the supervisor's process tree control is Windows-only for now");
    std::process::exit(2);
}

#[cfg(windows)]
#[tokio::main]
async fn main() {
    std::process::exit(run().await);
}

#[cfg(windows)]
fn refuse(message: impl std::fmt::Display) -> ! {
    eprintln!("herald-supervise: refusing to run: {message}");
    std::process::exit(2);
}

#[cfg(windows)]
async fn run() -> i32 {
    use host_control::contracts::Contracts;
    use host_supervisor::*;
    use std::io::Write;
    use std::sync::Arc;
    use std::time::Duration;

    let mut name = "child".to_string();
    let mut prefix = None;
    let (mut ready_ms, mut grace_ms, mut max_restarts) = (30_000u64, 5_000u64, 0u32);
    let mut cwd = None;
    let mut allow: Vec<String> = Vec::new();
    let mut sets: Vec<(String, String)> = Vec::new();
    let mut grants: Vec<(String, String)> = Vec::new();
    let mut command: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);

    while let Some(flag) = args.next() {
        if flag == "--" {
            command = args.by_ref().collect();

            break;
        }

        let value = args.next().unwrap_or_else(|| refuse(format!("{flag} needs a value")));
        let pair = |value: &str| value.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).unwrap_or_else(|| refuse(format!("{flag} needs NAME=VALUE")));
        let number = |value: &str| value.parse::<u64>().unwrap_or_else(|_| refuse(format!("{flag} needs a number")));

        match flag.as_str() {
            "--name" => name = value,
            "--ready-prefix" => prefix = Some(value),
            "--ready-timeout-ms" => ready_ms = number(&value),
            "--grace-ms" => grace_ms = number(&value),
            "--max-restarts" => max_restarts = number(&value) as u32,
            "--cwd" => cwd = Some(value),
            "--allow" => allow.push(value),
            "--set" => sets.push(pair(&value)),
            "--grant" => grants.push(pair(&value)),
            other => refuse(format!("unknown option {other:?}")),
        }
    }

    let Some((program, program_args)) = command.split_first() else {
        refuse("a command is required after --");
    };
    let contracts = Contracts::load_from_env().unwrap_or_else(|error| refuse(format!("contracts: {error}")));
    let control = control_env_names(&contracts).unwrap_or_else(|error| refuse(error));
    let parent: Vec<(String, String)> = std::env::vars().collect();
    let allowed: Vec<&str> = WINDOWS_ESSENTIALS.iter().copied().chain(allow.iter().map(String::as_str)).collect();
    let mut env = ChildEnv::new(&control).inherit_allowlisted(&parent, &allowed);

    for (key, value) in &sets {
        env = env.set(key, value).unwrap_or_else(|error| refuse(error));
    }

    for (key, value) in &grants {
        env = env.grant_control(key, value).unwrap_or_else(|error| refuse(error));
    }

    struct Print;

    impl LogSink for Print {
        fn line(&self, _name: &str, stream: Stream, line: &str) {
            println!("LOG {} {line}", if stream == Stream::Stdout { "stdout" } else { "stderr" });
        }
    }

    struct Say;

    impl Observer for Say {
        fn event(&self, name: &str, event: &Event) {
            println!("EVENT {name} {event:?}");
        }
    }

    let spec = ChildSpec {
        name,
        program: program.into(),
        args: program_args.iter().map(Into::into).collect(),
        cwd: cwd.map(Into::into),
        env,
        ready: ReadyRule { prefix: prefix.unwrap_or_else(|| refuse("--ready-prefix is required")) },
        ready_timeout: Duration::from_millis(ready_ms),
        health: None,
        grace: Duration::from_millis(grace_ms),
        restart: RestartPolicy { max_restarts, window: Duration::from_secs(60), backoff_initial: Duration::from_millis(200), backoff_max: Duration::from_secs(5) },
    };
    let mut supervisor = Supervisor::spawn(spec, Arc::new(Say), Arc::new(Print), Arc::new(Vec::new));

    match supervisor.wait_running(Duration::from_millis(ready_ms + 5_000)).await {
        Ok(State::Running { pid, port }) => println!("STATE running pid={pid} port={}", port.map(|p| p.to_string()).unwrap_or_default()),
        Ok(other) => println!("STATE {other:?}"),
        Err(why) => {
            println!("STATE failed {why}");

            return 1;
        }
    }

    let _ = std::io::stdout().flush();

    // Stop when this process is asked to, or when its own stdin closes (the launcher went away).
    let closed = tokio::task::spawn_blocking(|| {
        let mut sink = Vec::new();
        let _ = std::io::Read::read_to_end(&mut std::io::stdin(), &mut sink);
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = closed => {}
        ended = supervisor.wait_for(|state| matches!(state, State::Failed(_) | State::Stopped), Duration::from_secs(86_400)) => {
            println!("STATE {ended:?}");

            return 1;
        }
    }

    supervisor.stop().await;
    println!("STATE stopped");

    0
}
