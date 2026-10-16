//! The spike host: the control boundary of `host_control`, served on a Windows named pipe.
//!
//! Fail closed, all of it: the contracts must load from `HERALD_OS_CONTRACTS_DIR`, two tokens must be
//! minted, the journal must open, the pipe must be created with its explicit DACL and that DACL must
//! read back as asked. Any miss exits with status 2 before anything is announced. The endpoint is
//! printed (one line, stdout) only once the door is open and verified.
//!
//! This is a spike, and says so: it executes nothing (every command that passes the gate is answered
//! by a no-op executor) and it has no approval channel, so `mutate` and `destructive` commands are
//! refused with `denied-policy`. The tokens go to files in `--token-dir` so the door can be exercised
//! by hand; a real host keeps the backend token in memory and hands it to its child.
//!
//! ```text
//! herald-host-spike --journal <control-audit.jsonl> --token-dir <dir> [--surface panel|backend]
//! ```

#[cfg(not(windows))]
fn main() {
    eprintln!("herald-host-spike: the spike's transport is the Windows named pipe; refusing to serve");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => refuse(format!("cannot start the async runtime: {error}")),
    };

    std::process::exit(runtime.block_on(run()));
}

#[cfg(windows)]
fn refuse(message: impl std::fmt::Display) -> ! {
    eprintln!("herald-host-spike: refusing to serve: {message}");
    std::process::exit(2);
}

#[cfg(windows)]
struct Options {
    journal: std::path::PathBuf,
    token_dir: std::path::PathBuf,
    surface: host_control::types::Surface,
}

#[cfg(windows)]
fn options() -> Options {
    let mut journal = None;
    let mut token_dir = None;
    let mut surface = host_control::types::Surface::Panel;
    let mut args = std::env::args().skip(1);

    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_else(|| refuse(format!("{flag} needs a value")));

        match flag.as_str() {
            "--journal" => journal = Some(value.into()),
            "--token-dir" => token_dir = Some(value.into()),
            "--surface" => {
                surface = match value.as_str() {
                    "panel" => host_control::types::Surface::Panel,
                    "backend" => host_control::types::Surface::Backend,
                    other => refuse(format!("--surface is panel or backend, not {other:?}")),
                }
            }
            other => refuse(format!("unknown option {other:?}")),
        }
    }

    Options { journal: journal.unwrap_or_else(|| refuse("--journal <file> is required")), token_dir: token_dir.unwrap_or_else(|| refuse("--token-dir <dir> is required")), surface }
}

#[cfg(windows)]
struct NoopExecutor;

#[cfg(windows)]
impl host_control::gate::Executor for NoopExecutor {
    fn run(&self, call: host_control::gate::HostCall) -> host_control::gate::BoxFuture<host_control::gate::Outcome> {
        Box::pin(async move { host_control::gate::Outcome::ok(format!("spike: {} was authorised and not executed", call.command)) })
    }
}

#[cfg(windows)]
async fn run() -> i32 {
    use host_control::adjudicate::StaticCatalogue;
    use host_control::audit::{ControlSecurity, FileJournal};
    use host_control::capability::CapabilityStore;
    use host_control::clock::SystemClock;
    use host_control::contracts::Contracts;
    use host_control::endpoint::PipeEndpoint;
    use host_control::gate::HostControlGate;
    use host_control::pipe::{SecuredPipe, resolve_principals};
    use host_control::secrets::{Secret, SecretKind, Tokens};
    use host_control::wire::HostService;
    use std::io::Write;
    use std::sync::Arc;

    let options = options();
    let contracts = Contracts::load_from_env().unwrap_or_else(|error| refuse(format!("contracts: {error}")));
    let tokens = Tokens::mint().unwrap_or_else(|error| refuse(error));
    let journal = Arc::new(FileJournal::open(&options.journal).unwrap_or_else(|error| refuse(format!("the journal {} cannot be opened: {error}", options.journal.display()))));
    let endpoint = PipeEndpoint::fresh().unwrap_or_else(|error| refuse(error));
    let (backend, cli) = (tokens.backend().to_string(), tokens.cli().to_string());
    let clock = Arc::new(SystemClock);
    let security = Arc::new(ControlSecurity::new(
        tokens,
        options.surface,
        Arc::new(contracts.matrix.clone()),
        // The renderer's catalogue is not known to the spike: an empty one is "not ready", so registry
        // commands are let through to the gate, which refuses what it cannot classify.
        Arc::new(StaticCatalogue::default()),
        journal,
        clock.clone(),
        vec![Secret::new(SecretKind::Nonce, endpoint.nonce())],
    ));
    // No approval channel: mutate and destructive commands are refused, never silently approved.
    let gate = Arc::new(HostControlGate::new(security, CapabilityStore::new(clock), None));
    let service = Arc::new(HostService::new(gate, Arc::new(NoopExecutor)));
    let principals = resolve_principals().unwrap_or_else(|error| refuse(format!("pipe policy: {error}")));
    let secured = SecuredPipe::new(endpoint, principals).unwrap_or_else(|error| refuse(format!("pipe policy: {error}")));
    let mut running = secured.bind(service).unwrap_or_else(|error| refuse(format!("pipe: {error}")));

    // The door is open and its DACL has been read back: only now is the endpoint worth publishing.
    if let Err(error) = write_tokens(&options.token_dir, &backend, &cli) {
        let _ = running.stop().await;

        refuse(format!("cannot write the tokens to {}: {error}", options.token_dir.display()));
    }

    println!("{}", running.serving.endpoint);
    let _ = std::io::stdout().flush();

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            let _ = running.stop().await;

            0
        }
        closed = running.closed() => {
            eprintln!("herald-host-spike: the door closed by itself ({}); not staying up", closed.err().map(|e| e.to_string()).unwrap_or_default());

            1
        }
    }
}

/// `create_new`: an existing file is never overwritten, so a stale or planted token file stops the start.
#[cfg(windows)]
fn write_tokens(dir: &std::path::Path, backend: &str, cli: &str) -> std::io::Result<()> {
    use std::io::Write;

    std::fs::create_dir_all(dir)?;

    for (name, value) in [("backend.token", backend), ("cli.token", cli)] {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(name))?;

        file.write_all(value.as_bytes())?;
    }

    Ok(())
}
