//! Keeps one child process alive, observably, without ever trusting it.
//!
//! A child is started with an environment that was *built* ([`ChildEnv`]), inside a Job Object so its whole
//! tree dies with it and with the host, its stdin held open (closing it is the polite way to ask it to stop,
//! the only clean one on Windows), its output read line by line with a bound and **redacted against every
//! secret this process knows** before anyone sees it. It is ready when it says so (a sentinel line) and
//! healthy while an HTTP probe answers; unhealthy or crashed, it is restarted with a backoff, until it has
//! failed too often inside a window, at which point the supervisor gives up and says why rather than loop.
//! A deliberate stop is never restarted.

use crate::env::ChildEnv;
use host_control::redact::redact_secrets;
use host_control::secrets::{Secret, SecretKind};
use serde_json::Value;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

/// The longest line of a child's output that is kept; the rest of a longer line is dropped.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A line of the child's output that says it is ready: it starts with `prefix`, and when `prefix` ends in
/// `port=` the digits that follow are the port the child listens on.
#[derive(Clone, Debug)]
pub struct ReadyRule {
    pub prefix: String,
}

#[derive(Clone, Debug)]
pub struct HealthRule {
    /// `GET <path>` on 127.0.0.1 and the port the ready line gave.
    pub path: String,
    /// The response must be 200 with this JSON field equal to this string (`status` = `ok`).
    pub field: Option<(String, String)>,
    pub interval: Duration,
    pub timeout: Duration,
    /// Consecutive failures before the child is considered unhealthy and restarted.
    pub failures: u32,
}

#[derive(Clone, Debug)]
pub struct RestartPolicy {
    pub max_restarts: u32,
    pub window: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
}

impl RestartPolicy {
    pub fn never() -> RestartPolicy {
        RestartPolicy { max_restarts: 0, window: Duration::from_secs(60), backoff_initial: Duration::from_millis(100), backoff_max: Duration::from_secs(1) }
    }
}

#[derive(Clone, Debug)]
pub struct ChildSpec {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: ChildEnv,
    pub ready: ReadyRule,
    pub ready_timeout: Duration,
    pub health: Option<HealthRule>,
    /// How long a stop request waits after closing stdin before the tree is terminated.
    pub grace: Duration,
    pub restart: RestartPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Starting {
        attempt: u32,
    },
    Running {
        pid: u32,
        port: Option<u16>,
    },
    Backoff {
        attempt: u32,
    },
    /// Terminal: the supervisor gave up, or could not start the child at all.
    Failed(String),
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Started { pid: u32 },
    Ready { pid: u32, port: Option<u16> },
    ReadyTimeout,
    HealthFailed { consecutive: u32 },
    Exited { code: Option<i32>, unexpected: bool },
    Restarting { attempt: u32, wait: Duration },
    GaveUp { reason: String },
    Stopped { graceful: bool },
}

pub trait Observer: Send + Sync {
    fn event(&self, name: &str, event: &Event);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

pub trait LogSink: Send + Sync {
    /// A line of the child's output, already redacted.
    fn line(&self, name: &str, stream: Stream, line: &str);
}

pub struct NullObserver;

impl Observer for NullObserver {
    fn event(&self, _name: &str, _event: &Event) {}
}

pub struct NullLog;

impl LogSink for NullLog {
    fn line(&self, _name: &str, _stream: Stream, _line: &str) {}
}

pub type SecretSource = Arc<dyn Fn() -> Vec<Secret> + Send + Sync>;

/// Reads lines from a stream, keeping at most [`MAX_LINE_BYTES`] of each.
struct LineReader<R> {
    reader: R,
    buffer: Vec<u8>,
    overflowed: bool,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    fn new(reader: R) -> Self {
        LineReader { reader, buffer: Vec::new(), overflowed: false }
    }

    async fn next(&mut self) -> Option<String> {
        let mut chunk = [0u8; 4096];

        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();

                if std::mem::take(&mut self.overflowed) {
                    continue;
                }

                return Some(String::from_utf8_lossy(&line[..line.len() - 1]).trim_end_matches('\r').to_string());
            }

