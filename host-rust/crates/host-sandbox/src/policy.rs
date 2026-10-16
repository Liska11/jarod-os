//! What a sandbox is allowed, and the refusal of a workspace that is too broad to be a workspace.
//!
//! The workspace is where the command may write, so it is the most important input. A workspace that is the
//! drive root, the user's whole profile, the Windows folder or a parent of any of them would grant the
//! sandbox access to the machine; it is refused, however it was spelled, before anything is granted.

use crate::command::{Limits, SandboxError};
use host_storage::path::is_reparse;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Policy {
    /// The only place the command may write. It must exist.
    pub workspace: PathBuf,
    /// Places the *tool itself* lives (an interpreter in the user's profile, say): readable and executable, never writable.
    pub read_roots: Vec<PathBuf>,
    /// The Internet client capability. Off: a confined command has no network, not even loopback.
    pub network: bool,
    pub limits: Limits,
}

impl Policy {
    pub fn new(workspace: impl Into<PathBuf>) -> Policy {
        Policy { workspace: workspace.into(), read_roots: Vec::new(), network: false, limits: Limits::default() }
    }
}

/// Folders that are never a workspace and never inside one.
fn forbidden_places() -> Vec<PathBuf> {
    let mut places = Vec::new();

    for name in [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemDrive",
        "HOMEDRIVE",
        "PUBLIC",
        "ALLUSERSPROFILE",
    ] {
        if let Some(value) = std::env::var_os(name).filter(|v| !v.is_empty()) {
            let mut path = PathBuf::from(value);

            // `C:` alone means the current directory of the drive; `C:\` is the root.
            if path.parent().is_none() && path.to_string_lossy().ends_with(':') {
                path.push("\\");
            }

            if let Ok(canonical) = fs::canonicalize(&path) {
                places.push(canonical);
            }
        }
    }

    places
}

/// A directory that really exists, is not a link, and is neither a broad place nor a parent of one.
pub fn check_workspace(workspace: &Path) -> Result<PathBuf, SandboxError> {
    let bad = |why: String| Err(SandboxError::Invalid(why));
    let metadata = fs::symlink_metadata(workspace).map_err(|error| SandboxError::Invalid(format!("the workspace {} cannot be read: {error}", workspace.display())))?;

    if is_reparse(&metadata) || !metadata.is_dir() {
        return bad(format!("{} is a link or not a directory", workspace.display()));
    }

    let canonical = fs::canonicalize(workspace)?;
    let depth = canonical.components().filter(|c| matches!(c, Component::Normal(_))).count();

    if depth < 2 {
        return bad(format!("{} is too close to a drive root to be a workspace", canonical.display()));
    }

    for place in forbidden_places() {
        if canonical == place {
            return bad(format!("{} is {}, which is never a workspace", canonical.display(), place.display()));
        }

        // A workspace that contains a broad place hands out the whole place.
        if place.starts_with(&canonical) {
            return bad(format!("{} contains {}: a workspace is never a parent of the profile, Windows or the programs", canonical.display(), place.display()));
        }

        // Inside Windows or the program folders: not a place to work either.
        let system = std::env::var_os("SystemRoot").and_then(|v| fs::canonicalize(PathBuf::from(v)).ok());
        let programs: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]
            .iter()
            .filter_map(std::env::var_os)
            .filter_map(|v| fs::canonicalize(PathBuf::from(v)).ok())
            .collect();

        if system.as_ref().is_some_and(|s| canonical.starts_with(s)) || programs.iter().any(|p| canonical.starts_with(p)) {
            return bad(format!("{} is inside Windows or the program folders", canonical.display()));
        }
    }

    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broad_places_are_never_a_workspace() {
        for name in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ProgramFiles", "SystemDrive"] {
            if let Some(value) = std::env::var_os(name) {
                let value = if name == "SystemDrive" { format!("{}\\", value.to_string_lossy()) } else { value.to_string_lossy().to_string() };

                assert!(check_workspace(Path::new(&value)).is_err(), "{name} = {value}");
            }
        }

        // A parent of the profile (the Users folder) grants the profile: refused as well.
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let parent = Path::new(&profile).parent().unwrap().to_path_buf();

            assert!(check_workspace(&parent).is_err(), "{}", parent.display());
        }

        assert!(check_workspace(Path::new(r"C:\does\not\exist\anywhere")).is_err());
    }

    #[test]
    fn an_ordinary_folder_under_temp_is_fine() {
        let dir = std::env::temp_dir().join(format!("host-sandbox-policy-{}", std::process::id()));

        fs::create_dir_all(&dir).unwrap();

        // %TEMP% is inside the profile, which is allowed (a workspace may live inside the profile; it may not BE it).
        assert!(check_workspace(&dir).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
