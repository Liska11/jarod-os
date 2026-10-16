//! JSON lines over any byte stream: one request per line in, one reply per line out.
//!
//! The transport is whatever carries bytes (a Windows named pipe in production, an in-memory duplex
//! stream in tests that must run anywhere), so the protocol is exercised the same way on both.
//! A line that outgrows [`MAX_LINE_BYTES`] without an end is not a request: the connection is dropped
//! instead of buffering it (any local process can dial the pipe). Replies are written in request order.

use crate::gate::{Executor, GateResult, HostControlGate, HostReply};
use crate::request::Request;
use crate::types::HostCode;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A request line longer than this is not a request.
pub const MAX_LINE_BYTES: usize = 1_000_000;

/// A connection that sends nothing for this long is closed: it holds a task and a pipe instance.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Splits a byte stream into trimmed, non-empty lines.
pub struct LineSplitter {
    buffer: Vec<u8>,
    max: usize,
}

impl LineSplitter {
    pub fn new(max: usize) -> LineSplitter {
        LineSplitter { buffer: Vec::new(), max }
    }

    /// The complete lines `chunk` finishes, or `None` once the pending line outgrows the limit.
    pub fn push(&mut self, chunk: &[u8]) -> Option<Vec<String>> {
        self.buffer.extend_from_slice(chunk);

        let mut lines = Vec::new();

        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]).trim().to_string();

            if !text.is_empty() {
                lines.push(text);
            }
        }

        if self.buffer.len() > self.max {
            self.buffer.clear();

            return None;
        }

        Some(lines)
    }
}

/// The gate and the executor behind one door.
pub struct HostService {
    gate: Arc<HostControlGate>,
    executor: Arc<dyn Executor>,
}

impl HostService {
    pub fn new(gate: Arc<HostControlGate>, executor: Arc<dyn Executor>) -> HostService {
        HostService { gate, executor }
    }

    pub fn gate(&self) -> &Arc<HostControlGate> {
        &self.gate
    }

    /// One request line, one reply value.
    pub async fn handle_line(&self, line: &str) -> Value {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                // Not a request anyone can attribute, so the policy never sees it: no token, no command,
                // no caller. The attempt is still journalled — without the line, which may carry a token.
                self.gate.security().malformed("invalid JSON");

                return json!({ "ok": false, "error": "invalid JSON" });
            }
        };
        let request = Request::from_value(value);

        match self.gate.submit(&request).await {
            GateResult::Reply(reply) => to_value(&reply),
            GateResult::Execute(ticket) => {
                let call = ticket.call.clone();
                let request_id = call.request_id.clone();
                let outcome = self.executor.run(call).await;

                ticket.finish(&outcome);

                to_value(&HostReply {
                    ok: outcome.ok,
                    code: outcome.code.unwrap_or(if outcome.ok { HostCode::Ok } else { HostCode::ExecutionFailed }),
                    error: if outcome.ok { None } else { Some(outcome.reason.clone().or(outcome.summary.clone()).unwrap_or_else(|| "the command failed".into())) },
                    summary: outcome.summary,
                    data: outcome.data,
                    request_id,
                    capability: None,
                })
            }
        }
    }
}

fn to_value(reply: &HostReply) -> Value {
    serde_json::to_value(reply).unwrap_or_else(|_| json!({ "ok": false, "error": "the reply could not be encoded" }))
}

/// Serve one connection until it closes, goes idle, or sends a line that never ends.
pub async fn serve_connection<S>(mut stream: S, service: Arc<HostService>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut splitter = LineSplitter::new(MAX_LINE_BYTES);
    let mut chunk = vec![0u8; 16 * 1024];
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut queued_bytes = 0usize;

    loop {
        let Some(line) = queue.pop_front() else {
            let read = match tokio::time::timeout(IDLE_TIMEOUT, stream.read(&mut chunk)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return,
                Ok(Ok(read)) => read,
            };

            // The pending line had no end: dropped, not answered.
            let Some(lines) = splitter.push(&chunk[..read]) else {
                return;
            };

            if !enqueue(&mut queue, &mut queued_bytes, lines) {
                return;
            }

            continue;
        };

        queued_bytes = queued_bytes.saturating_sub(line.len());

        // While a request is being handled — which may mean waiting for a person to answer a prompt — keep
        // listening to the connection. If the client goes away, the handler is dropped, and whatever it was
        // waiting on (the prompt, the broker's single slot) is released instead of left open for a caller
        // that is no longer there. Bytes that arrive meanwhile are the next requests: queued, within bounds.
        let handling = service.handle_line(&line);

        tokio::pin!(handling);

        let reply = loop {
            tokio::select! {
                reply = &mut handling => break reply,
                read = stream.read(&mut chunk) => {
                    let Ok(read) = read else { return };

                    if read == 0 {
                        return;
                    }

                    let Some(lines) = splitter.push(&chunk[..read]) else {
                        return;
                    };

                    if !enqueue(&mut queue, &mut queued_bytes, lines) {
                        return;
                    }
                }
            }
        };

        if stream.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
            return;
        }
    }
}

/// At most this many requests, and this many bytes of them, wait behind the one being handled.
const MAX_QUEUED_LINES: usize = 64;
const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;

/// `false` when a client has piled up more than the host will hold: the connection is dropped.
fn enqueue(queue: &mut std::collections::VecDeque<String>, queued_bytes: &mut usize, lines: Vec<String>) -> bool {
    for line in lines {
        *queued_bytes += line.len();
        queue.push_back(line);

        if queue.len() > MAX_QUEUED_LINES || *queued_bytes > MAX_QUEUED_BYTES {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::LineSplitter;

    #[test]
    fn splits_trims_and_skips_blank_lines() {
        let mut splitter = LineSplitter::new(100);

        assert_eq!(splitter.push(b"  {\"a\":1}  \n\n{\"b\"").unwrap(), vec!["{\"a\":1}"]);
        assert_eq!(splitter.push(b":2}\r\n").unwrap(), vec!["{\"b\":2}"]);
    }

    #[test]
    fn a_line_that_never_ends_is_dropped() {
        let mut splitter = LineSplitter::new(10);

        assert!(splitter.push(&[b'x'; 11]).is_none());
        assert_eq!(splitter.push(b"ok\n").unwrap(), vec!["ok"]);
    }
}
