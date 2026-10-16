//! The purge: a plan first, in a fixed order that is never broken, and never the host's own data.
//!
//! The order, lowest tier first, each tier exhausted before the next is touched:
//!
//! 1. interrupted temporary files (`.part`, `.tmp`, `.partial`) and leases that expired unreleased;
//! 2. rebuildable caches, least recently used first;
//! 3. finished sandboxes that nobody asked to keep (`.finished` and no `.retain`);
//! 4. old build artifacts;
//! 5. old validated updates — **never the last working version** (the most recently validated one), never
//!    one marked `.current`, never a protected path;
//! 6. unused models, **only with the person's agreement** (`allow_unused_models`), never one in use (locked);
//! 7. never: profiles, databases and security logs are not zones this code scans, so no policy reaches them.
//!
//! `PurgePolicy::default()` is a dry run: it returns the report a person reads before a cleanup and
//! deletes nothing. Executing re-checks every candidate under the same lock that planned it.

use crate::error::StorageError;
use crate::path::{ensure_inside, is_reparse};
use crate::volume::{Entry, LeaseState, ZonedVolume, dir_size};
use crate::zone::Zone;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    InterruptedTemp = 1,
    RebuildableCache = 2,
    FinishedSandboxes = 3,
    OldArtifacts = 4,
    OldUpdates = 5,
    UnusedModels = 6,
}

impl Tier {
    pub fn number(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Debug)]
pub struct PurgePolicy {
    /// Report only. The default, so that a bare policy deletes nothing.
    pub dry_run: bool,
    /// Stop as soon as this many bytes are selected. `None`: everything the tiers up to `max_tier` allow.
    pub need_bytes: Option<u64>,
    pub max_tier: Tier,
    /// The person said yes to removing models nobody uses. Without it tier 6 is only listed.
    pub allow_unused_models: bool,
    pub interrupted_age_ms: u64,
    pub artifact_age_ms: u64,
    pub update_age_ms: u64,
    pub model_unused_ms: u64,
}

