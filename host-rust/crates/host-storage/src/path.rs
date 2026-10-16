//! The only way a name becomes a path on the controlled volume.
//!
//! Refused, always, with no repair attempt: an empty name, `.` and `..`, an absolute path, a drive or
//! stream (`C:`, `file:stream`), a UNC prefix, a character Windows reserves, a trailing dot or space (which
//! Windows silently strips, so `evil.` and `evil` are the same file), a device name (`CON`, `NUL`,
//! `COM1`…, with or without an extension), and any component that is a **reparse point** (a junction or a
//! symlink): a plugin that can make a link inside its lease could make the host write somewhere else.
//! Existing paths are compared after `canonicalize`, which also resolves 8.3 short names.

use crate::error::StorageError;
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};

const MAX_COMPONENT: usize = 255;
const RESERVED_DEVICES: [&str; 22] =
    ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

fn refused<T>(why: impl Into<String>) -> Result<T, StorageError> {
    Err(StorageError::PathRefused(why.into()))
}

/// A junction, a symlink, or any other reparse point.
pub fn is_reparse(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(windows))]
    {
        false
    }
}

/// One path component: a plain name, nothing that Windows would reinterpret.
pub fn validate_component(name: &str) -> Result<(), StorageError> {
    if name.is_empty() {
        return refused("an empty name");
    }

    if name == "." || name == ".." {
        return refused(format!("{name:?} leaves the directory"));
    }

    if name.len() > MAX_COMPONENT {
        return refused("a name longer than 255 bytes");
    }

    if let Some(bad) = name.chars().find(|c| (*c as u32) < 0x20 || "<>:\"/\\|?*".contains(*c) || *c == '\u{7f}') {
        return refused(format!("{name:?} contains {bad:?}, which a name may not (separators, drive and stream syntax, wildcards, controls)"));
    }

    if name.ends_with('.') || name.ends_with(' ') {
        return refused(format!("{name:?} ends with a dot or a space, which Windows strips"));
    }

    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ').to_ascii_uppercase();

    if RESERVED_DEVICES.contains(&stem.as_str()) {
        return refused(format!("{name:?} is a device name"));
    }

    Ok(())
}

/// A relative path made only of validated components. Both `/` and `\` separate components.
pub fn safe_relative(relative: &str) -> Result<PathBuf, StorageError> {
    if relative.is_empty() {
        return refused("an empty path");
    }

    if relative.starts_with(['/', '\\']) || relative.contains(':') {
        return refused(format!("{relative:?} is not relative"));
    }

    let mut out = PathBuf::new();

    for part in relative.split(['/', '\\']) {
        validate_component(part)?;
        out.push(part);
    }

    // `Path` agrees that every component is a plain name.
    if out.components().any(|component| !matches!(component, Component::Normal(_))) {
        return refused(format!("{relative:?} holds something other than names"));
    }

    Ok(out)
}

/// `target` exists, is inside `root` once both are canonical, and no component from `root` down to it
/// is a reparse point. Returns the canonical target.
pub fn ensure_inside(root: &Path, target: &Path) -> Result<PathBuf, StorageError> {
    let root_canonical = fs::canonicalize(root).map_err(|error| StorageError::PathRefused(format!("the root {} cannot be resolved: {error}", root.display())))?;
    let target_canonical = fs::canonicalize(target).map_err(|error| StorageError::PathRefused(format!("{} cannot be resolved: {error}", target.display())))?;

    if !target_canonical.starts_with(&root_canonical) {
        return refused(format!("{} is outside {}", target_canonical.display(), root_canonical.display()));
    }

    // Walk the *given* path below the root, one component at a time, and refuse any link on the way.
    let below = target.strip_prefix(root).map_err(|_| StorageError::PathRefused(format!("{} is not below {}", target.display(), root.display())))?;
    let mut current = root.to_path_buf();

    for component in below.components() {
        current.push(component);

        let metadata = fs::symlink_metadata(&current).map_err(|error| StorageError::PathRefused(format!("{}: {error}", current.display())))?;

        if is_reparse(&metadata) {
            return refused(format!("{} is a link (junction or symlink)", current.display()));
        }
    }

    Ok(target_canonical)
}

