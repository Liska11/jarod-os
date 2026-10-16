//! Write confinement for commands the agent runs (phase 3, R4).
//!
//! Until now `run_shell` could not be confined on Windows: the TypeScript guard refused `writeScope:
//! "workspace"` there because holding a process to a folder needs native code, and a Job Object limits
//! memory, CPU and process count but not files. This crate is that native code.
//!
//! A command runs in an **AppContainer**: a token with no access to anything it was not explicitly given.
//! For each run:
//!
//! 1. a fresh AppContainer profile with a unique SID (two sandboxes cannot reach each other's files);
//! 2. that SID is granted **modify on the workspace only** (propagated to the files already in it, so an
//!    existing file can be edited in place) and **read on the roots the tool itself needs**;
//! 3. the process starts suspended with exactly three inherited handles (stdin, stdout, stderr), inside a Job
//!    Object that bounds memory, process count and time, kills the whole tree on timeout and denies the UI
//!    privileges (clipboard, desktop switching, global atoms…);
//! 4. when it ends, the grants are revoked and the profile deleted.
//!
//! What is therefore refused by the kernel, not by a filter on text: a write outside the workspace by any
//! means (a redirection, a child process, a junction, an 8.3 name, a hard link, an alternate data stream, a
//! UNC loopback path), registry writes, and network access (no capability is given unless the policy says
//! so). Nothing runs unconfined: if the profile, the grants, the job or the token cannot be set up, the command
//! is **not started** ([`SandboxError::Refused`]). [`self_test`] proves the mechanism on the machine in front
//! of it before it is trusted.
//!
//! What it does *not* do, stated plainly: it does not hide what the user can read from the broad system
//! locations AppContainers may read by design (`C:\Windows`, `Program Files`); it cannot log each denied
//! write (the kernel refuses them inside the child; the post-run report lists what changed in the workspace
//! instead); it was developed and tested on one Windows build (see `docs/sandbox.md`).

pub mod command;
pub mod policy;

#[cfg(windows)]
pub mod acl;
#[cfg(windows)]
pub mod appcontainer;
#[cfg(windows)]
pub mod process;
#[cfg(windows)]
pub mod selftest;

pub use command::{ConfinedCommand, Limits, Output, SandboxError};
pub use policy::Policy;

#[cfg(windows)]
pub use process::run;
#[cfg(windows)]
pub use selftest::{SelfTest, self_test};
