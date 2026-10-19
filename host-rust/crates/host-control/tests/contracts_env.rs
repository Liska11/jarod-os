//! Jarod-OS rename, phase 2: the contracts folder is named by `JAROD_OS_CONTRACTS_DIR`; the older `HERALD_OS_CONTRACTS_DIR`
//! is still read. Checked through `contracts_dir_from`, which takes the reader as an argument: no test touches the process environment.
use std::collections::HashMap;
use std::ffi::OsString;

use host_control::contracts::{contracts_dir_from, CONTRACTS_ENV, LEGACY_CONTRACTS_ENV};

fn reader(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
    let map: HashMap<String, OsString> = vars.iter().map(|(k, v)| ((*k).to_string(), OsString::from(*v))).collect();
    move |name| map.get(name).cloned()
}

#[test]
fn the_names_are_the_renamed_pair() {
    assert_eq!(CONTRACTS_ENV, "JAROD_OS_CONTRACTS_DIR");
    assert_eq!(LEGACY_CONTRACTS_ENV, "HERALD_OS_CONTRACTS_DIR");
}

#[test]
fn the_old_name_alone_is_still_read() {
    assert_eq!(contracts_dir_from(reader(&[("HERALD_OS_CONTRACTS_DIR", "C:/old")])), Some(OsString::from("C:/old")));
}

#[test]
fn the_new_name_wins_when_both_are_set() {
    let got = contracts_dir_from(reader(&[("HERALD_OS_CONTRACTS_DIR", "C:/old"), ("JAROD_OS_CONTRACTS_DIR", "D:/new")]));
    assert_eq!(got, Some(OsString::from("D:/new")));
}

#[test]
fn an_empty_new_name_falls_back_to_the_old_one() {
    let got = contracts_dir_from(reader(&[("JAROD_OS_CONTRACTS_DIR", ""), ("HERALD_OS_CONTRACTS_DIR", "C:/old")]));
    assert_eq!(got, Some(OsString::from("C:/old")));
}

#[test]
fn neither_set_is_none() {
    assert_eq!(contracts_dir_from(reader(&[("JAROD_OS_CONTRACTS_DIR", ""), ("OTHER", "x")])), None);
}
