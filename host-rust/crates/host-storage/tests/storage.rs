//! Reservations, leases, quotas and a volume that refuses to open on a state it cannot trust.

mod common;

use common::{DAY, GIB, cleanup, contracts, reopen, request, rig, rig_with, scratch, write};
use host_storage::volume::{LEASE_CONTRACT, LeaseState, STATE_VERSION, StorageVolume};
use host_storage::zone::{PROTECTED, RESERVABLE, Zone};
use host_storage::{StorageError, ZonedVolume};
use serde_json::json;
use std::fs;
use std::path::Path;

#[test]
fn a_lease_is_a_bounded_directory_inside_one_zone_and_never_the_root() {
    let rig = rig("lease");
    let lease = rig.volume.reserve(&request("jarod.models", Zone::Models, 4 * GIB)).unwrap();
    let root = fs::canonicalize(rig.volume.root()).unwrap();

    assert!(lease.path.is_dir());
    assert!(lease.path.starts_with(root.join("models").join("jarod.models")), "{}", lease.path.display());
    assert_eq!(lease.path.file_name().unwrap().to_string_lossy(), lease.id);
    assert_eq!(lease.granted_bytes, 4 * GIB);
    assert!(lease.expires_at_ms > common::START);

    let json = lease.to_json();

    assert!(contracts().is_valid(LEASE_CONTRACT, &json), "{json}: {}", contracts().explain(LEASE_CONTRACT, &json));
    assert!(!json["path"].as_str().unwrap().contains(".."));
    assert!(!json["path"].as_str().unwrap().starts_with(r"\\?\"), "the verbatim prefix is hidden from the plugin");
    assert_eq!(rig.volume.resolve(Zone::Models), root.join("models"));

    cleanup(&rig);
}

#[test]
fn every_fixture_of_the_reservation_contract_is_honoured_by_the_volume() {
    let rig = rig("fixtures");
    let contracts = contracts();

    for fixture in contracts.fixtures("c9-storage-reservation").unwrap() {
        let answer = rig.volume.reserve_json(&fixture.doc);

        if fixture.valid {
            let lease = answer.unwrap_or_else(|error| panic!("{} should be granted: {error}", fixture.name));

            assert!(contracts.is_valid(LEASE_CONTRACT, &lease), "{}: {lease}", fixture.name);
        } else {
            assert!(answer.is_err(), "{} must be refused", fixture.name);
        }
    }

    // The protected zones get an answer that says why.
    for zone in ["profiles", "databases", "security-logs"] {
        let answer = rig.volume.reserve_json(&json!({ "plugin": "p", "zone": zone, "requestedBytes": 1, "purpose": "x" }));

        assert!(matches!(answer, Err(StorageError::ZoneNotReservable(_))), "{zone}: {answer:?}");
    }

    cleanup(&rig);
}

#[test]
fn the_protected_zones_cannot_be_reserved_even_by_a_request_built_in_code() {
    let rig = rig("protected");

    for zone in PROTECTED {
        assert!(matches!(rig.volume.reserve(&request("p", zone, 1)), Err(StorageError::ZoneNotReservable(_))), "{zone:?}");
    }

    assert_eq!(RESERVABLE.len(), 7);
    cleanup(&rig);
}

#[test]
fn a_zone_quota_counts_what_is_written_and_what_is_still_owed() {
    let rig = rig_with("quota", |config| {
        config.quotas.insert(Zone::Cache, 1000);
    });
    let first = rig.volume.reserve(&request("p", Zone::Cache, 600)).unwrap();

    // 600 promised, nothing written.
    assert_eq!(rig.volume.committed(Zone::Cache).unwrap(), 600);
    assert!(matches!(rig.volume.reserve(&request("p", Zone::Cache, 401)), Err(StorageError::QuotaExceeded { quota: 1000, committed: 600, requested: 401, .. })));

    // 100 written: still 600 committed (100 on disk + 500 owed).
    write(&first.path.join("a.bin"), 100);
    assert_eq!(rig.volume.committed(Zone::Cache).unwrap(), 600);

    let second = rig.volume.reserve(&request("p", Zone::Cache, 400)).unwrap();

    assert_eq!(rig.volume.committed(Zone::Cache).unwrap(), 1000);
    assert!(rig.volume.reserve(&request("q", Zone::Cache, 1)).is_err());

    // Another zone is unaffected by this zone's quota.
    assert!(rig.volume.reserve(&request("p", Zone::Temp, 1_000_000)).is_ok());

    // A plugin that writes past its grant is counted for what it wrote.
    write(&second.path.join("b.bin"), 900);
    assert_eq!(rig.volume.committed(Zone::Cache).unwrap(), 100 + 900 + 500, "on disk 1000, plus the 500 the first lease is still owed");

    cleanup(&rig);
}

#[test]
fn the_space_kept_for_the_host_and_the_space_already_promised_come_off_the_top() {
    let rig = rig_with("space", |config| config.min_free_bytes = 400);

    rig.space.set(1000);

    assert!(matches!(rig.volume.reserve(&request("p", Zone::Temp, 700)), Err(StorageError::InsufficientSpace { available: 1000, needed: 1100 })));
    rig.volume.reserve(&request("p", Zone::Temp, 600)).unwrap();
    // The disk still says 1000 free, but 600 of it is spoken for: 1 + 400 + 600 > 1000.
    assert!(matches!(rig.volume.reserve(&request("p", Zone::Cache, 1)), Err(StorageError::InsufficientSpace { .. })));
    // Zero bytes is not a request.
    assert!(rig.volume.reserve(&request("p", Zone::Cache, 0)).is_err());
    // Exactly what is left is fine.
    rig.space.set(1001);
    assert!(rig.volume.reserve(&request("p", Zone::Cache, 1)).is_ok());

    cleanup(&rig);
}

#[test]
fn a_request_cannot_ask_for_more_than_the_configured_maximum() {
    let rig = rig_with("max", |config| config.max_request_bytes = 1000);

    assert!(rig.volume.reserve(&request("p", Zone::Temp, 1001)).is_err());
    assert!(rig.volume.reserve(&request("p", Zone::Temp, 1000)).is_ok());
    cleanup(&rig);
}

#[test]
fn leases_expire_stop_being_promised_and_keep_their_content_for_the_purge() {
    let rig = rig_with("expiry", |config| {
        config.quotas.insert(Zone::Temp, 1000);
        config.lease_ttl_ms = 1000;
    });
    let lease = rig.volume.reserve(&request("p", Zone::Temp, 1000)).unwrap();

    write(&lease.path.join("x.tmp"), 10);
    assert!(rig.volume.reserve(&request("p", Zone::Temp, 1)).is_err(), "the quota is full");

    rig.clock.advance(1001);

    // Expired on the next reservation: its unwritten bytes are no longer owed; what it wrote stays on disk.
    assert!(rig.volume.reserve(&request("p", Zone::Temp, 900)).is_ok());
    assert!(lease.path.join("x.tmp").exists(), "expiry deletes nothing: only the purge does");

    let states: Vec<_> = rig.volume.leases().unwrap().into_iter().map(|(l, s)| (l.id == lease.id, s)).collect();

    assert!(states.contains(&(true, LeaseState::Expired)));
    cleanup(&rig);
}

#[test]
fn a_lease_can_be_renewed_but_never_past_its_maximum_age() {
    let rig = rig_with("renew", |config| {
        config.lease_ttl_ms = 1000;
        config.max_lease_age_ms = 2500;
    });
    let lease = rig.volume.reserve(&request("p", Zone::Temp, 10)).unwrap();

    rig.clock.advance(900);

    let renewed = rig.volume.renew(&lease.id).unwrap();

    assert_eq!(renewed.expires_at_ms, common::START + 900 + 1000);

    rig.clock.advance(1500);

    assert_eq!(rig.volume.renew(&lease.id).unwrap().expires_at_ms, common::START + 2500, "capped at the maximum age");
    assert!(matches!(rig.volume.renew("lease_0000000000000000"), Err(StorageError::UnknownLease(_))));

    rig.volume.release(&lease.id).unwrap();
    assert!(rig.volume.renew(&lease.id).is_err(), "a released lease is not active");
    cleanup(&rig);
}

#[test]
fn release_keeps_the_content_counted_and_discard_removes_it() {
    let rig = rig_with("release", |config| {
        config.quotas.insert(Zone::Models, 1000);
    });
    let lease = rig.volume.reserve(&request("p", Zone::Models, 800)).unwrap();

    write(&lease.path.join("m.gguf"), 300);
    rig.volume.release(&lease.id).unwrap();

    // Released: nothing owed any more, 300 on disk.
    assert_eq!(rig.volume.committed(Zone::Models).unwrap(), 300);
    assert!(lease.path.join("m.gguf").exists());

    rig.volume.set_locked(&lease.id, true).unwrap();
    assert!(matches!(rig.volume.discard(&lease.id), Err(StorageError::Refused(_))), "a model in use is not discarded");
    rig.volume.set_locked(&lease.id, false).unwrap();

    assert_eq!(rig.volume.discard(&lease.id).unwrap(), 300);
    assert!(!lease.path.exists());
    assert_eq!(rig.volume.committed(Zone::Models).unwrap(), 0);
    assert!(matches!(rig.volume.discard(&lease.id), Err(StorageError::UnknownLease(_))));
    cleanup(&rig);
}

#[test]
fn the_state_survives_a_restart() {
    let rig = rig("restart");
    let lease = rig.volume.reserve(&request("p", Zone::Models, 10)).unwrap();

    rig.volume.set_locked(&lease.id, true).unwrap();
    rig.volume.protect("updates/jarod.updater/lease_x/slot-a").unwrap();

    let again = reopen(&rig).unwrap();
    let leases = again.leases().unwrap();

    assert_eq!(leases.len(), 1);
    assert_eq!(leases[0].0.id, lease.id);
    assert!(matches!(again.discard(&lease.id), Err(StorageError::Refused(_))), "the lock was remembered");
    cleanup(&rig);
}

fn state_file(rig: &common::Rig) -> std::path::PathBuf {
    rig.volume.root().join(".host").join("state.json")
}

#[test]
fn a_volume_that_cannot_trust_its_state_does_not_open() {
    let rig = rig("tamper");
    let lease = rig.volume.reserve(&request("p", Zone::Models, 10)).unwrap();
    let path = state_file(&rig);
    let good = fs::read_to_string(&path).unwrap();
    let open = || reopen(&rig);

    // Not JSON.
    fs::write(&path, "{ not json").unwrap();
    assert!(matches!(open(), Err(StorageError::State(_))));

    // Another version.
    fs::write(&path, good.replace(&format!("\"version\": {STATE_VERSION}"), "\"version\": 99")).unwrap();
    assert!(matches!(open(), Err(StorageError::State(_))));

    // An entry that names a path rather than a plugin or a lease.
    for (from, to) in [
        (r#""plugin": "p""#, r#""plugin": "..\\..\\Windows""#),
        (r#""plugin": "p""#, r#""plugin": "a/b""#),
        (lease.id.as_str(), "lease_..\\..\\..\\x"),
        (lease.id.as_str(), "not-a-lease"),
    ] {
        fs::write(&path, good.replace(from, to)).unwrap();
        assert!(matches!(open(), Err(StorageError::State(_))), "{from} -> {to}");
    }

    // A protected path the host would never build.
    let mut state: serde_json::Value = serde_json::from_str(&good).unwrap();

    state["protected"] = json!(["../outside", "C:\\Windows"]);
    fs::write(&path, state.to_string()).unwrap();
    assert!(matches!(open(), Err(StorageError::State(_))));

    // A protected zone smuggled in as a lease zone.
    fs::write(&path, good.replace("\"zone\": \"models\"", "\"zone\": \"profiles\"")).unwrap();
    assert!(matches!(open(), Err(StorageError::State(_))));

    // Restored, it opens again.
    fs::write(&path, &good).unwrap();
    assert!(open().is_ok());
    cleanup(&rig);
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    let output = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
}

#[cfg(windows)]
#[test]
fn a_link_planted_where_a_lease_goes_is_refused_and_nothing_is_created_outside() {
    let rig = rig("planted");
    let outside = scratch("planted-outside");

    // A plugin directory that is really a junction to somewhere else.
    junction(&rig.volume.root().join("models").join("evil"), &outside);

    let answer = rig.volume.reserve(&request("evil", Zone::Models, 10));

    assert!(matches!(answer, Err(StorageError::PathRefused(_))), "{answer:?}");
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0, "the host created nothing in the target of the link");

    // The same through the zone itself.
    fs::remove_dir(rig.volume.root().join("models").join("evil")).unwrap();
    fs::remove_dir_all(rig.volume.root().join("cache")).unwrap();
    junction(&rig.volume.root().join("cache"), &outside);

    assert!(matches!(rig.volume.reserve(&request("p", Zone::Cache, 10)), Err(StorageError::PathRefused(_))));
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);

    fs::remove_dir(rig.volume.root().join("cache")).unwrap();
    let _ = fs::remove_dir_all(&outside);
    cleanup(&rig);
}

#[cfg(windows)]
#[test]
fn a_root_that_is_a_junction_is_refused_at_open() {
    let base = scratch("rootlink");
    let target = base.join("real");

    fs::create_dir_all(&target).unwrap();
    junction(&base.join("link"), &target);

    let config = host_storage::VolumeConfig::new(base.join("link"));
    let opened = ZonedVolume::open(config, contracts(), std::sync::Arc::new(host_storage::space::FixedSpace::new(GIB)), common::ManualClock::new(common::START));

    assert!(matches!(opened, Err(StorageError::PathRefused(_))), "{:?}", opened.err());
    fs::remove_dir(base.join("link")).unwrap();
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn concurrent_reservations_never_exceed_the_quota() {
    let rig = rig_with("race", |config| {
        config.quotas.insert(Zone::Cache, 1000);
    });
    let volume = std::sync::Arc::new(rig.volume);
    let mut handles = Vec::new();

    for number in 0..32 {
        let volume = volume.clone();

        handles.push(std::thread::spawn(move || volume.reserve(&request(&format!("p{number}"), Zone::Cache, 100)).is_ok()));
    }

    let granted = handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();

    assert_eq!(granted, 10, "1000 / 100, whatever the interleaving");
    assert_eq!(volume.committed(Zone::Cache).unwrap(), 1000);
    let _ = fs::remove_dir_all(&rig.root);
}

#[test]
fn a_real_disk_works_end_to_end() {
    // The system's own free-space probe, on the real temp volume, with a small reservation.
    let root = scratch("real");
    let mut config = host_storage::VolumeConfig::new(root.join("volume"));

    config.min_free_bytes = 0;

    let volume = ZonedVolume::open(config, contracts(), std::sync::Arc::new(host_storage::space::SystemSpace), common::ManualClock::new(common::START));

    if let Ok(volume) = volume {
        assert!(volume.available_space().unwrap() > 0);

        let lease = volume.reserve(&request("jarod.test", Zone::Temp, 1024 * 1024)).unwrap();

        write(&lease.path.join("a.bin"), 1024);
        assert_eq!(volume.committed(Zone::Temp).unwrap(), 1024 * 1024);
        assert_eq!(volume.discard(&lease.id).unwrap(), 1024);
    }

    let _ = fs::remove_dir_all(&root);
    let _ = DAY;
}
