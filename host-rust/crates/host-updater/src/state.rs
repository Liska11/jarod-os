//! What survives a restart: which slot runs, which one is the last known good, whether a trial is open.
//! Written atomically (a sibling, then a rename); a file that does not read back as a consistent state is
//! an error, because guessing which slot to run is how a machine ends up on a version nobody validated.

use crate::error::UpdateError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const STATE_VERSION: u32 = 1;
pub const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    A,
    B,
}

impl Slot {
    pub fn other(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Slot::A => "a",
            Slot::B => "b",
        }
    }

    pub fn dir_name(self) -> &'static str {
        match self {
            Slot::A => "slot-a",
            Slot::B => "slot-b",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotRecord {
    pub version: String,
    /// It ran, and said it was healthy.
    pub validated: bool,
}

/// An update that has been switched to and has not yet said it is healthy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trial {
    pub slot: Slot,
    pub activated_ms: u64,
    /// How many times it was started without ever confirming.
    pub boots: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at_ms: u64,
    pub event: String,
    pub version: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub current: Option<Slot>,
    /// The last known good while a trial is open; the previous version after one succeeded.
    pub previous: Option<Slot>,
    pub slots: BTreeMap<String, SlotRecord>,
    pub pending: Option<Trial>,
    /// Versions that failed their trial here: not installed again.
    pub blocked: Vec<String>,
    pub history: Vec<HistoryEntry>,
}

impl Default for State {
    fn default() -> Self {
        State { version: STATE_VERSION, current: None, previous: None, slots: BTreeMap::new(), pending: None, blocked: Vec::new(), history: Vec::new() }
    }
}

impl State {
    pub fn record(&self, slot: Slot) -> Option<&SlotRecord> {
        self.slots.get(slot.name())
    }

    pub fn push_history(&mut self, at_ms: u64, event: &str, version: &str, detail: &str) {
        self.history.push(HistoryEntry { at_ms, event: event.into(), version: version.into(), detail: detail.into() });

        if self.history.len() > HISTORY_LIMIT {
            let excess = self.history.len() - HISTORY_LIMIT;

            self.history.drain(..excess);
        }
    }

    /// The state must be internally consistent, or it is not trusted.
    pub fn check(&self) -> Result<(), UpdateError> {
        let bad = |why: &str| Err(UpdateError::State(format!("state.json is not consistent: {why}")));

        if self.version != STATE_VERSION {
            return bad(&format!("version {} (this host reads {STATE_VERSION})", self.version));
        }

        if self.current.is_some() && self.current == self.previous {
            return bad("the current and the previous slot are the same");
        }

        for slot in [self.current, self.previous].into_iter().flatten() {
            if self.record(slot).is_none() {
                return bad(&format!("slot {} is in use and has no record", slot.name()));
            }
        }

        for name in self.slots.keys() {
            if name != "a" && name != "b" {
                return bad(&format!("an unknown slot {name:?}"));
            }
        }

        if let Some(trial) = &self.pending
            && (Some(trial.slot) != self.current || self.previous.is_none())
        {
            return bad("a trial is open for a slot that is not current, or with no last known good to fall back to");
        }

        Ok(())
    }
}
