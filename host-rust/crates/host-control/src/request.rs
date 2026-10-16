//! One decoded request line. Nothing in it is trusted: every accessor says what the TypeScript shell
//! reads for the same field (`ControlRequestShape`), including what it does with a field of the wrong
//! type — it reads it as absent, never repairs it.

use serde_json::{Map, Value};

pub struct Request {
    map: Map<String, Value>,
}

/// What a request id may look like: `[A-Za-z0-9._:-]{1,128}`. Long enough to be unique, short enough
/// to read in a journal, and never able to be a token by accident of shape alone being allowed — a
/// live secret is masked first (see `audit`).
pub fn is_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

impl Request {
    /// A JSON value that is not an object (`null`, a list, a number) is a request with no field at all,
    /// so it is refused for lacking a `cmd` rather than treated as something else.
    pub fn from_value(value: Value) -> Request {
        Request { map: if let Value::Object(map) = value { map } else { Map::new() } }
    }

    fn string(&self, key: &str) -> Option<&str> {
        self.map.get(key).and_then(Value::as_str)
    }

    /// `cmd`, trimmed; empty when absent or not a string.
    pub fn cmd(&self) -> String {
        self.string("cmd").map(|cmd| cmd.trim().to_string()).unwrap_or_default()
    }

    /// `cmd` exactly as sent, for the journal; empty when absent or not a string.
    pub fn cmd_raw(&self) -> String {
        self.string("cmd").unwrap_or_default().to_string()
    }

    /// The credential, only when it is a string.
    pub fn token(&self) -> Option<&str> {
        self.string("token")
    }

    /// `command` exactly as sent (journal), when it is a string.
    pub fn command_raw(&self) -> Option<String> {
        self.string("command").map(str::to_string)
    }

    /// `command`, trimmed; empty when absent or not a string.
    pub fn command_id(&self) -> String {
        self.string("command").map(|command| command.trim().to_string()).unwrap_or_default()
    }

    /// `source`, only when it is a non-empty string.
    pub fn source(&self) -> Option<String> {
        self.string("source").filter(|source| !source.is_empty()).map(str::to_string)
    }

    /// `args` when present (even `null`: present is not the same as absent).
    pub fn args(&self) -> Option<&Value> {
        self.map.get("args")
    }

    pub fn has_token_of_wrong_type(&self) -> bool {
        self.map.get("token").is_some_and(|token| !token.is_string())
    }

    pub fn capability_of_wrong_type(&self) -> bool {
        self.map.get("capability").is_some_and(|capability| !capability.is_string())
    }

    /// The capability presented, trimmed; empty when none.
    pub fn capability(&self) -> String {
        self.string("capability").map(|capability| capability.trim().to_string()).unwrap_or_default()
    }

    /// The caller's name for the attempt, trimmed; empty when none or not a string.
    pub fn request_id(&self) -> String {
        self.string("requestId").map(|id| id.trim().to_string()).unwrap_or_default()
    }

    /// `None` when the id is absent or well formed, otherwise why it cannot be used.
    pub fn request_id_problem(&self) -> Option<String> {
        let id = self.request_id();

        if id.is_empty() || is_request_id(&id) { None } else { Some("a requestId is a short opaque string, not a secret".to_string()) }
    }

    /// Everything that changes what a call does, for the capability binding. Provenance (`source`) is
    /// not behaviour and is excluded: renaming the caller must not invalidate an approval, and changing
    /// an argument must.
    pub fn binding_arguments(&self) -> Value {
        let mut out = Map::new();

        if let Some(command) = self.string("command") {
            out.insert("command".into(), Value::String(command.to_string()));
        }

        for key in ["args", "attachments", "shell"] {
            out.insert(key.into(), self.map.get(key).cloned().unwrap_or(Value::Null));
        }

        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_field_of_the_wrong_type_reads_as_absent() {
        let request = Request::from_value(json!({ "cmd": 42, "token": ["x"], "command": {}, "requestId": 1 }));

        assert_eq!(request.cmd(), "");
        assert_eq!(request.token(), None);
        assert!(request.has_token_of_wrong_type());
        assert_eq!(request.command_id(), "");
        assert_eq!(request.request_id(), "");
    }

    #[test]
    fn a_value_that_is_not_an_object_has_no_field() {
        for value in [json!(null), json!([1]), json!("x"), json!(3)] {
            assert_eq!(Request::from_value(value).cmd(), "");
        }
    }

    #[test]
    fn request_ids() {
        assert!(is_request_id("oc1"));
        assert!(is_request_id("a.b_c:d-e"));
        assert!(is_request_id(&"a".repeat(128)));
        assert!(!is_request_id(&"a".repeat(129)));
        assert!(!is_request_id(""));
        assert!(!is_request_id("has space"));
        assert!(!is_request_id("[REDACTED:token]"));
    }

    #[test]
    fn binding_ignores_the_source_and_keeps_the_arguments() {
        let a = Request::from_value(json!({ "cmd": "ui", "command": "x", "args": { "t": 1 }, "source": "agent" }));
        let b = Request::from_value(json!({ "cmd": "ui", "command": "x", "args": { "t": 1 }, "source": "someone else" }));
        let c = Request::from_value(json!({ "cmd": "ui", "command": "x", "args": { "t": 2 } }));

        assert_eq!(a.binding_arguments(), b.binding_arguments());
        assert_ne!(a.binding_arguments(), c.binding_arguments());
    }
}
