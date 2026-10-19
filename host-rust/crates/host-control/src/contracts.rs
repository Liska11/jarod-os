//! `contracts/v1`, read from disk: the schemas, the fixtures and the C2 authorization matrix.
//!
//! Nothing of the contracts is copied into this crate. The matrix the adjudicator uses is the golden
//! fixture `c2-authorization-matrix/valid-current.json`, validated against its own schema when it is
//! loaded; a missing folder, index, schema or golden file is an error, and a host that cannot load
//! its contracts does not serve.

use crate::types::Tier;
use jsonschema::Validator;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

pub const MATRIX_CONTRACT: &str = "c2-authorization-matrix";
pub const MATRIX_GOLDEN: &str = "valid-current.json";

/// The environment variable that names the contracts folder (`contracts/v1`).
pub const CONTRACTS_ENV: &str = "JAROD_OS_CONTRACTS_DIR";
/// Its name before the Jarod-OS rename (2026-10-19), still read when the new one is unset or empty.
pub const LEGACY_CONTRACTS_ENV: &str = "HERALD_OS_CONTRACTS_DIR";

/// The contracts folder named by the environment `get` reads: the new name first, then the old one; an empty value counts as
/// unset. Taking the reader as an argument lets the tests check the order without touching the process environment.
pub fn contracts_dir_from(get: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<std::ffi::OsString> {
    [CONTRACTS_ENV, LEGACY_CONTRACTS_ENV].into_iter().find_map(|name| get(name).filter(|v| !v.is_empty()))
}

#[derive(Debug)]
pub struct ContractsError(pub String);

impl fmt::Display for ContractsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ContractsError {}

fn fail<T>(message: impl Into<String>) -> Result<T, ContractsError> {
    Err(ContractsError(message.into()))
}

fn read_json(path: &Path) -> Result<Value, ContractsError> {
    let text = fs::read_to_string(path).map_err(|error| ContractsError(format!("cannot read {}: {error}", path.display())))?;

    serde_json::from_str(&text).map_err(|error| ContractsError(format!("{} is not JSON: {error}", path.display())))
}

/// What one shell command is worth: a constant, or a function of its first argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellTier {
    Constant(Tier),
    ByAction { default_action: String, actions: HashMap<String, Tier> },
}

/// The C2 matrix: which token opens which door, what is allow-listed, what is retired, what each shell
/// command is worth.
#[derive(Clone, Debug)]
pub struct Matrix {
    pub registry_commands: HashSet<String>,
    pub typed_registry_commands: HashSet<String>,
    pub retired_commands: HashSet<String>,
    pub backend_commands: HashSet<String>,
    pub shell_commands: HashMap<String, ShellTier>,
}

fn string_set(value: &Value, key: &str) -> Result<HashSet<String>, ContractsError> {
    let Some(items) = value.get(key).and_then(Value::as_array) else {
        return fail(format!("the matrix has no {key} list"));
    };

    items.iter().map(|item| item.as_str().map(str::to_string).ok_or_else(|| ContractsError(format!("{key} holds a non-string")))).collect()
}

fn tier_of(value: &Value, what: &str) -> Result<Tier, ContractsError> {
    value.as_str().and_then(Tier::parse).ok_or_else(|| ContractsError(format!("{what} is not a tier")))
}

impl Matrix {
    pub fn from_value(value: &Value) -> Result<Matrix, ContractsError> {
        let Some(shell) = value.get("shellCommands").and_then(Value::as_array) else {
            return fail("the matrix has no shellCommands list");
        };
        let mut shell_commands = HashMap::new();

        for entry in shell {
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                return fail("a shell command has no name");
            };
            let tier = if let Some(constant) = entry.get("tier") {
                ShellTier::Constant(tier_of(constant, &format!("the tier of {name}"))?)
            } else if let Some(by_action) = entry.get("tierByAction") {
                let Some(default_action) = by_action.get("defaultAction").and_then(Value::as_str) else {
                    return fail(format!("{name} has no defaultAction"));
                };
                let Some(actions) = by_action.get("actions").and_then(Value::as_object) else {
                    return fail(format!("{name} has no actions"));
                };
                let mut table = HashMap::new();

                for (action, tier) in actions {
                    table.insert(action.clone(), tier_of(tier, &format!("the tier of {name} {action}"))?);
                }

                if !table.contains_key(default_action) {
                    return fail(format!("{name}'s default action has no tier"));
                }

                ShellTier::ByAction { default_action: default_action.to_string(), actions: table }
            } else {
                return fail(format!("{name} has neither tier nor tierByAction"));
            };

            if shell_commands.insert(name.to_string(), tier).is_some() {
                return fail(format!("{name} is listed twice"));
            }
        }