            if self.buffer.len() > MAX_LINE_BYTES {
                // A line without an end that is already too long: keep nothing of it, skip to its newline.
                self.buffer.clear();
                self.overflowed = true;
            }

            match self.reader.read(&mut chunk).await {
                Ok(0) | Err(_) => {
                    return if self.buffer.is_empty() || self.overflowed {
                        None
                    } else {
                        Some(String::from_utf8_lossy(&std::mem::take(&mut self.buffer)).trim_end_matches('\r').to_string())
                    };
                }
                Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
            }
        }
    }
}

/// `PREFIX…` → ready; `PREFIX…port=N` → ready on port N.
fn parse_ready(line: &str, rule: &ReadyRule) -> Option<Option<u16>> {
    let rest = line.trim().strip_prefix(rule.prefix.as_str())?;

    if rule.prefix.ends_with("port=") {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let port: u32 = digits.parse().ok()?;

        return (1..65536).contains(&port).then_some(Some(port as u16));
    }

    Some(None)
}

/// A bare HTTP/1.1 GET on loopback: enough to ask a child "are you well", nothing more.
async fn http_get_json(port: u16, path: &str, timeout: Duration) -> Result<(u16, Value), String> {
    let work = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;

        // HTTP/1.0: the answer is never chunked and the server closes when it is done, so the body is the rest of the stream.
        stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.map_err(|e| e.to_string())?;

        let mut response = Vec::new();

        stream.take(256 * 1024).read_to_end(&mut response).await.map_err(|e| e.to_string())?;

        let text = String::from_utf8_lossy(&response).to_string();
        let (head, body) = text.split_once("\r\n\r\n").ok_or("no HTTP response")?;
        let status: u16 = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse().ok()).ok_or("no status line")?;
        let json = serde_json::from_str(body.trim()).unwrap_or(Value::Null);

        Ok((status, json))
    };

    tokio::time::timeout(timeout, work).await.map_err(|_| "the health probe timed out".to_string())?
}

async fn healthy(rule: &HealthRule, port: u16) -> bool {
    match http_get_json(port, &rule.path, rule.timeout).await {
        Ok((200, body)) => match &rule.field {
            Some((name, expected)) => body.get(name).and_then(Value::as_str) == Some(expected.as_str()),
            None => true,
        },
        _ => false,
    }
}

pub struct Supervisor {
    state: watch::Receiver<State>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

struct Context {
    spec: ChildSpec,
    observer: Arc<dyn Observer>,
    log: Arc<dyn LogSink>,
    secrets: SecretSource,
    state: watch::Sender<State>,
}

impl Context {
    fn emit(&self, event: Event) {
        self.observer.event(&self.spec.name, &event);
    }

    fn set(&self, state: State) {
        let _ = self.state.send(state);
    }
}

enum Generation {
    /// Stopped on request.
    Stop { graceful: bool },
    /// Went away or was not well: restart if the policy allows.
    Down { reason: String },
    /// Could not be started at all: no restart will help.
    CannotStart(String),
}

impl Supervisor {
    pub fn spawn(spec: ChildSpec, observer: Arc<dyn Observer>, log: Arc<dyn LogSink>, secrets: SecretSource) -> Supervisor {
        let (state_tx, state_rx) = watch::channel(State::Starting { attempt: 0 });
        let (stop_tx, stop_rx) = oneshot::channel();
        let context = Context { spec, observer, log, secrets, state: state_tx };
        let task = tokio::spawn(run(context, stop_rx));

        Supervisor { state: state_rx, stop: Some(stop_tx), task }
    }

    pub fn state(&self) -> State {
        self.state.borrow().clone()
    }

    /// Waits until `predicate` holds for the state, or `timeout` passes.
    pub async fn wait_for(&mut self, predicate: impl Fn(&State) -> bool, timeout: Duration) -> Result<State, String> {
        let wait = async {
            loop {
                let current = self.state.borrow().clone();

                if predicate(&current) {
                    return Ok(current);
                }

                if self.state.changed().await.is_err() {
                    return Err(format!("the supervisor ended in state {:?}", self.state.borrow().clone()));
                }
            }
        };

        tokio::time::timeout(timeout, wait).await.map_err(|_| format!("timed out in state {:?}", self.state.borrow().clone()))?
    }