impl Default for PurgePolicy {
    fn default() -> Self {
        PurgePolicy {
            dry_run: true,
            need_bytes: None,
            max_tier: Tier::OldUpdates,
            allow_unused_models: false,
            interrupted_age_ms: 24 * 3_600_000,
            artifact_age_ms: 30 * 86_400_000,
            update_age_ms: 14 * 86_400_000,
            model_unused_ms: 60 * 86_400_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub tier: Tier,
    pub path: PathBuf,
    pub bytes: u64,
    pub reason: String,
    /// When the data was last used or written, for ordering inside a tier (least recent first).
    pub age_key: u64,
    pub(crate) lease: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Skipped {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct PurgeReport {
    pub dry_run: bool,
    pub selected: Vec<Candidate>,
    /// Tier 6 candidates that need the person's agreement; never part of `selected` without it.
    pub needs_agreement: Vec<Candidate>,
    pub skipped: Vec<Skipped>,
    pub planned_bytes: u64,
    pub freed_bytes: u64,
    /// `need_bytes` could not be reached inside the allowed tiers.
    pub shortfall: Option<u64>,
}

fn mtime_ms(path: &Path) -> u64 {
    fs::symlink_metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn has_marker(dir: &Path, name: &str) -> bool {
    fs::symlink_metadata(dir.join(name)).is_ok_and(|m| !is_reparse(&m))
}

fn interrupted_extension(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "part" | "tmp" | "partial"))
}

fn files_under(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(read) = fs::read_dir(&current) else {
            continue;
        };

        for item in read.flatten() {
            let Ok(metadata) = fs::symlink_metadata(item.path()) else {
                continue;
            };

            if is_reparse(&metadata) {
                continue;
            }

            if metadata.is_dir() {
                stack.push(item.path());
            } else {
                out.push((item.path(), metadata.len()));
            }
        }
    }

    out
}

impl ZonedVolume {
    fn relative(&self, path: &Path) -> Option<String> {
        path.strip_prefix(&self.root).ok().map(|p| p.to_string_lossy().replace('\\', "/"))
    }

    /// A path inside, or containing, something nothing may delete.
    fn protected(&self, state: &crate::volume::State, path: &Path) -> bool {
        let Some(relative) = self.relative(path) else {
            return true;
        };

        state.protected.iter().any(|guard| relative == *guard || relative.starts_with(&format!("{guard}/")) || guard.starts_with(&format!("{relative}/")))
    }

    fn entry_candidate(&self, entry: &Entry, tier: Tier, reason: impl Into<String>) -> Candidate {
        let dir = self.entry_dir(entry);

        Candidate { tier, bytes: dir_size(&dir), path: dir, reason: reason.into(), age_key: entry.last_used_ms, lease: Some(entry.id.clone()) }
    }

    /// Every candidate of every tier, whether or not the policy would select it, with what was skipped and why.
    fn gather(&self, state: &crate::volume::State, policy: &PurgePolicy) -> (Vec<Candidate>, Vec<Skipped>) {
        let now = self.clock.now_ms();
        let mut found: Vec<Candidate> = Vec::new();
        let mut skipped: Vec<Skipped> = Vec::new();
        let mut claimed = std::collections::HashSet::new();
        let old = |age: u64, limit: u64| now.saturating_sub(age) >= limit;

        for entry in &state.entries {
            let dir = self.entry_dir(entry);

            if entry.locked {
                skipped.push(Skipped { path: dir, reason: "locked: in use".into() });

                continue;
            }

            if self.protected(state, &dir) {
                skipped.push(Skipped { path: dir, reason: "protected".into() });

                continue;
            }

            if entry.state == LeaseState::Active {
                skipped.push(Skipped { path: dir, reason: "an active lease".into() });

                continue;
            }

            if has_marker(&dir, ".current") {
                skipped.push(Skipped { path: dir, reason: "marked .current: the version in use".into() });

                continue;
            }

            // Expired and never released: an abandoned download or scratch area (tier 1).
            let abandoned =
                entry.state == LeaseState::Expired && matches!(entry.zone, Zone::Temp | Zone::Downloads | Zone::Models | Zone::Updates) && !has_marker(&dir, ".validated");

            if abandoned {
                found.push(self.entry_candidate(entry, Tier::InterruptedTemp, format!("{} lease expired without being released", entry.zone.name())));
                claimed.insert(entry.id.clone());

                continue;
            }

            match entry.zone {
                Zone::Cache => found.push(self.entry_candidate(entry, Tier::RebuildableCache, "a rebuildable cache, least recently used first")),
                Zone::Sandboxes if entry.state == LeaseState::Expired => found.push(self.entry_candidate(entry, Tier::FinishedSandboxes, "a sandbox whose lease expired")),
                Zone::Sandboxes if has_marker(&dir, ".finished") && !has_marker(&dir, ".retain") => {
                    found.push(self.entry_candidate(entry, Tier::FinishedSandboxes, "a finished sandbox nobody asked to keep"))
                }
                Zone::Sandboxes => skipped.push(Skipped { path: dir, reason: "a sandbox that is not finished, or is marked .retain".into() }),
                Zone::Artifacts if old(entry.last_used_ms, policy.artifact_age_ms) => found.push(self.entry_candidate(entry, Tier::OldArtifacts, "an old build artifact")),
                Zone::Updates if has_marker(&dir, ".validated") => {
                    if old(entry.last_used_ms, policy.update_age_ms) {
                        found.push(self.entry_candidate(entry, Tier::OldUpdates, "an old validated update"))
                    } else {
                        skipped.push(Skipped { path: dir, reason: "a validated update that is not old yet".into() })
                    }
                }
                Zone::Models if old(entry.last_used_ms, policy.model_unused_ms) => {
                    found.push(self.entry_candidate(entry, Tier::UnusedModels, "a model nobody has used for a long time"))
                }
                _ => skipped.push(Skipped { path: dir, reason: "not eligible under any tier".into() }),
            }
        }

        // The last working version: of the validated updates, the most recent one is never removed.
        let last_known_good = state
            .entries
            .iter()
            .filter(|e| e.zone == Zone::Updates && e.state != LeaseState::Active && has_marker(&self.entry_dir(e), ".validated"))
            .max_by_key(|e| (e.last_used_ms, e.created_ms))
            .map(|e| e.id.clone());

        if let Some(keep) = last_known_good {
            found.retain(|c| {
                let guarded = c.tier == Tier::OldUpdates && c.lease.as_deref() == Some(keep.as_str());

                if guarded {
                    skipped.push(Skipped { path: c.path.clone(), reason: "the last working version is never removed".into() });
                }

                !guarded
            });
        }

        // Tier 1, files: interrupted downloads and temporary files that are not inside an active lease.
        for zone in [Zone::Temp, Zone::Downloads] {
            for (path, bytes) in files_under(&self.zone_dir(zone)) {
                if !interrupted_extension(&path) || !old(mtime_ms(&path), policy.interrupted_age_ms) {
                    continue;
                }

                if found.iter().any(|c| path.starts_with(&c.path)) || self.protected(state, &path) {
                    continue;
                }

                let inside_active = state.entries.iter().any(|e| e.state == LeaseState::Active && path.starts_with(self.entry_dir(e)));

                if inside_active {
                    skipped.push(Skipped { path, reason: "an unfinished file inside an active lease".into() });

                    continue;
                }

                found.push(Candidate { tier: Tier::InterruptedTemp, path, bytes, reason: "an interrupted temporary file".into(), age_key: 0, lease: None });
            }
        }

        // Order inside a tier: oldest first (for files, the age key is their mtime).
        for candidate in found.iter_mut().filter(|c| c.lease.is_none()) {
            candidate.age_key = mtime_ms(&candidate.path);
        }

        found.sort_by(|a, b| a.tier.cmp(&b.tier).then(a.age_key.cmp(&b.age_key)).then(a.path.cmp(&b.path)));

        (found, skipped)
    }

    /// The report a person reads before a cleanup, with the policy's selection made but nothing deleted.
    pub fn plan_purge(&self, policy: &PurgePolicy) -> Result<PurgeReport, StorageError> {
        let state = self.lock()?;

        Ok(self.plan_locked(&state, policy))
    }

    fn plan_locked(&self, state: &crate::volume::State, policy: &PurgePolicy) -> PurgeReport {
        let (found, skipped) = self.gather(state, policy);
        let mut report = PurgeReport { dry_run: policy.dry_run, skipped, ..PurgeReport::default() };

        // A prefix of the sorted list: a candidate of tier N is selected only after every eligible candidate
        // of a lower tier has been, which is the whole point of the order.
        for candidate in found {
            // Models nobody uses are listed for the person whatever the tier limit, so the report is complete.
            if candidate.tier == Tier::UnusedModels && !policy.allow_unused_models {
                report.needs_agreement.push(candidate);

                continue;
            }

            if candidate.tier > policy.max_tier {
                continue;
            }

            if policy.need_bytes.is_some_and(|need| report.planned_bytes >= need) {
                break;
            }

            report.planned_bytes = report.planned_bytes.saturating_add(candidate.bytes);
            report.selected.push(candidate);
        }

        if let Some(need) = policy.need_bytes
            && report.planned_bytes < need
        {
            report.shortfall = Some(need - report.planned_bytes);
        }

        report
    }

    pub(crate) fn purge(&self, policy: &PurgePolicy) -> Result<PurgeReport, StorageError> {
        let mut state = self.lock()?;
        let mut report = self.plan_locked(&state, policy);

        if policy.dry_run {
            return Ok(report);
        }

        let mut freed = 0u64;
        let mut removed: Vec<String> = Vec::new();
        let selected = std::mem::take(&mut report.selected);
        let mut done = Vec::new();

        for candidate in selected {
            // Re-checked at the moment of deletion, whatever the plan said.
            let verdict = (|| -> Result<(), StorageError> {
                if candidate.tier > policy.max_tier {
                    return Err(StorageError::Refused("above the allowed tier".into()));
                }

                if self.protected(&state, &candidate.path) {
                    return Err(StorageError::Refused("protected".into()));
                }

                if let Some(id) = &candidate.lease {
                    let entry = state.entries.iter().find(|e| &e.id == id).ok_or_else(|| StorageError::Refused("the lease is gone".into()))?;

                    if entry.locked || entry.state == LeaseState::Active {
                        return Err(StorageError::Refused("locked or active".into()));
                    }
                }

                // Inside a purgeable zone, never a protected one, and no link on the way.
                let relative = self.relative(&candidate.path).ok_or_else(|| StorageError::Refused("outside the volume".into()))?;
                let zone = relative.split('/').next().and_then(Zone::parse).ok_or_else(|| StorageError::Refused("not in a zone".into()))?;

                if zone.is_protected() {
                    return Err(StorageError::Refused("a protected zone is never purged".into()));
                }

                ensure_inside(&self.root, &candidate.path)?;

                Ok(())
            })();

            match verdict {
                Ok(()) => {
                    let bytes = if candidate.path.is_dir() { dir_size(&candidate.path) } else { candidate.bytes };
                    let result = if candidate.path.is_dir() { fs::remove_dir_all(&candidate.path) } else { fs::remove_file(&candidate.path) };

                    match result {
                        Ok(()) => {
                            freed = freed.saturating_add(bytes);

                            if let Some(id) = &candidate.lease {
                                removed.push(id.clone());
                            }

                            done.push(candidate);
                        }
                        Err(error) => report.skipped.push(Skipped { path: candidate.path, reason: format!("could not delete: {error}") }),
                    }
                }
                Err(error) => report.skipped.push(Skipped { path: candidate.path, reason: error.to_string() }),
            }
        }

        state.entries.retain(|entry| !removed.contains(&entry.id));
        self.persist(&state)?;
        report.selected = done;
        report.freed_bytes = freed;

        Ok(report)
    }
}
