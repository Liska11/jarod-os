//! The vocabulary the contracts share (C1, C2, C3).

use serde::{Deserialize, Serialize};

/// What a command is worth. The order is the ladder: `read` < `act` < `mutate` < `destructive`.
/// `read` and `act` are satisfied by a credential; `mutate` and `destructive` also need an approval
/// this process witnessed itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Read,
    Act,
    Mutate,
    Destructive,
}

impl Tier {
    pub fn parse(value: &str) -> Option<Tier> {
        match value {
            "read" => Some(Tier::Read),
            "act" => Some(Tier::Act),
            "mutate" => Some(Tier::Mutate),
            "destructive" => Some(Tier::Destructive),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Read => "read",
            Tier::Act => "act",
            Tier::Mutate => "mutate",
            Tier::Destructive => "destructive",
        }
    }

    pub fn needs_approval(self) -> bool {
        matches!(self, Tier::Mutate | Tier::Destructive)
    }
}

/// Who is asking. `Backend` and `Cli` hold a token from this host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Client {
    Backend,
    Cli,
    Plugin,
    Ui,
}

/// `Client`, or nobody: what the journal calls a caller that never proved who it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JournalClient {
    Backend,
    Cli,
    Plugin,
    Ui,
    Unauthenticated,
}

impl From<Client> for JournalClient {
    fn from(client: Client) -> Self {
        match client {
            Client::Backend => JournalClient::Backend,
            Client::Cli => JournalClient::Cli,
            Client::Plugin => JournalClient::Plugin,
            Client::Ui => JournalClient::Ui,
        }
    }
}

/// Which door a policy guards: the shared panel socket, or the desktop server the backend dials.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    Panel,
    Backend,
}

/// The four codes the adjudicator refuses with (`c1-control-decision`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefusalCode {
    Unauthenticated,
    Unauthorized,
    Unsupported,
    Invalid,
}

/// How a request ended, in the vocabulary the caller, the journal and the tests share.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostCode {
    Ok,
    Unauthenticated,
    Unauthorized,
    Unsupported,
    Invalid,
    ExecutionFailed,
    DeniedPolicy,
    DeniedApproval,
    Expired,
    Replay,
    ApprovalGranted,
    CapabilityUnavailable,
    CapabilityMismatch,
}

impl From<RefusalCode> for HostCode {
    fn from(code: RefusalCode) -> Self {
        match code {
            RefusalCode::Unauthenticated => HostCode::Unauthenticated,
            RefusalCode::Unauthorized => HostCode::Unauthorized,
            RefusalCode::Unsupported => HostCode::Unsupported,
            RefusalCode::Invalid => HostCode::Invalid,
        }
    }
}

impl HostCode {
    pub fn as_str(self) -> &'static str {
        match self {
            HostCode::Ok => "ok",
            HostCode::Unauthenticated => "unauthenticated",
            HostCode::Unauthorized => "unauthorized",
            HostCode::Unsupported => "unsupported",
            HostCode::Invalid => "invalid",
            HostCode::ExecutionFailed => "execution-failed",
            HostCode::DeniedPolicy => "denied-policy",
            HostCode::DeniedApproval => "denied-approval",
            HostCode::Expired => "expired",
            HostCode::Replay => "replay",
            HostCode::ApprovalGranted => "approval-granted",
            HostCode::CapabilityUnavailable => "capability-unavailable",
            HostCode::CapabilityMismatch => "capability-mismatch",
        }
    }
}
