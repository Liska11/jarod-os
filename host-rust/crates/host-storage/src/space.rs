//! Free space, as something the volume asks and a test can answer.

use crate::error::StorageError;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub trait SpaceProbe: Send + Sync {
    /// Bytes this user can still write on the volume that holds `path`.
    fn available(&self, path: &Path) -> Result<u64, StorageError>;
}

/// The operating system's answer (`GetDiskFreeSpaceExW`: the caller's quota-aware free bytes).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemSpace;

#[cfg(windows)]
impl SpaceProbe for SystemSpace {
    fn available(&self, path: &Path) -> Result<u64, StorageError> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut available = 0u64;

        // SAFETY: `wide` is NUL-terminated and outlives the call; the out pointer is valid and the others are optional.
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };

        if ok == 0 {
            return Err(StorageError::Io(format!("cannot read the free space of {}: {}", path.display(), std::io::Error::last_os_error())));
        }

        Ok(available)
    }
}

#[cfg(not(windows))]
impl SpaceProbe for SystemSpace {
    fn available(&self, path: &Path) -> Result<u64, StorageError> {
        Err(StorageError::Io(format!("no free-space probe for {} on this platform; inject a SpaceProbe", path.display())))
    }
}

/// A fixed number of bytes that a test can move, standing in for the disk.
#[derive(Debug)]
pub struct FixedSpace(pub AtomicU64);

impl FixedSpace {
    pub fn new(bytes: u64) -> FixedSpace {
        FixedSpace(AtomicU64::new(bytes))
    }

    pub fn set(&self, bytes: u64) {
        self.0.store(bytes, Ordering::SeqCst);
    }
}

impl SpaceProbe for FixedSpace {
    fn available(&self, _path: &Path) -> Result<u64, StorageError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn the_system_reports_some_free_space_for_the_temp_volume() {
        assert!(SystemSpace.available(&std::env::temp_dir()).unwrap() > 0);
    }
}
