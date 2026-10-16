//! Orphans, deduplication and the VHDX inventory: what a person reads (and approves) before space is
//! reclaimed. Every operation here is a dry run unless it is told otherwise.

use crate::error::StorageError;
use crate::path::{ensure_inside, is_reparse};
use crate::volume::{LeaseState, ZonedVolume, dir_size};
use crate::zone::Zone;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn mtime_ms(path: &Path) -> u64 {
    fs::symlink_metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct Orphan {
    pub path: PathBuf,
    pub bytes: u64,
    pub modified_ms: u64,
}

#[derive(Clone, Debug, Default)]
pub struct DedupReport {
    pub dry_run: bool,
    /// Files replaced (or that would be) by a hard link to an identical file.
    pub linked: Vec<(PathBuf, PathBuf)>,
    pub saved_bytes: u64,
    pub skipped: Vec<(PathBuf, String)>,
}

#[derive(Clone, Debug)]
pub struct VhdxEntry {
    pub path: PathBuf,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// Which file this really is on disk: two names with the same identity are already one copy.
#[cfg(windows)]
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};

    let file = File::open(path).ok()?;
    // SAFETY: a zeroed struct is a valid out parameter and the handle stays open for the call.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };

    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }

    Some((u64::from(info.dwVolumeSerialNumber), (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)))
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;

    fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_path: &Path) -> Option<(u64, u64)> {
    None
}

fn sha256_of(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];

    loop {
        let read = file.read(&mut buffer)?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Ok(hasher.finalize().into())
}

impl ZonedVolume {
    /// Directories (and files) that sit where a lease would but belong to no lease the volume knows:
    /// left by a crash, a deleted state file, or a plugin that wrote outside its lease. Sorted oldest first.
    pub fn find_orphans(&self) -> Result<Vec<Orphan>, StorageError> {
        let state = self.lock()?;
        let mut out = Vec::new();

        for zone in crate::zone::RESERVABLE {
            let zone_dir = self.zone_dir(zone);
            let Ok(plugins) = fs::read_dir(&zone_dir) else {
                continue;
            };

            for plugin in plugins.flatten() {
                let plugin_path = plugin.path();
                let Ok(metadata) = fs::symlink_metadata(&plugin_path) else {
                    continue;
                };

                if is_reparse(&metadata) {
                    out.push(Orphan { bytes: 0, modified_ms: mtime_ms(&plugin_path), path: plugin_path });

                    continue;
                }

                // A file directly in a zone, where only plugin directories belong.
                if !metadata.is_dir() {
                    out.push(Orphan { bytes: metadata.len(), modified_ms: mtime_ms(&plugin_path), path: plugin_path });

                    continue;
                }

                let plugin_name = plugin.file_name().to_string_lossy().to_string();
                let Ok(children) = fs::read_dir(&plugin_path) else {
                    continue;
                };

                for child in children.flatten() {
                    let name = child.file_name().to_string_lossy().to_string();
                    let known = state.entries.iter().any(|e| e.zone == zone && e.plugin == plugin_name && e.id == name);

                    if !known {
                        let path = child.path();
                        let bytes = if path.is_dir() { dir_size(&path) } else { fs::symlink_metadata(&path).map(|m| m.len()).unwrap_or(0) };

                        out.push(Orphan { bytes, modified_ms: mtime_ms(&path), path });
                    }
                }
            }
        }

        out.sort_by(|a, b| a.modified_ms.cmp(&b.modified_ms).then(a.path.cmp(&b.path)));

        Ok(out)
    }

