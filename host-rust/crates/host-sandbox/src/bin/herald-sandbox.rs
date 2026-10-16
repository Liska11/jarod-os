//! `herald-sandbox`: the way the TypeScript guard (and a person) uses the sandbox.
//!
//! ```text
//! herald-sandbox selftest
//! herald-sandbox run --workspace DIR [--timeout SECONDS] [--read-root DIR]... [--network] -- PROGRAM [ARGS...]
//! ```
//!
//! `selftest` prints one JSON line `{"confining":bool,"checks":[...],"detail":"..."}` and exits 0 only when the
//! confinement was proven on this machine. `run` prints one JSON line `{"exitCode":…,"timedOut":…,"stdout":…,
//! "stderr":…,"stdoutTruncated":…,"stderrTruncated":…,"elapsedMs":…,"container":…}` and exits 0 when the command
//! was started and finished (its own exit code is in the line); it exits 2 when the sandbox refused to start it,
//! with `{"refused":"…"}`. Nothing is ever run unconfined as a fallback.

#[cfg(not(windows))]
fn main() {
    println!("{{\"refused\":\"the AppContainer sandbox exists on Windows only\"}}");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    use host_sandbox::{ConfinedCommand, Policy, run, self_test};
    use std::time::Duration;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let refuse = |why: &str| -> ! {
        println!("{}", serde_json::json!({ "refused": why }));
        std::process::exit(2);
    };

    match args.first().map(String::as_str) {
        Some("selftest") => {
            let result = self_test();
            let checks: Vec<_> = result.checks.iter().map(|(name, ok)| serde_json::json!({ "name": name, "ok": ok })).collect();

            println!("{}", serde_json::json!({ "confining": result.confining, "checks": checks, "detail": result.detail }));
            std::process::exit(if result.confining { 0 } else { 1 });
        }
        Some("run") => {
            let mut workspace = None;
            let mut policy_timeout = None;
            let mut read_roots = Vec::new();
            let mut network = false;
            let mut rest = args[1..].iter();
            let mut command: Vec<String> = Vec::new();

            while let Some(arg) = rest.next() {
                match arg.as_str() {
                    "--workspace" => workspace = rest.next().cloned(),
                    "--timeout" => policy_timeout = rest.next().and_then(|v| v.parse::<u64>().ok()),
                    "--read-root" => read_roots.extend(rest.next().cloned()),
                    "--network" => network = true,
                    "--" => {
                        command = rest.cloned().collect();

                        break;
                    }
                    other => refuse(&format!("unknown argument {other}")),
                }
            }

            let Some(workspace) = workspace else { refuse("--workspace is required") };
            let Some((program, program_args)) = command.split_first() else { refuse("a program is required after --") };
            let mut policy = Policy::new(workspace);

            policy.network = network;
            policy.read_roots = read_roots.into_iter().map(Into::into).collect();

            if let Some(seconds) = policy_timeout {
                policy.limits.timeout = Duration::from_secs(seconds.max(1));
            }

            match run(&policy, &ConfinedCommand::new(program).args(program_args.iter().cloned())) {
                Ok(out) => println!(
                    "{}",
                    serde_json::json!({
                        "exitCode": out.exit_code,
                        "timedOut": out.timed_out,
                        "stdout": out.stdout_text(),
                        "stderr": out.stderr_text(),
                        "stdoutTruncated": out.stdout_truncated,
                        "stderrTruncated": out.stderr_truncated,
                        "elapsedMs": out.elapsed.as_millis() as u64,
                        "container": out.container,
                    })
                ),
                Err(error) => refuse(&error.to_string()),
            }
        }
        _ => refuse("usage: herald-sandbox selftest | run --workspace DIR [--timeout S] [--read-root DIR] [--network] -- PROGRAM [ARGS...]"),
    }
}
