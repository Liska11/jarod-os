//! Orphans, deduplication, the VHDX inventory, the zone ACL and the disk health probe.

mod common;

use common::{DAY, START, cleanup, request, rig, scratch, write};
use host_storage::StorageError;
use host_storage::health::{DiskHealthProbe, PowerShellProbe, Severity, Thresholds, evaluate};
use host_storage::volume::StorageVolume;
use host_storage::zone::Zone;
use std::fs;
use std::time::{Duration, UNIX_EPOCH};

fn age(path: &std::path::Path, days_before_now: u64) {
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;

    let mut options = fs::OpenOptions::new();

    options.write(true);

    // A directory is opened with backup semantics on Windows.
    #[cfg(windows)]
    options.custom_flags(0x0200_0000);

    let file = options.open(path).unwrap();

    file.set_modified(UNIX_EPOCH + Duration::from_millis(START - days_before_now * DAY)).unwrap();
}

#[test]
fn orphans_are_what_sits_where_a_lease_would_but_belongs_to_none() {
    let rig = rig("orphans");
    let known = rig.volume.reserve(&request("jarod.net", Zone::Downloads, 100)).unwrap();
    let root = rig.volume.root();

    // A directory left by a crash, a file dropped straight into a zone, a plugin that wrote outside its lease.
    let ghost = root.join("downloads").join("jarod.net").join("lease_deadbeefdeadbeef");
    let stray_file = root.join("cache").join("stray.bin");
    let outside_lease = root.join("downloads").join("jarod.net").join("not-a-lease.bin");

    write(&ghost.join("a.bin"), 300);
    write(&stray_file, 50);
    write(&outside_lease, 20);
    write(&known.path.join("fine.bin"), 10);

    let orphans = rig.volume.find_orphans().unwrap();
    let paths: Vec<_> = orphans.iter().map(|o| o.path.clone()).collect();

    assert!(paths.contains(&ghost) && paths.contains(&stray_file) && paths.contains(&outside_lease), "{paths:?}");
    assert!(!paths.iter().any(|p| p.starts_with(&known.path)), "a known lease is never an orphan");
    assert_eq!(orphans.iter().find(|o| o.path == ghost).unwrap().bytes, 300);
    cleanup(&rig);
}

#[test]
fn reclaiming_orphans_respects_age_dry_runs_and_protection() {
    let rig = rig("reclaim");
    let root = rig.volume.root().to_path_buf();
    let old = root.join("cache").join("p").join("lease_0000000000000001");
    let fresh = root.join("cache").join("p").join("lease_0000000000000002");
    let guarded = root.join("cache").join("p").join("lease_0000000000000003");

    for dir in [&old, &fresh, &guarded] {
        write(&dir.join("x.bin"), 100);
    }

    age(&old, 10);
    age(&guarded, 10);
    age(&fresh, 0);

    let relative = guarded.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");

    rig.volume.protect(&relative).unwrap();

    // Dry run: reported, kept.
    let (would, freed) = rig.volume.reclaim_orphans(7 * DAY, true).unwrap();

    assert_eq!(would.len(), 1);
    assert_eq!(freed, 0);
    assert!(old.exists());

    // For real: only the old, unprotected one goes.
    let (done, freed) = rig.volume.reclaim_orphans(7 * DAY, false).unwrap();

    assert_eq!(done.len(), 1);
    assert_eq!(freed, 100);
    assert!(!old.exists() && fresh.exists() && guarded.exists());
    cleanup(&rig);
}

#[cfg(windows)]
#[test]
fn an_orphan_link_is_removed_as_a_link_and_its_target_survives() {
    let rig = rig("orphan-link");
    let outside = scratch("orphan-link-outside");

    write(&outside.join("precious.txt"), 10);

    let link = rig.volume.root().join("temp").join("p").join("lease_00000000000000aa");

    fs::create_dir_all(link.parent().unwrap()).unwrap();

    let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside).output().unwrap();

    assert!(made.status.success());
    age(&outside, 30);

    let (done, _) = rig.volume.reclaim_orphans(0, false).unwrap();

    assert!(done.iter().any(|o| o.path == link));
    assert!(!link.exists(), "the junction is gone");
    assert!(outside.join("precious.txt").exists(), "what it pointed at is untouched");

    let _ = fs::remove_dir_all(&outside);
    cleanup(&rig);
}

