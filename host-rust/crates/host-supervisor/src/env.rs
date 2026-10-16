//! What a child process is allowed to know: its environment, built rather than inherited.
//!
//! The names in `c5-control-env-names` (the control endpoint, the per-launch tokens, the gateway token)
//! are authority. A child never inherits one: they are stripped from whatever the parent had, they cannot
//! be set through the ordinary `set`, and the only way in is [`ChildEnv::grant_control`], which is explicit,
//! per name, and only for a name the contract lists. The list is loaded from `contracts/v1`, not copied.
//! Windows compares environment names without regard to case, so `herald_os_control_token` is the same
//! name and is stripped too.

use host_control::contracts::Contracts;
use std::collections::{BTreeMap, HashSet};
use std::fmt;

pub const C5_CONTRACT: &str = "c5-control-env-names";
const C5_GOLDEN: &str = "valid-current.json";

#[derive(Debug, PartialEq, Eq)]
pub struct EnvError(pub String);

impl fmt::Display for EnvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EnvError {}

/// The names of the control environment, from the contract's golden fixture.
pub fn control_env_names(contracts: &Contracts) -> Result<Vec<String>, EnvError> {
    let fixtures = contracts.fixtures(C5_CONTRACT).map_err(|error| EnvError(error.to_string()))?;
    let golden = fixtures.iter().find(|fixture| fixture.name == C5_GOLDEN && fixture.valid).ok_or_else(|| EnvError(format!("{C5_CONTRACT}/{C5_GOLDEN} is missing")))?;
    let names: Vec<String> =
        golden.doc.as_array().ok_or_else(|| EnvError("the C5 golden fixture is not a list".into()))?.iter().filter_map(|n| n.as_str().map(str::to_string)).collect();

    if names.is_empty() {
        return Err(EnvError("the C5 golden fixture lists no name: refusing to build a child environment".into()));
    }

    Ok(names)
}

/// A variable name an operating system accepts: not empty, no `=`, no NUL.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['=', '\0']) && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '(' | ')' | '.' | '-'))
}

/// The essentials a Windows program needs to start: where Windows is, where to look for programs, where to
/// put temporary files, who it is running as. No keys, no tokens, nothing that is not plumbing.
pub const WINDOWS_ESSENTIALS: &[&str] = &[
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
];

#[derive(Clone)]
pub struct ChildEnv {
    vars: BTreeMap<String, String>,
    control: HashSet<String>,
}

impl fmt::Debug for ChildEnv {
    /// Names only: a value may be a token.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChildEnv").field("names", &self.vars.keys().collect::<Vec<_>>()).finish()
    }
}

impl ChildEnv {
    pub fn new(control_names: &[String]) -> ChildEnv {
        ChildEnv { vars: BTreeMap::new(), control: control_names.iter().map(|n| n.to_ascii_uppercase()).collect() }
    }

    pub fn is_control(&self, name: &str) -> bool {
        self.control.contains(&name.to_ascii_uppercase())
    }

    /// Only what is on `allow` (compared without case), never a control name, whatever `allow` says.
    pub fn inherit_allowlisted(mut self, parent: &[(String, String)], allow: &[&str]) -> ChildEnv {
        let allow: HashSet<String> = allow.iter().map(|name| name.to_ascii_uppercase()).collect();

        for (name, value) in parent {
            if valid_name(name) && allow.contains(&name.to_ascii_uppercase()) && !self.is_control(name) {
                self.vars.insert(name.clone(), value.clone());
            }
        }

        self
    }

    /// Compatibility with a launcher that passes everything through (provider keys and all): the whole parent
    /// environment except the control names. Weaker than an allowlist, and named so.
    pub fn inherit_all_except_control(mut self, parent: &[(String, String)]) -> ChildEnv {
        for (name, value) in parent {
            if valid_name(name) && !self.is_control(name) {
                self.vars.insert(name.clone(), value.clone());
            }
        }

        self
    }

    /// An ordinary variable. A control name is refused here: authority is granted by name, on purpose.
    pub fn set(mut self, name: &str, value: &str) -> Result<ChildEnv, EnvError> {
        if !valid_name(name) {
            return Err(EnvError(format!("{name:?} is not a variable name")));
        }

        if self.is_control(name) {
            return Err(EnvError(format!("{name} is a control variable; it is granted with grant_control, never set")));
        }

        if value.contains('\0') {
            return Err(EnvError(format!("the value of {name} contains NUL")));
        }

        self.vars.insert(name.to_string(), value.to_string());

        Ok(self)
    }