    pub async fn wait_running(&mut self, timeout: Duration) -> Result<State, String> {
        self.wait_for(|state| matches!(state, State::Running { .. } | State::Failed(_) | State::Stopped), timeout).await.and_then(|state| match state {
            State::Running { .. } => Ok(state),
            other => Err(format!("not running: {other:?}")),
        })
    }

    /// Asks the child to stop (stdin closed), waits `grace`, then ends the tree. Resolves when it is over.
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }

        let _ = self.task.await;
    }
}

async fn run(context: Context, mut stop: oneshot::Receiver<()>) {
    let policy = context.spec.restart.clone();
    let mut starts: VecDeque<Instant> = VecDeque::new();
    let mut attempt = 0u32;

    loop {
        attempt += 1;
        context.set(State::Starting { attempt });

        match generation(&context, &mut stop).await {
            Generation::Stop { graceful } => {
                context.set(State::Stopped);
                context.emit(Event::Stopped { graceful });

                return;
            }
            Generation::CannotStart(reason) => {
                context.set(State::Failed(reason.clone()));
                context.emit(Event::GaveUp { reason });

                return;
            }
            Generation::Down { reason } => {
                let now = Instant::now();

                starts.push_back(now);

                while starts.front().is_some_and(|first| now.duration_since(*first) > policy.window) {
                    starts.pop_front();
                }

                if starts.len() as u32 > policy.max_restarts {
                    let reason = format!("{reason}; {} failures within {:?}, not restarting", starts.len(), policy.window);

                    context.set(State::Failed(reason.clone()));
                    context.emit(Event::GaveUp { reason });

                    return;
                }

                let exponent = (starts.len() as u32).saturating_sub(1).min(16);
                let wait = policy.backoff_initial.saturating_mul(1u32 << exponent).min(policy.backoff_max);

                context.set(State::Backoff { attempt });
                context.emit(Event::Restarting { attempt: attempt + 1, wait });

                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = &mut stop => {
                        context.set(State::Stopped);
                        context.emit(Event::Stopped { graceful: true });

                        return;
                    }
                }
            }
        }
    }
}