    /// Removes orphans older than `min_age_ms`. A dry run returns what would go; nothing protected is touched.
    pub fn reclaim_orphans(&self, min_age_ms: u64, dry_run: bool) -> Result<(Vec<Orphan>, u64), StorageError> {
        let now = self.clock.now_ms();
        let candidates: Vec<Orphan> = self.find_orphans()?.into_iter().filter(|o| now.saturating_sub(o.modified_ms) >= min_age_ms).collect();
        let state = self.lock()?;
        let mut freed = 0u64;
        let mut done = Vec::new();

        for orphan in candidates {
            let relative = orphan.path.strip_prefix(&self.root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();

            if state.protected.iter().any(|guard| relative == *guard || relative.starts_with(&format!("{guard}/")) || guard.starts_with(&format!("{relative}/"))) {
                continue;
            }

            if !dry_run {
                let metadata = fs::symlink_metadata(&orphan.path)?;

                if is_reparse(&metadata) {
                    // A link is removed as a link, never followed. A junction is removed like a directory
                    // (`remove_dir` takes the link, not what it points at), a file symlink like a file.
                    fs::remove_dir(&orphan.path).or_else(|_| fs::remove_file(&orphan.path))?
                } else {
                    ensure_inside(&self.root, &orphan.path)?;

                    if metadata.is_dir() { fs::remove_dir_all(&orphan.path)? } else { fs::remove_file(&orphan.path)? }
                }

                freed = freed.saturating_add(orphan.bytes);
            }

            done.push(orphan);
        }

        Ok((done, freed))
    }

    /// Identical files of an immutable zone replaced by hard links to one copy. Only models, downloads, cache
    /// and artifacts (content that is written once); never a file of an active lease or a locked model.
    pub fn dedup(&self, zone: Zone, min_size: u64, dry_run: bool) -> Result<DedupReport, StorageError> {
        if !matches!(zone, Zone::Models | Zone::Downloads | Zone::Cache | Zone::Artifacts) {
            return Err(StorageError::Refused(format!("the {} zone holds data that changes; only models, downloads, cache and artifacts are deduplicated", zone.name())));
        }

        let state = self.lock()?;
        let mut report = DedupReport { dry_run, ..DedupReport::default() };
        let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();

        for entry in state.entries.iter().filter(|e| e.zone == zone) {
            if entry.state == LeaseState::Active || entry.locked {
                continue;
            }

            let dir = self.entry_dir(entry);
            let mut stack = vec![dir];

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
                    } else if metadata.len() >= min_size {
                        by_size.entry(metadata.len()).or_default().push(item.path());
                    }
                }
            }
        }

        for (size, mut paths) in by_size.into_iter().filter(|(_, paths)| paths.len() > 1) {
            paths.sort_by(|a, b| mtime_ms(a).cmp(&mtime_ms(b)).then(a.cmp(b)));

            let mut by_hash: HashMap<[u8; 32], Vec<PathBuf>> = HashMap::new();

            for path in paths {
                match sha256_of(&path) {
                    Ok(hash) => by_hash.entry(hash).or_default().push(path),
                    Err(error) => report.skipped.push((path, format!("cannot be read: {error}"))),
                }
            }

            for (_, group) in by_hash.into_iter().filter(|(_, g)| g.len() > 1) {
                let original = group[0].clone();

                let original_identity = file_identity(&original);

                for duplicate in &group[1..] {
                    // Already the same file under another name: nothing to save, and nothing to relink.
                    if original_identity.is_some() && file_identity(duplicate) == original_identity {
                        continue;
                    }

                    if !dry_run {
                        // A link next to the duplicate, then an atomic replace: the duplicate is never missing.
                        let temporary = duplicate.with_extension("dedup-link");

                        if let Err(error) = fs::hard_link(&original, &temporary).and_then(|_| fs::rename(&temporary, duplicate)) {
                            let _ = fs::remove_file(&temporary);

                            report.skipped.push((duplicate.clone(), format!("cannot link: {error}")));

                            continue;
                        }
                    }

                    report.saved_bytes = report.saved_bytes.saturating_add(size);
                    report.linked.push((duplicate.clone(), original.clone()));
                }
            }
        }

        report.linked.sort();

        Ok(report)
    }

    /// Every virtual disk the sandboxes zone holds, with its size: they are large and easy to forget.
    pub fn inventory_vhdx(&self) -> Result<Vec<VhdxEntry>, StorageError> {
        let _state = self.lock()?;
        let mut out = Vec::new();
        let mut stack = vec![self.zone_dir(Zone::Sandboxes)];

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
                } else if item.path().extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("vhdx")) {
                    out.push(VhdxEntry { bytes: metadata.len(), modified_ms: mtime_ms(&item.path()), path: item.path() });
                }
            }
        }

        out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.path.cmp(&b.path)));

        Ok(out)
    }
}
