//! The supervisor of the host (phase 2.4): starts the Cordis kernel and any other child, keeps it alive,
//! and never trusts it.
//!
//! - [`env`]: a child's environment is built from an allowlist; the control names of
//!   `c5-control-env-names` are never inherited and are granted only on purpose, by name.
//! - [`job`] (Windows): a Job Object, so the whole process tree dies with the child and with the host.
//! - [`supervisor`]: start, ready, health, restart with a backoff, give up, stop; output bounded and redacted.

pub mod env;
pub mod supervisor;

#[cfg(windows)]
mod job;

pub use env::{ChildEnv, EnvError, WINDOWS_ESSENTIALS, control_env_names};
pub use supervisor::{ChildSpec, Event, HealthRule, LogSink, NullLog, NullObserver, Observer, ReadyRule, RestartPolicy, State, Stream, Supervisor};