/// `root/relative`, with every component validated, no link on the way, and the result inside `root`.
/// The path must already exist; to create one use [`create_dir_checked`].
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, StorageError> {
    ensure_inside(root, &root.join(safe_relative(relative)?))
}

/// Creates `root/<names…>` one directory at a time, checking after each creation that it is a real
/// directory and not a link planted in the meantime. Existing directories are accepted if they are real.
pub fn create_dir_checked(root: &Path, names: &[&str]) -> Result<PathBuf, StorageError> {
    let mut current = root.to_path_buf();

    for name in names {
        validate_component(name)?;
        current.push(name);

        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_reparse(&metadata) => return refused(format!("{} is a link", current.display())),
            Ok(metadata) if !metadata.is_dir() => return refused(format!("{} exists and is not a directory", current.display())),
            Ok(_) => {}
            Err(_) => {
                fs::create_dir(&current)?;

                let metadata = fs::symlink_metadata(&current)?;

                if is_reparse(&metadata) || !metadata.is_dir() {
                    return refused(format!("{} is not the directory that was just created", current.display()));
                }
            }
        }
    }

    ensure_inside(root, &current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_names_pass_and_everything_windows_reinterprets_is_refused() {
        for good in ["models", "jarod.models", "lease_0123456789abcdef", "a b", "Qwen2.5-0.5B.gguf", "é", ".hidden"] {
            assert!(validate_component(good).is_ok(), "{good:?}");
        }

        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:",
            "file:stream",
            "a?",
            "a*",
            "a|b",
            "a<b",
            "a>b",
            "a\"b",
            "evil.",
            "evil ",
            "NUL",
            "nul",
            "Con.txt",
            "COM1",
            "lpt9.log",
            "aux.",
            "a\u{1}b",
            "a\u{7f}",
            &"x".repeat(256),
        ] {
            assert!(validate_component(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn relative_paths_are_made_of_names_only() {
        assert_eq!(safe_relative("a/b\\c").unwrap(), PathBuf::from("a").join("b").join("c"));

        for bad in ["", "/etc", "\\Windows", "..\\x", "a/../b", "C:\\x", "a/./b", "a//b", "\\\\server\\share", "a/NUL"] {
            assert!(safe_relative(bad).is_err(), "{bad:?} must be refused");
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("host-storage-path-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        fs::create_dir_all(&dir).unwrap();

        dir
    }

    #[test]
    fn creation_is_checked_and_stays_inside() {
        let root = scratch("create");
        let made = create_dir_checked(&root, &["models", "jarod.models", "lease_0123456789abcdef"]).unwrap();

        assert!(made.is_dir() && made.starts_with(fs::canonicalize(&root).unwrap()));
        assert!(create_dir_checked(&root, &["models", ".."]).is_err());
        assert!(create_dir_checked(&root, &["models", "a/b"]).is_err());
        assert!(safe_join(&root, "models/jarod.models").is_ok());
        assert!(safe_join(&root, "models/missing").is_err(), "safe_join needs an existing path");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_root_is_refused_even_though_it_points_somewhere_real() {
        let root = scratch("junction");
        let outside = scratch("junction-outside");

        fs::write(outside.join("secret.txt"), "not yours").unwrap();
        create_dir_checked(&root, &["models", "plugin"]).unwrap();

        let link = root.join("models").join("plugin").join("escape");
        let status = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside).output().unwrap();

        assert!(status.status.success(), "mklink /J: {}", String::from_utf8_lossy(&status.stdout));
        assert!(fs::read_to_string(link.join("secret.txt")).is_ok(), "the junction works, which is the danger");

        assert!(is_reparse(&fs::symlink_metadata(&link).unwrap()));
        assert!(ensure_inside(&root, &link).is_err());
        assert!(ensure_inside(&root, &link.join("secret.txt")).is_err());
        assert!(create_dir_checked(&root, &["models", "plugin", "escape", "deeper"]).is_err());

        // Remove the link itself, not what it points at.
        fs::remove_dir(&link).unwrap();
        assert!(outside.join("secret.txt").exists());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
