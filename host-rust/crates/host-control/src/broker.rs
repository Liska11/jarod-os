//! The approval broker (phase 2.4): one prompt, one authority.
//!
//! Anything the host will only do with a person's agreement goes through here and nowhere else: a
//! `mutate` or `destructive` control call today, the removal of unused models tomorrow. The host is the
//! authority and the **only** party that can answer: the answer comes from the [`Prompter`] (the host's own
//! window, or its console in the spike) and there is no control command, no wire field and no capability
//! that answers an approval, so neither the agent that asked (Hermes is the *initiator*, never the
//! approver) nor a plugin can approve itself.
//!
//! Fail closed, in every case: no prompter means no; one prompt at a time, and a second request while one
//! is open is denied rather than queued (nothing can stack dialogs); a prompter that fails, panics or
//! never answers is a no (the gate bounds the wait); a request that is cancelled, because its caller went
//! away or the wait ran out, withdraws its prompt and frees the slot.

use crate::gate::{ApprovalAsk, ApprovalProvider, BoxFuture};
use std::io::BufRead;
use std::sync::{Arc, Mutex};

/// The host's way of asking a person. An implementation shows `ask` and returns what the person chose.
pub trait Prompter: Send + Sync {
    fn prompt(&self, ask: ApprovalAsk) -> BoxFuture<bool>;

    /// The request that was being asked is gone (cancelled or timed out): take the prompt down.
    fn cancel(&self, _ask_id: &str) {}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrokerEvent {
    Asked {
        id: String,
        command: String,
    },
    Answered {
        id: String,
        approved: bool,
    },
    /// Denied without asking: another approval is open.
    Busy {
        id: String,
    },
    /// The request ended before an answer: its caller left, or the wait ran out.
    Cancelled {
        id: String,
    },
}

pub trait BrokerObserver: Send + Sync {
    fn event(&self, event: &BrokerEvent);
}

pub struct ApprovalBroker {
    prompter: Arc<dyn Prompter>,
    observer: Option<Arc<dyn BrokerObserver>>,
    /// The id of the approval that is open, if any.
    open: Mutex<Option<String>>,
}

/// Holds the single slot while a prompt is open; releases it, and withdraws the prompt, if dropped before it
/// was answered.
struct Slot<'a> {
    broker: &'a ApprovalBroker,
    id: String,
    answered: bool,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if let Ok(mut open) = self.broker.open.lock()
            && open.as_deref() == Some(self.id.as_str())
        {
            *open = None;
        }

        if !self.answered {
            self.broker.prompter.cancel(&self.id);
            self.broker.notify(BrokerEvent::Cancelled { id: self.id.clone() });
        }
    }
}

impl ApprovalBroker {
    pub fn new(prompter: Arc<dyn Prompter>, observer: Option<Arc<dyn BrokerObserver>>) -> Arc<ApprovalBroker> {
        Arc::new(ApprovalBroker { prompter, observer, open: Mutex::new(None) })
    }

    fn notify(&self, event: BrokerEvent) {
        if let Some(observer) = &self.observer {
            observer.event(&event);
        }
    }

    /// Whether an approval is open right now.
    pub fn is_open(&self) -> bool {
        self.open.lock().map(|open| open.is_some()).unwrap_or(true)
    }

    /// Asks the person. `false` for every way of not being told yes.
    pub async fn request(&self, ask: ApprovalAsk) -> bool {
        let id = ask.id.clone();

        {
            let Ok(mut open) = self.open.lock() else {
                return false;
            };

            if open.is_some() {
                drop(open);
                self.notify(BrokerEvent::Busy { id });

                return false;
            }

            *open = Some(id.clone());
        }

        let mut slot = Slot { broker: self, id: id.clone(), answered: false };

        self.notify(BrokerEvent::Asked { id: id.clone(), command: ask.command.clone() });

        let approved = self.prompter.prompt(ask).await;

        slot.answered = true;
        self.notify(BrokerEvent::Answered { id, approved });

        approved
    }

    /// For `HostControlGate::new`: the single provider every approval goes through.
    pub fn provider(self: &Arc<Self>) -> ApprovalProvider {
        let broker = self.clone();

        Arc::new(move |ask: ApprovalAsk| -> BoxFuture<bool> {
            let broker = broker.clone();

            Box::pin(async move { broker.request(ask).await })
        })
    }
}

/// The host's side of an approval window, as a channel pair: the host UI receives each ask and answers it
/// with [`ChannelPrompter::answer`]. An answer for an ask that is not open (late, repeated, invented) is
/// ignored. This is the shape a Tauri window takes; it is also what the tests drive.
pub struct ChannelPrompter {
    inner: Arc<ChannelInner>,
}

struct ChannelInner {
    sender: tokio::sync::mpsc::UnboundedSender<ApprovalAsk>,
    pending: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    cancelled: Mutex<Vec<String>>,
}

impl ChannelPrompter {
    pub fn new() -> (ChannelPrompter, tokio::sync::mpsc::UnboundedReceiver<ApprovalAsk>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();

        (ChannelPrompter { inner: Arc::new(ChannelInner { sender, pending: Mutex::new(Default::default()), cancelled: Mutex::new(Vec::new()) }) }, receiver)
    }

    /// The person's answer. Returns whether it was for an open ask.
    pub fn answer(&self, ask_id: &str, approved: bool) -> bool {
        let sender = self.inner.pending.lock().ok().and_then(|mut pending| pending.remove(ask_id));

        sender.is_some_and(|sender| sender.send(approved).is_ok())
    }

    /// Asks that were withdrawn before they were answered.
    pub fn cancelled(&self) -> Vec<String> {
        self.inner.cancelled.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

impl Prompter for ChannelPrompter {
    fn prompt(&self, ask: ApprovalAsk) -> BoxFuture<bool> {
        let (answer, wait) = tokio::sync::oneshot::channel();
        let inner = self.inner.clone();

        if let Ok(mut pending) = inner.pending.lock() {
            pending.insert(ask.id.clone(), answer);
        }

        // A window that is gone cannot be told, and cannot answer: that is a no.
        let delivered = inner.sender.send(ask).is_ok();

        Box::pin(async move {
            if !delivered {
                return false;
            }

            wait.await.unwrap_or(false)
        })
    }

    fn cancel(&self, ask_id: &str) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.remove(ask_id);
        }

        if let Ok(mut cancelled) = self.inner.cancelled.lock() {
            cancelled.push(ask_id.to_string());
        }
    }
}

/// The spike's window: the host's own console. Shows what is about to happen and reads one line;
/// only `y` or `yes` is a yes, and an unreadable or closed stdin is a no.
pub struct ConsolePrompter;

impl Prompter for ConsolePrompter {
    fn prompt(&self, ask: ApprovalAsk) -> BoxFuture<bool> {
        Box::pin(async move {
            eprintln!("\n[approval] {} wants to run: {}", ask.source.as_deref().unwrap_or("a caller"), ask.summary);

            if let Some(preview) = &ask.preview {
                eprintln!("[approval] arguments: {preview}");
            }

            eprintln!("[approval] allow once? [y/N] ");

            tokio::task::spawn_blocking(|| {
                let mut line = String::new();

                std::io::stdin().lock().read_line(&mut line).map(|read| read > 0 && matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")).unwrap_or(false)
            })
            .await
            .unwrap_or(false)
        })
    }
}
