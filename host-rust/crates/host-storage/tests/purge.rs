//! The purge: its order is never broken, the host's own data is never reached, and the last working
//! version survives everything.

mod common;

use common::{DAY, Rig, START, cleanup, request, rig_with, write};
use host_storage::purge::{PurgePolicy, PurgeReport, Tier};
use host_storage::volume::StorageVolume;
use host_storage::zone::Zone;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

struct World {
    rig: Rig,
    names: Vec<(&'static str, PathBuf)>,
}

impl World {
    fn path(&self, name: &str) -> &PathBuf {
        &self.names.iter().find(|(n, _)| *n == name).unwrap_or_else(|| panic!("no {name}")).1
    }

    fn exists(&self, name: &str) -> bool {
        self.path(name).exists()
    }
}

/// One lease with `data.bin` of `bytes` and the given marker files, released unless it is meant to stay active.
fn make(rig: &Rig, plugin: &str, zone: Zone, bytes: usize, markers: &[&str], keep: bool) -> (String, PathBuf) {
    let lease = rig.volume.reserve(&request(plugin, zone, (bytes as u64).max(1) + 1000)).unwrap();

    write(&lease.path.join("data.bin"), bytes);

    for marker in markers {
        write(&lease.path.join(marker), 1);
    }

    if keep {
        rig.volume.release(&lease.id).unwrap();
    }

    (lease.id, lease.path)
}

fn at(rig: &Rig, day: u64) {
    let target = START + day * DAY;
    let now = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);

    if target > now {
        rig.clock.advance(target - now);
    }
}

fn set_age(path: &PathBuf, day: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();

    file.set_modified(UNIX_EPOCH + Duration::from_millis(START + day * DAY)).unwrap();
}