        Ok(Matrix {
            registry_commands: string_set(value, "registryCommands")?,
            typed_registry_commands: string_set(value, "typedRegistryCommands")?,
            retired_commands: string_set(value, "retiredCommands")?,
            backend_commands: string_set(value, "backendCommands")?,
            shell_commands,
        })
    }

    /// The tier of a shell command for this request's first argument. `None` when the command is not
    /// in the table; an action the table does not list is `Err`, because the host refuses rather than
    /// guesses what an unknown action is worth.
    pub fn shell_tier(&self, command: &str, first_argument: Option<&str>) -> Option<Result<Tier, String>> {
        Some(match self.shell_commands.get(command)? {
            ShellTier::Constant(tier) => Ok(*tier),
            ShellTier::ByAction { default_action, actions } => {
                let action = first_argument.unwrap_or(default_action);

                actions.get(action).copied().ok_or_else(|| format!("{command} does not know the action {action}"))
            }
        })
    }

    pub fn knows_shell_command(&self, command: &str) -> bool {
        self.shell_commands.contains_key(command)
    }
}

pub struct Fixture {
    pub name: String,
    pub valid: bool,
    pub doc: Value,
}

struct Entry {
    fixtures: PathBuf,
    validator: Validator,
}

pub struct Contracts {
    dir: PathBuf,
    entries: HashMap<String, Entry>,
    order: Vec<String>,
    pub matrix: Matrix,
}

impl Contracts {
    /// The folder `JAROD_OS_CONTRACTS_DIR` names, or the older `HERALD_OS_CONTRACTS_DIR` when the new name is unset or empty
    /// (the new name wins). Neither set is an error: there is no built-in copy to fall back on, on purpose.
    pub fn load_from_env() -> Result<Contracts, ContractsError> {
        match contracts_dir_from(|name| std::env::var_os(name)) {
            Some(dir) => Contracts::load(Path::new(&dir)),
            None => fail(format!("{CONTRACTS_ENV} is not set: the contracts are loaded from disk and there is no built-in copy")),
        }
    }

    pub fn load(dir: &Path) -> Result<Contracts, ContractsError> {
        let index = read_json(&dir.join("index.json"))?;
        let Some(contracts) = index.get("contracts").and_then(Value::as_array) else {
            return fail("index.json has no contracts list");
        };

        if contracts.is_empty() {
            return fail("index.json lists no contract");
        }

        let mut entries = HashMap::new();
        let mut order = Vec::new();

        for contract in contracts {
            let text = |key: &str| contract.get(key).and_then(Value::as_str).map(str::to_string);
            let (Some(id), Some(schema), Some(fixtures)) = (text("id"), text("schema"), text("fixtures")) else {
                return fail("a contract of index.json lacks id, schema or fixtures");
            };
            let schema_value = read_json(&dir.join(&schema))?;
            let validator = jsonschema::validator_for(&schema_value).map_err(|error| ContractsError(format!("{schema} does not compile: {error}")))?;

            if entries.insert(id.clone(), Entry { fixtures: dir.join(fixtures), validator }).is_some() {
                return fail(format!("{id} is listed twice"));
            }

            order.push(id);
        }

        let golden = read_json(&dir.join("fixtures").join(MATRIX_CONTRACT).join(MATRIX_GOLDEN))?;
        let Some(matrix_entry) = entries.get(MATRIX_CONTRACT) else {
            return fail(format!("index.json does not list {MATRIX_CONTRACT}"));
        };

        if !matrix_entry.validator.is_valid(&golden) {
            return fail(format!("the golden matrix does not validate against its own schema ({MATRIX_CONTRACT})"));
        }

        let matrix = Matrix::from_value(&golden)?;

        Ok(Contracts { dir: dir.to_path_buf(), entries, order, matrix })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Contract ids, in the order of `index.json`.
    pub fn ids(&self) -> &[String] {
        &self.order
    }

    pub fn is_valid(&self, id: &str, doc: &Value) -> bool {
        self.entries.get(id).is_some_and(|entry| entry.validator.is_valid(doc))
    }

    /// Why `doc` fails `id`, for a test's message.
    pub fn explain(&self, id: &str, doc: &Value) -> String {
        match self.entries.get(id) {
            None => format!("no contract {id}"),
            Some(entry) => entry.validator.iter_errors(doc).map(|error| error.to_string()).collect::<Vec<_>>().join("; "),
        }
    }

    /// `valid-*.json` and `invalid-*.json` of one contract, by name.
    pub fn fixtures(&self, id: &str) -> Result<Vec<Fixture>, ContractsError> {
        let Some(entry) = self.entries.get(id) else {
            return fail(format!("no contract {id}"));
        };
        let mut names: Vec<_> = fs::read_dir(&entry.fixtures)
            .map_err(|error| ContractsError(format!("cannot read {}: {error}", entry.fixtures.display())))?
            .filter_map(|item| item.ok())
            .filter_map(|item| item.file_name().into_string().ok())
            .filter(|name| name.ends_with(".json"))
            .collect();

        names.sort();

        names
            .into_iter()
            .map(|name| {
                let valid = if name.starts_with("valid-") {
                    true
                } else if name.starts_with("invalid-") {
                    false
                } else {
                    return fail(format!("{id}/{name} is neither valid- nor invalid-"));
                };

                Ok(Fixture { doc: read_json(&entry.fixtures.join(&name))?, name, valid })
            })
            .collect()
    }
}