    /// Hands one control variable to this child, knowingly. Only a name the contract lists.
    pub fn grant_control(mut self, name: &str, value: &str) -> Result<ChildEnv, EnvError> {
        if !self.is_control(name) {
            return Err(EnvError(format!("{name} is not a control variable of {C5_CONTRACT}; use set")));
        }

        if value.is_empty() || value.contains('\0') {
            return Err(EnvError(format!("the value of {name} is empty or contains NUL")));
        }

        self.vars.insert(name.to_ascii_uppercase(), value.to_string());

        Ok(self)
    }

    pub fn vars(&self) -> &BTreeMap<String, String> {
        &self.vars
    }

    /// The control names this child was granted.
    pub fn granted(&self) -> Vec<String> {
        self.vars.keys().filter(|name| self.is_control(name)).cloned().collect()
    }

    /// The values that are authority: what the child's output must be redacted against.
    pub fn granted_values(&self) -> Vec<String> {
        self.vars.iter().filter(|(name, _)| self.is_control(name)).map(|(_, value)| value.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["HERALD_OS_CONTROL_TOKEN".into(), "JAROD_GATEWAY_TOKEN".into()]
    }

    fn parent() -> Vec<(String, String)> {
        [
            ("PATH", "C:\\bin"),
            ("herald_os_control_token", "leak1"),
            ("HERALD_OS_CONTROL_TOKEN", "leak2"),
            ("JAROD_GATEWAY_TOKEN", "leak3"),
            ("OPENAI_API_KEY", "sk-key"),
            ("TEMP", "C:\\t"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn an_allowlist_takes_only_what_it_names_and_never_a_control_name() {
        let env = ChildEnv::new(&names()).inherit_allowlisted(&parent(), &["path", "TEMP", "HERALD_OS_CONTROL_TOKEN", "jarod_gateway_token"]);

        assert_eq!(env.vars().keys().cloned().collect::<Vec<_>>(), vec!["PATH".to_string(), "TEMP".to_string()]);
        assert!(!env.vars().values().any(|v| v.starts_with("leak") || v.starts_with("sk-")));
    }

    #[test]
    fn inheriting_everything_still_strips_the_control_names_in_any_case() {
        let env = ChildEnv::new(&names()).inherit_all_except_control(&parent());

        assert!(env.vars().contains_key("OPENAI_API_KEY") && env.vars().contains_key("PATH"));
        assert!(!env.vars().keys().any(|k| k.eq_ignore_ascii_case("HERALD_OS_CONTROL_TOKEN") || k.eq_ignore_ascii_case("JAROD_GATEWAY_TOKEN")));
    }

    #[test]
    fn control_names_are_granted_on_purpose_never_set() {
        assert!(ChildEnv::new(&names()).set("JAROD_GATEWAY_TOKEN", "x").is_err());
        assert!(ChildEnv::new(&names()).set("jarod_gateway_token", "x").is_err(), "case does not matter");

        let env = ChildEnv::new(&names()).grant_control("jarod_gateway_token", "granted-value-123").unwrap();

        assert_eq!(env.granted(), vec!["JAROD_GATEWAY_TOKEN".to_string()]);
        assert_eq!(env.granted_values(), vec!["granted-value-123".to_string()]);
        assert!(ChildEnv::new(&names()).grant_control("PATH", "x").is_err(), "only a name the contract lists");
        assert!(ChildEnv::new(&names()).grant_control("JAROD_GATEWAY_TOKEN", "").is_err());
        assert!(!format!("{env:?}").contains("granted-value-123"), "Debug prints names, not values");
    }

    #[test]
    fn names_and_values_are_validated() {
        let env = ChildEnv::new(&names());

        for bad in ["", "A=B", "A\0B", "has space", "é"] {
            assert!(env.clone().set(bad, "v").is_err(), "{bad:?}");
        }

        assert!(env.clone().set("FINE_NAME", "a\0b").is_err());
        assert!(env.set("PROGRAMFILES(X86)", "C:\\x").is_ok());
    }
}