/// A volume with something in every tier, and things that must never be touched. "Now" is day 100.
fn world() -> World {
    let rig = rig_with("purge", |config| config.lease_ttl_ms = 10 * DAY);
    let mut names: Vec<(&'static str, PathBuf)> = Vec::new();
    fn add(names: &mut Vec<(&'static str, PathBuf)>, name: &'static str, entry: (String, PathBuf)) {
        names.push((name, entry.1));
    }

    // Day 0: a model nobody has used, one in use (locked), one still being written.
    at(&rig, 0);
    add(&mut names, "model-unused", make(&rig, "jarod.models", Zone::Models, 700, &[], true));

    let locked = make(&rig, "jarod.models", Zone::Models, 700, &[], true);

    rig.volume.set_locked(&locked.0, true).unwrap();
    add(&mut names, "model-locked", locked);

    // Day 5: scratch space nobody released (it will expire).
    at(&rig, 5);
    add(&mut names, "temp-abandoned", make(&rig, "jarod.exec", Zone::Temp, 50, &[], false));

    // Updates, by age: three validated, one in use, and the last one is the last working version.
    at(&rig, 10);
    add(&mut names, "update-a", make(&rig, "jarod.updater", Zone::Updates, 400, &[".validated"], true));
    at(&rig, 20);
    add(&mut names, "update-current", make(&rig, "jarod.updater", Zone::Updates, 400, &[".validated", ".current"], true));
    at(&rig, 30);
    add(&mut names, "artifact-old", make(&rig, "jarod.build", Zone::Artifacts, 300, &[], true));
    at(&rig, 40);
    add(&mut names, "update-b", make(&rig, "jarod.updater", Zone::Updates, 400, &[".validated"], true));
    at(&rig, 50);
    add(&mut names, "cache-1", make(&rig, "jarod.rag", Zone::Cache, 100, &[], true));
    at(&rig, 70);
    add(&mut names, "cache-2", make(&rig, "jarod.rag", Zone::Cache, 100, &[], true));
    at(&rig, 80);
    add(&mut names, "update-last-good", make(&rig, "jarod.updater", Zone::Updates, 400, &[".validated"], true));
    at(&rig, 85);
    add(&mut names, "sandbox-finished", make(&rig, "jarod.sandbox", Zone::Sandboxes, 500, &[".finished"], true));
    add(&mut names, "sandbox-retained", make(&rig, "jarod.sandbox", Zone::Sandboxes, 500, &[".finished", ".retain"], true));
    add(&mut names, "sandbox-running", make(&rig, "jarod.sandbox", Zone::Sandboxes, 500, &[], true));
    at(&rig, 90);
    add(&mut names, "cache-3", make(&rig, "jarod.rag", Zone::Cache, 100, &[], true));
    at(&rig, 95);
    add(&mut names, "artifact-new", make(&rig, "jarod.build", Zone::Artifacts, 300, &[], true));

    // Day 99: a download in progress, with an old unfinished file inside it.
    at(&rig, 99);

    let download = make(&rig, "jarod.net", Zone::Downloads, 200, &[], false);

    write(&download.1.join("big.gguf.part"), 60);
    set_age(&download.1.join("big.gguf.part"), 0);

    let part_file = download.1.join("big.gguf.part");

    add(&mut names, "download-active", download);
    names.push(("download-part-file", part_file));
    add(&mut names, "model-active", make(&rig, "jarod.models", Zone::Models, 700, &[], false));

    // A stale interrupted file in a zone lease that is kept: its own tier-1 candidate. And a fresh one.
    let kept_download = make(&rig, "jarod.net", Zone::Downloads, 10, &[], true);

    write(&kept_download.1.join("old.part"), 40);
    set_age(&kept_download.1.join("old.part"), 10);
    write(&kept_download.1.join("fresh.part"), 40);
    set_age(&kept_download.1.join("fresh.part"), 100);
    names.push(("kept-old-part", kept_download.1.join("old.part")));
    names.push(("kept-fresh-part", kept_download.1.join("fresh.part")));
    names.push(("kept-download", kept_download.1));

    // Day 100: the scratch space nobody released has long since expired; the leases made on day 99 are active.
    at(&rig, 100);
    rig.volume.expire_leases().unwrap();

    let states: Vec<_> = rig.volume.leases().unwrap().into_iter().filter(|(_, s)| *s == host_storage::volume::LeaseState::Expired).map(|(l, _)| l.zone).collect();

    assert_eq!(states, vec![Zone::Temp], "only the abandoned scratch space ran out");

    // The host's own data, in the zones nothing may purge.
    for (zone, file) in [("profiles", "profile.json"), ("databases", "memory.sqlite"), ("security-logs", "control-audit.jsonl")] {
        let path = rig.volume.root().join(zone).join(file);

        write(&path, 2000);
        set_age(&path, 0);
        names.push((Box::leak(format!("protected-{zone}").into_boxed_str()), path));
    }

    World { rig, names }
}

fn all_tiers() -> PurgePolicy {
    PurgePolicy { max_tier: Tier::UnusedModels, allow_unused_models: true, ..PurgePolicy::default() }
}

fn tiers(report: &PurgeReport) -> Vec<u8> {
    report.selected.iter().map(|c| c.tier.number()).collect()
}

fn names_of(world: &World, report: &PurgeReport) -> BTreeSet<&'static str> {
    world.names.iter().filter(|(_, p)| report.selected.iter().any(|c| &c.path == p || p.starts_with(&c.path) && c.path != *p && false)).map(|(n, _)| *n).collect()
}

#[test]
fn a_bare_policy_deletes_nothing_it_only_reports() {
    let world = world();
    let report = world.rig.volume.purge_cache(&PurgePolicy::default()).unwrap();

    assert!(report.dry_run && report.freed_bytes == 0 && report.planned_bytes > 0);
    assert!(!report.selected.is_empty());

    for (name, _) in &world.names {
        assert!(world.exists(name), "{name} must still exist after a dry run");
    }

    cleanup(&world.rig);
}

#[test]
fn the_report_lists_what_each_tier_would_take_in_the_documented_order() {
    let world = world();
    let report = world.rig.volume.plan_purge(&PurgePolicy::default()).unwrap();
    let selected = names_of(&world, &report);

    // Tier 1: abandoned scratch space, and the stale interrupted file.
    assert!(selected.contains("temp-abandoned") && selected.contains("kept-old-part"));
    // Tier 2: caches, least recently used first.
    let caches: Vec<_> = report.selected.iter().filter(|c| c.tier == Tier::RebuildableCache).map(|c| c.path.clone()).collect();

    assert_eq!(caches, vec![world.path("cache-1").clone(), world.path("cache-2").clone(), world.path("cache-3").clone()]);
    // Tier 3: only the finished sandbox nobody asked to keep.
    assert!(selected.contains("sandbox-finished") && !selected.contains("sandbox-retained") && !selected.contains("sandbox-running"));
    // Tier 4: the old artifact, not the new one.
    assert!(selected.contains("artifact-old") && !selected.contains("artifact-new"));
    // Tier 5: old validated updates, not the last working version, not the one in use.
    assert!(selected.contains("update-a") && selected.contains("update-b"));
    assert!(!selected.contains("update-last-good") && !selected.contains("update-current"));
    // Tier 6 only with agreement: listed, not selected.
    assert!(!selected.contains("model-unused"));
    assert_eq!(report.needs_agreement.len(), 1);
    assert_eq!(report.needs_agreement[0].path, *world.path("model-unused"));

    let numbers = tiers(&report);

    assert!(numbers.windows(2).all(|pair| pair[0] <= pair[1]), "{numbers:?}");
    assert_eq!(*numbers.first().unwrap(), 1);
    cleanup(&world.rig);
}

#[test]
fn a_tier_is_only_touched_once_every_lower_tier_has_been_taken() {
    let world = world();
    let everything = world.rig.volume.plan_purge(&all_tiers()).unwrap();
    let total = everything.planned_bytes;
    let mut previous = 0;

    for need in (1..=total + 50).step_by(37) {
        let report = world.rig.volume.plan_purge(&PurgePolicy { need_bytes: Some(need), ..all_tiers() }).unwrap();
        let numbers = tiers(&report);

        assert!(numbers.windows(2).all(|pair| pair[0] <= pair[1]), "need {need}: {numbers:?}");

        // The selection is a prefix of the full ordered plan: nothing of a higher tier is chosen while
        // something of a lower tier was left behind.
        let chosen: Vec<_> = report.selected.iter().map(|c| c.path.clone()).collect();
        let prefix: Vec<_> = everything.selected.iter().take(chosen.len()).map(|c| c.path.clone()).collect();

        assert_eq!(chosen, prefix, "need {need}");

        // It stops as soon as enough is selected, and the selection never shrinks as the need grows.
        assert!(report.planned_bytes >= need.min(total) || report.shortfall.is_some());
        assert!(report.selected.len() >= previous);
        previous = report.selected.len();
    }

    assert_eq!(world.rig.volume.plan_purge(&PurgePolicy { need_bytes: Some(total + 1000), ..all_tiers() }).unwrap().shortfall, Some(1000));
    cleanup(&world.rig);
}

#[test]
fn executing_removes_exactly_the_plan_and_never_the_host_own_data() {
    let world = world();
    let report = world.rig.volume.purge_cache(&PurgePolicy { dry_run: false, ..all_tiers() }).unwrap();

    assert!(!report.dry_run && report.freed_bytes > 0 && report.freed_bytes >= report.planned_bytes.saturating_sub(10));

    for gone in ["temp-abandoned", "kept-old-part", "cache-1", "cache-2", "cache-3", "sandbox-finished", "artifact-old", "update-a", "update-b", "model-unused"] {
        assert!(!world.exists(gone), "{gone} should have been purged");
    }

    for kept in [
        "update-last-good",
        "update-current",
        "sandbox-retained",
        "sandbox-running",
        "artifact-new",
        "model-locked",
        "model-active",
        "download-active",
        "download-part-file",
        "kept-fresh-part",
        "protected-profiles",
        "protected-databases",
        "protected-security-logs",
    ] {
        assert!(world.exists(kept), "{kept} must survive every tier");
    }

    // Idempotent: a second run finds nothing more to take.
    let again = world.rig.volume.purge_cache(&PurgePolicy { dry_run: false, ..all_tiers() }).unwrap();

    assert!(again.selected.is_empty() && again.freed_bytes == 0, "{:?}", again.selected.iter().map(|c| &c.path).collect::<Vec<_>>());

    // The registry forgot what was removed and remembers what stayed.
    let remaining: Vec<_> = world.rig.volume.leases().unwrap().into_iter().map(|(l, _)| l.path).collect();

    assert!(!remaining.contains(world.path("cache-1")));
    assert!(remaining.contains(world.path("update-last-good")));
    cleanup(&world.rig);
}

#[test]
fn models_are_only_ever_removed_with_the_persons_agreement() {
    let world = world();

    // Even at the highest tier, without agreement the model stays.
    let without = world.rig.volume.purge_cache(&PurgePolicy { dry_run: false, max_tier: Tier::UnusedModels, ..PurgePolicy::default() }).unwrap();

    assert!(world.exists("model-unused"));
    assert_eq!(without.needs_agreement.len(), 1);

    // A model in use is never removed, agreement or not.
    world.rig.volume.purge_cache(&PurgePolicy { dry_run: false, ..all_tiers() }).unwrap();
    assert!(world.exists("model-locked") && world.exists("model-active"));
    cleanup(&world.rig);
}

#[test]
fn the_last_working_version_survives_even_when_it_is_the_oldest_thing_left() {
    let world = world();

    // Remove everything else first, then ask again with an impossibly short age: the last good one stays.
    let aggressive = PurgePolicy { dry_run: false, update_age_ms: 0, artifact_age_ms: 0, ..all_tiers() };

    world.rig.volume.purge_cache(&aggressive).unwrap();
    world.rig.volume.purge_cache(&aggressive).unwrap();

    assert!(world.exists("update-last-good"), "the most recent validated update is the last working version");
    assert!(world.exists("update-current"), "the version in use is never removed");
    assert!(!world.exists("update-a") && !world.exists("update-b"));
    cleanup(&world.rig);
}

#[test]
fn a_protected_path_is_never_removed_and_neither_is_what_contains_it() {
    let world = world();
    let relative = {
        let lease = world.path("update-a");
        let root = fs::canonicalize(world.rig.volume.root()).unwrap();

        format!("{}/slot-a", lease.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
    };

    world.rig.volume.protect(&relative).unwrap();
    world.rig.volume.purge_cache(&PurgePolicy { dry_run: false, ..all_tiers() }).unwrap();

    assert!(world.exists("update-a"), "a lease that contains a protected path stays whole");
    assert!(!world.exists("update-b"));

    world.rig.volume.unprotect(&relative).unwrap();
    world.rig.volume.purge_cache(&PurgePolicy { dry_run: false, ..all_tiers() }).unwrap();
    assert!(!world.exists("update-a"), "unprotected, it is eligible again");
    cleanup(&world.rig);
}

#[test]
fn an_unfinished_file_inside_an_active_lease_is_left_alone() {
    let world = world();
    let report = world.rig.volume.plan_purge(&PurgePolicy::default()).unwrap();

    assert!(report.skipped.iter().any(|s| s.path == *world.path("download-part-file") && s.reason.contains("active lease")));
    assert!(!report.selected.iter().any(|c| c.path == *world.path("download-part-file")));
    cleanup(&world.rig);
}

#[test]
fn the_purge_cannot_be_pointed_at_a_protected_zone_by_any_policy() {
    // There is no policy field that names a zone, and the zones that hold the host's own data are not
    // scanned: an exhaustive, aggressive policy still leaves them alone (checked above); here, directly,
    // with files that look exactly like purgeable ones.
    let world = world();

    for zone in ["profiles", "databases", "security-logs"] {
        let dir = world.rig.volume.root().join(zone).join("jarod.fake").join("lease_0123456789abcdef");

        write(&dir.join("x.part"), 10);
        write(&dir.join(".finished"), 1);
        write(&dir.join(".validated"), 1);
        set_age(&dir.join("x.part"), 0);
    }

    let aggressive = PurgePolicy { dry_run: false, update_age_ms: 0, artifact_age_ms: 0, interrupted_age_ms: 0, model_unused_ms: 0, ..all_tiers() };

    world.rig.volume.purge_cache(&aggressive).unwrap();

    for zone in ["profiles", "databases", "security-logs"] {
        assert!(world.rig.volume.root().join(zone).join("jarod.fake").join("lease_0123456789abcdef").join("x.part").exists(), "{zone}");
    }

    cleanup(&world.rig);
}