fn kept(rig: &common::Rig, plugin: &str, zone: Zone, files: &[(&str, usize)]) -> host_storage::Lease {
    let lease = rig.volume.reserve(&request(plugin, zone, 10_000_000)).unwrap();

    for (name, bytes) in files {
        write(&lease.path.join(name), *bytes);
    }

    rig.volume.release(&lease.id).unwrap();

    lease
}

#[test]
fn identical_files_become_one_copy_and_nothing_else_changes() {
    let rig = rig("dedup");
    let a = kept(&rig, "jarod.models", Zone::Models, &[("m.gguf", 4096), ("other.bin", 4096)]);
    let b = kept(&rig, "jarod.models", Zone::Models, &[("copy.gguf", 4096)]);

    // `other.bin` has the same size but different content.
    fs::write(a.path.join("other.bin"), vec![b'y'; 4096]).unwrap();

    let dry = rig.volume.dedup(Zone::Models, 1024, true).unwrap();

    assert!(dry.dry_run && dry.linked.len() == 1 && dry.saved_bytes == 4096, "{dry:?}");
    assert!(fs::read(b.path.join("copy.gguf")).unwrap() == vec![b'x'; 4096]);

    let done = rig.volume.dedup(Zone::Models, 1024, false).unwrap();

    assert_eq!((done.linked.len(), done.saved_bytes), (1, 4096));

    // All three files still read as before, and the two identical ones now share one copy on disk:
    // appending through one is seen through the other.
    assert_eq!(fs::read(a.path.join("m.gguf")).unwrap(), vec![b'x'; 4096]);
    assert_eq!(fs::read(b.path.join("copy.gguf")).unwrap(), vec![b'x'; 4096]);
    assert_eq!(fs::read(a.path.join("other.bin")).unwrap(), vec![b'y'; 4096]);

    let linked = if done.linked[0].0.starts_with(&a.path) { &a } else { &b };
    let (survivor, duplicate) = (if linked.id == a.id { &b } else { &a }, done.linked[0].0.clone());
    let original = done.linked[0].1.clone();

    assert!(original.starts_with(&survivor.path) && duplicate.starts_with(&linked.path));

    {
        use std::io::Write;

        let mut file = fs::OpenOptions::new().append(true).open(&original).unwrap();

        file.write_all(b"+").unwrap();
    }

    assert_eq!(fs::metadata(&duplicate).unwrap().len(), 4097, "a hard link: one copy, two names");

    // Already one copy: asking again saves nothing and relinks nothing.
    let again = rig.volume.dedup(Zone::Models, 1024, false).unwrap();

    assert_eq!((again.linked.len(), again.saved_bytes), (0, 0), "{again:?}");
    cleanup(&rig);
}

#[test]
fn dedup_leaves_zones_that_change_and_leases_in_use_alone() {
    let rig = rig("dedup-guard");

    for zone in [Zone::Sandboxes, Zone::Updates, Zone::Temp, Zone::Profiles, Zone::Databases, Zone::SecurityLogs] {
        assert!(matches!(rig.volume.dedup(zone, 1, true), Err(StorageError::Refused(_))), "{zone:?}");
    }

    let active = rig.volume.reserve(&request("p", Zone::Cache, 10_000_000)).unwrap();

    write(&active.path.join("a.bin"), 2048);

    let locked = kept(&rig, "p", Zone::Cache, &[("b.bin", 2048)]);
    let free = kept(&rig, "p", Zone::Cache, &[("c.bin", 2048)]);
    let other = kept(&rig, "p", Zone::Cache, &[("d.bin", 2048)]);

    rig.volume.set_locked(&locked.id, true).unwrap();

    let report = rig.volume.dedup(Zone::Cache, 1, true).unwrap();

    // Only the two idle copies are candidates; the active lease and the locked one are not touched.
    assert_eq!(report.linked.len(), 1, "{report:?}");
    assert!(
        report.linked.iter().all(|(dup, orig)| [&free.path, &other.path].iter().any(|p| dup.starts_with(*p)) && [&free.path, &other.path].iter().any(|p| orig.starts_with(*p)))
    );
    cleanup(&rig);
}

