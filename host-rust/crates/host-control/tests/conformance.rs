//! Conformance with `contracts/v1`: every fixture of every contract is validated by this crate and must
//! come out as its name says (`valid-*` accepted, `invalid-*` rejected) — the same rule the TypeScript
//! and Python suites apply to the very same files. The host also refuses to exist without them.

mod common;

use common::{contracts, contracts_dir};
use host_control::contracts::{Contracts, MATRIX_CONTRACT, MATRIX_GOLDEN};
use host_control::types::Tier;
use std::fs;
use std::path::Path;

#[test]
fn every_fixture_of_every_contract_comes_out_as_its_name_says() {
    let contracts = contracts();
    let mut total = 0;
    let mut valid = 0;
    let mut mismatches = Vec::new();

    for id in contracts.ids() {
        let fixtures = contracts.fixtures(id).unwrap();

        assert!(fixtures.iter().any(|f| f.valid) && fixtures.iter().any(|f| !f.valid), "{id} needs both valid and invalid fixtures");

        for fixture in fixtures {
            total += 1;

            if fixture.valid {
                valid += 1;
            }

            let accepted = contracts.is_valid(id, &fixture.doc);

            if accepted != fixture.valid {
                mismatches.push(format!("{id}/{}: expected {}, got {}", fixture.name, if fixture.valid { "valid" } else { "invalid" }, if accepted { "valid" } else { "invalid" }));
            }
        }
    }

    println!("contracts: {} schemas, {total} fixtures ({valid} valid, {} invalid)", contracts.ids().len(), total - valid);

    assert!(mismatches.is_empty(), "{} of {total} fixtures disagree with their name:\n{}", mismatches.len(), mismatches.join("\n"));
    assert_eq!(contracts.ids().len(), 16, "contracts/v1/index.json lists 16 contracts");
    assert!(total >= 129, "at least the 129 fixtures of the 0b freeze (131 with the 0b.1 redaction fixtures)");
}

#[test]
fn the_journal_with_a_token_is_invalid_here_too() {
    let contracts = contracts();

    for name in [
        "invalid-contains-token-field.json",
        "invalid-contains-capability-field.json",
        "invalid-contains-nonce-field.json",
        "invalid-token-in-reason.json",
        "invalid-token-in-command.json",
    ] {
        let fixture = contracts.fixtures("c3-control-audit-entry").unwrap().into_iter().find(|f| f.name == name).unwrap_or_else(|| panic!("{name} is missing"));

        assert!(!contracts.is_valid("c3-control-audit-entry", &fixture.doc), "{name} must be rejected");
    }
}

#[test]
fn the_matrix_comes_from_the_golden_fixture_not_from_this_crate() {
    let contracts = contracts();
    let golden: serde_json::Value = serde_json::from_str(&fs::read_to_string(contracts_dir().join("fixtures").join(MATRIX_CONTRACT).join(MATRIX_GOLDEN)).unwrap()).unwrap();
    let names = |key: &str| -> std::collections::HashSet<String> { golden[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect() };

    assert_eq!(contracts.matrix.backend_commands, names("backendCommands"));
    assert_eq!(contracts.matrix.retired_commands, names("retiredCommands"));
    assert_eq!(contracts.matrix.registry_commands, names("registryCommands"));
    assert_eq!(contracts.matrix.typed_registry_commands, names("typedRegistryCommands"));
    assert_eq!(contracts.matrix.shell_commands.len(), golden["shellCommands"].as_array().unwrap().len());
    assert_eq!(contracts.matrix.shell_tier("plugin", Some("remove")), Some(Ok(Tier::Destructive)));
    assert_eq!(contracts.matrix.shell_tier("plugin", None), Some(Ok(Tier::Read)));
    assert_eq!(contracts.matrix.shell_tier("branding", None), Some(Ok(Tier::Read)));
    assert_eq!(contracts.matrix.shell_tier("branding", Some("set")), Some(Ok(Tier::Mutate)));
    assert!(matches!(contracts.matrix.shell_tier("plugin", Some("bogus")), Some(Err(_))), "an action the matrix does not list is refused, never guessed");
    assert_eq!(contracts.matrix.shell_tier("nope", None), None);
}

/// A copy of contracts/v1 in a temp folder that a test can damage.
fn damaged(name: &str, damage: impl FnOnce(&Path)) -> Result<Contracts, String> {
    let target = std::env::temp_dir().join(format!("host-control-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&target);

    copy_dir(&contracts_dir(), &target);
    damage(&target);

    let result = Contracts::load(&target).map_err(|error| error.to_string());

    let _ = fs::remove_dir_all(&target);

    result
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();

    for item in fs::read_dir(from).unwrap() {
        let item = item.unwrap();
        let target = to.join(item.file_name());

        if item.file_type().unwrap().is_dir() {
            copy_dir(&item.path(), &target);
        } else {
            fs::copy(item.path(), target).unwrap();
        }
    }
}

#[test]
fn a_host_that_cannot_load_its_contracts_does_not_serve() {
    assert!(Contracts::load(Path::new("Z:/this/does/not/exist")).is_err(), "a missing folder");

    assert!(damaged("no-index", |dir| fs::remove_file(dir.join("index.json")).unwrap()).is_err(), "no index");
    assert!(damaged("no-schema", |dir| fs::remove_file(dir.join("c1-control-request.schema.json")).unwrap()).is_err(), "a schema that is listed but missing");
    assert!(damaged("bad-schema", |dir| fs::write(dir.join("c1-control-request.schema.json"), "{ not json").unwrap()).is_err(), "a schema that is not JSON");
    assert!(damaged("no-golden", |dir| fs::remove_file(dir.join("fixtures").join(MATRIX_CONTRACT).join(MATRIX_GOLDEN)).unwrap()).is_err(), "no golden matrix");
    assert!(
        damaged("bad-golden", |dir| fs::write(dir.join("fixtures").join(MATRIX_CONTRACT).join(MATRIX_GOLDEN), r#"{"version":1}"#).unwrap()).is_err(),
        "a golden matrix that does not validate against its own schema"
    );
    assert!(damaged("intact", |_| {}).is_ok(), "the undamaged copy loads");
}

#[test]
fn an_unset_contracts_variable_is_an_error_not_a_default() {
    // SAFETY: tests in this file that touch the environment are this one only; no other thread reads it.
    unsafe {
        std::env::remove_var(host_control::contracts::CONTRACTS_ENV);
    }

    assert!(Contracts::load_from_env().is_err());
}