/// One life of the child.
async fn generation(context: &Context, stop: &mut oneshot::Receiver<()>) -> Generation {
    let spec = &context.spec;
    let job = match crate::job::Job::new() {
        Ok(job) => job,
        Err(error) => return Generation::CannotStart(format!("cannot create the job object: {error}")),
    };
    let mut command = Command::new(&spec.program);

    command
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.vars())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);

    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Generation::CannotStart(format!("cannot start {}: {error}", spec.program.display())),
    };
    let pid = child.id().unwrap_or(0);

    if let Some(handle) = child.raw_handle()
        && let Err(error) = job.assign(&RawProcess(handle))
    {
        let _ = child.start_kill();

        return Generation::CannotStart(format!("cannot put the child in its job object: {error}"));
    }

    context.emit(Event::Started { pid });

    let mut stdin = child.stdin.take();
    let (ready_tx, mut ready_rx) = watch::channel::<Option<Option<u16>>>(None);

    for (stream, source) in [(Stream::Stdout, child.stdout.take().map(Source::Out)), (Stream::Stderr, child.stderr.take().map(Source::Err))] {
        let Some(source) = source else {
            continue;
        };
        let (name, log, secrets, rule, ready) = (spec.name.clone(), context.log.clone(), context.secrets.clone(), spec.ready.clone(), ready_tx.clone());
        let granted: Vec<Secret> = spec.env.granted_values().into_iter().map(|value| Secret::new(SecretKind::Token, value)).collect();

        tokio::spawn(async move {
            let mut lines = match source {
                Source::Out(reader) => Reader::Out(LineReader::new(reader)),
                Source::Err(reader) => Reader::Err(LineReader::new(reader)),
            };

            while let Some(line) = lines.next().await {
                if stream == Stream::Stdout
                    && let Some(port) = parse_ready(&line, &rule)
                {
                    let _ = ready.send(Some(port));
                }

                let mut known = secrets();

                known.extend(granted.iter().cloned());
                log.line(&name, stream, &redact_secrets(&line, &known));
            }
        });
    }

    // Phase 1: wait until it says it is ready, or dies, or is told to stop.
    let ready = loop {
        tokio::select! {
            changed = ready_rx.changed() => {
                if changed.is_ok() && let Some(port) = *ready_rx.borrow() {
                    break port;
                }

                if changed.is_err() {
                    return finish(context, &mut child, &job, stdin.take(), "its output ended before it was ready").await;
                }
            }
            _ = tokio::time::sleep(spec.ready_timeout) => {
                context.emit(Event::ReadyTimeout);

                return down(context, &mut child, &job, format!("not ready after {:?}", spec.ready_timeout)).await;
            }
            exit = child.wait() => {
                return exited(context, &job, exit.ok().and_then(|s| s.code()), true);
            }
            _ = &mut *stop => {
                return stop_child(context, &mut child, &job, stdin.take()).await;
            }
        }
    };

    context.set(State::Running { pid, port: ready });
    context.emit(Event::Ready { pid, port: ready });

    // Phase 2: while it runs, watch it.
    let mut consecutive = 0u32;
    let interval = spec.health.as_ref().map(|rule| rule.interval).unwrap_or(Duration::from_secs(3600));

    loop {
        tokio::select! {
            exit = child.wait() => {
                return exited(context, &job, exit.ok().and_then(|s| s.code()), true);
            }
            _ = &mut *stop => {
                return stop_child(context, &mut child, &job, stdin.take()).await;
            }
            _ = tokio::time::sleep(interval), if spec.health.is_some() && ready.is_some() => {
                let rule = spec.health.as_ref().expect("guarded above");

                if healthy(rule, ready.unwrap_or(0)).await {
                    consecutive = 0;
                } else {
                    consecutive += 1;
                    context.emit(Event::HealthFailed { consecutive });

                    if consecutive >= rule.failures {
                        return down(context, &mut child, &job, format!("{consecutive} health probes failed")).await;
                    }
                }
            }
        }
    }
}

enum Source {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
}

enum Reader {
    Out(LineReader<tokio::process::ChildStdout>),
    Err(LineReader<tokio::process::ChildStderr>),
}

impl Reader {
    async fn next(&mut self) -> Option<String> {
        match self {
            Reader::Out(reader) => reader.next().await,
            Reader::Err(reader) => reader.next().await,
        }
    }
}

/// A process handle borrowed from tokio's `Child`, for the job object.
struct RawProcess(std::os::windows::io::RawHandle);

impl std::os::windows::io::AsRawHandle for RawProcess {
    fn as_raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.0
    }
}

fn exited(context: &Context, job: &crate::job::Job, code: Option<i32>, unexpected: bool) -> Generation {
    // Whatever the child left running goes with it.
    job.terminate();
    context.emit(Event::Exited { code, unexpected });

    Generation::Down { reason: format!("exited with {}", code.map(|c| c.to_string()).unwrap_or_else(|| "no status".into())) }
}

/// Ends a child that is unwell: the whole tree, then reap.
async fn down(context: &Context, child: &mut tokio::process::Child, job: &crate::job::Job, reason: String) -> Generation {
    job.terminate();
    let _ = child.wait().await;
    context.emit(Event::Exited { code: None, unexpected: true });

    Generation::Down { reason }
}

async fn finish(context: &Context, child: &mut tokio::process::Child, job: &crate::job::Job, stdin: Option<tokio::process::ChildStdin>, reason: &str) -> Generation {
    drop(stdin);

    down(context, child, job, reason.to_string()).await
}

/// The polite stop: close stdin, give it `grace`, then the whole tree.
async fn stop_child(context: &Context, child: &mut tokio::process::Child, job: &crate::job::Job, stdin: Option<tokio::process::ChildStdin>) -> Generation {
    drop(stdin);

    let graceful = tokio::time::timeout(context.spec.grace, child.wait()).await.is_ok();

    job.terminate();

    if !graceful {
        let _ = child.wait().await;
    }

    Generation::Stop { graceful }
}