#[test]
fn the_vhdx_inventory_lists_every_virtual_disk_largest_first() {
    let rig = rig("vhdx");
    let one = kept(&rig, "jarod.hyperv", Zone::Sandboxes, &[("base.vhdx", 3000), ("notes.txt", 10)]);
    let two = kept(&rig, "jarod.hyperv", Zone::Sandboxes, &[("diff.VHDX", 500)]);

    write(&rig.volume.root().join("models").join("not-a-vm.vhdx"), 9999);

    let inventory = rig.volume.inventory_vhdx().unwrap();

    assert_eq!(inventory.iter().map(|v| v.bytes).collect::<Vec<_>>(), vec![3000, 500]);
    assert!(inventory[0].path.starts_with(&one.path) && inventory[1].path.starts_with(&two.path), "only the sandboxes zone is inventoried");
    cleanup(&rig);
}

#[cfg(windows)]
#[test]
fn the_zone_root_gets_a_protected_user_only_dacl_read_back_from_the_live_directory() {
    use host_storage::acl::{FULL_CONTROL, assert_hardened, current_user, harden_zone_root, read_zone_dacl};

    let root = scratch("acl");
    let me = current_user().unwrap();

    harden_zone_root(&root, &me).unwrap();

    let live = read_zone_dacl(&root).unwrap();

    assert!(live.protected, "no inherited entries");
    assert_eq!(live.aces, vec![(me.clone(), FULL_CONTROL)], "exactly this user, full control, nobody else");
    assert!(assert_hardened(&live, &me).is_ok());

    // What is created beneath inherits that policy and the host (this user) can still work in it.
    let child = root.join("models");

    fs::create_dir(&child).unwrap();
    fs::write(child.join("a.bin"), b"hello").unwrap();

    let inherited = read_zone_dacl(&child).unwrap();

    assert!(!inherited.protected && inherited.aces.iter().all(|(sid, _)| *sid == me), "{:?}", inherited.aces);

    // The checker refuses anything broader.
    let mut broader = read_zone_dacl(&root).unwrap();

    broader.aces.push(("S-1-1-0".into(), 0x120089));
    assert!(assert_hardened(&broader, &me).is_err(), "Everyone");

    let mut unprotected = read_zone_dacl(&root).unwrap();

    unprotected.protected = false;
    assert!(assert_hardened(&unprotected, &me).is_err());
    for broad in ["S-1-1-0", "S-1-5-7", "S-1-5-18", "S-1-5-32-544", "S-1-5-11", "S-1-5-32-545"] {
        assert!(harden_zone_root(&root, broad).is_err(), "{broad} must never be granted the zone");
    }

    assert_eq!(read_zone_dacl(&root).unwrap().aces, vec![(me.clone(), FULL_CONTROL)], "a refused request changes nothing");
    assert!(harden_zone_root(&root.join("missing"), &me).is_err());
    assert!(harden_zone_root(&root, "everyone").is_err());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_health_probe_answers_or_says_it_cannot_and_the_alert_rules_run_on_whatever_it_got() {
    // Read-only query of this machine's disks. Some counters need elevation, so an empty or partial answer
    // is a valid answer; the point is that nothing here can panic or delete anything.
    match PowerShellProbe.probe() {
        Ok(disks) => {
            println!("disk health: {} disk(s)", disks.len());

            for disk in &disks {
                println!("  {} health={} temp={:?} wear={:?}", disk.name, disk.health, disk.temperature_c, disk.wear_percent);
            }

            let alerts = evaluate(&disks, &Thresholds::default());

            assert!(alerts.iter().all(|a| matches!(a.severity, Severity::Warning | Severity::Critical)));
        }
        Err(error) => println!("disk health unavailable here: {error}"),
    }
}
