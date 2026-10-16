//! The control boundary of the Rust host (phase 0c spike).
//!
//! Everything here is a port of what `apps/desktop/electron/shell` does today, held to the frozen
//! contracts in `contracts/v1`: the schemas and the golden authorization matrix are **loaded from that
//! folder at start**, never copied into this crate, and the host refuses to serve when they are not
//! there. TypeScript stays the reference; where the two differ the difference is listed in the README
//! of this workspace, not fixed on the TypeScript side.
//!
//! - [`contracts`]: the schemas, the fixtures and the C2 matrix, from disk.
//! - [`endpoint`]: the C1 endpoint, strict on both emit and accept.
//! - [`request`], [`adjudicate`]: one request in, one decision out, refusal by default.
//! - [`capability`], [`gate`]: one-shot capabilities, spent before the call runs.
//! - [`redact`], [`audit`]: the C3 journal, with a live secret never written into it.
//! - [`wire`]: JSON lines over any byte stream; [`pipe`] is the Windows named pipe it runs on.

pub mod adjudicate;
pub mod audit;
pub mod broker;
pub mod capability;
pub mod clock;
pub mod contracts;
pub mod endpoint;
pub mod gate;
pub mod redact;
pub mod request;
pub mod secrets;
pub mod types;
pub mod wire;

#[cfg(windows)]
pub mod pipe;
