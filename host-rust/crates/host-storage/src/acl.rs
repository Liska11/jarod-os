//! The controlled zone's root gets an explicit, protected DACL: this user, full control, inherited by
//! everything beneath, and nobody else named. Read back from the live directory; anything else is an
//! error. (No `Everyone`, no `Users`, no `Authenticated Users`: the volume is a work area for the host,
//! not a shared folder. SYSTEM and administrators keep the rights Windows gives them by privilege, not by ACE.)

use crate::error::StorageError;
use host_control::pipe::{FORBIDDEN_SIDS, LiveDacl, is_sid, read_dacl, resolve_user_sid};
use std::fs::OpenOptions;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW};
use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

/// `FILE_ALL_ACCESS`, as the platform reads back `FA`.
pub const FULL_CONTROL: u32 = 0x001f_01ff;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

fn refused<T>(why: impl Into<String>) -> Result<T, StorageError> {
    Err(StorageError::Refused(why.into()))
}

/// Replace the DACL of `directory` by `D:P(A;OICI;FA;;;<sid>)` and verify it.
pub fn harden_zone_root(directory: &Path, user_sid: &str) -> Result<(), StorageError> {
    if !is_sid(user_sid) {
        return refused(format!("{user_sid:?} is not a SID"));
    }

    // The zone is a work area for the host, not a shared folder: Everyone, Users, SYSTEM and the other broad
    // principals are never named, whoever asks.
    if FORBIDDEN_SIDS.contains(&user_sid) {
        return refused(format!("{user_sid} is a broad principal the controlled zone never names"));
    }

    if !std::fs::symlink_metadata(directory)?.is_dir() {
        return refused(format!("{} is not a directory", directory.display()));
    }

    let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{user_sid})").encode_utf16().chain(std::iter::once(0)).collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();

    // SAFETY: `sddl` is NUL-terminated and outlives the call; the out pointer is valid.
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) } == 0 {
        return refused("cannot build the zone's security descriptor");
    }

    let mut present = 0i32;
    let mut defaulted = 0i32;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let wide: Vec<u16> = directory.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

    // SAFETY: the descriptor was just allocated; `dacl` points inside it and is used before it is freed;
    // `wide` is NUL-terminated and outlives the call.
    let status = unsafe {
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0 || present == 0 || dacl.is_null() {
            LocalFree(descriptor);

            return refused("the zone's descriptor has no DACL");
        }

        let status = SetNamedSecurityInfoW(
            wide.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        );

        LocalFree(descriptor);

        status
    };

    if status != 0 {
        return refused(format!("cannot set the DACL of {} (error {status})", directory.display()));
    }

    assert_hardened(&read_zone_dacl(directory)?, user_sid)
}

/// What the live directory grants, read through a handle to the directory itself.
pub fn read_zone_dacl(directory: &Path) -> Result<LiveDacl, StorageError> {
    let handle = OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(directory)?;

    read_dacl(&handle).map_err(|error| StorageError::Refused(error.to_string()))
}

pub fn assert_hardened(live: &LiveDacl, user_sid: &str) -> Result<(), StorageError> {
    if !live.protected {
        return refused("the zone's DACL is not protected: it inherits entries from its parent");
    }

    if live.aces.len() != 1 || live.aces[0].0 != user_sid {
        return refused(format!("the zone's DACL names {:?}, not only {user_sid}", live.aces.iter().map(|(sid, _)| sid.as_str()).collect::<Vec<_>>()));
    }

    if live.aces[0].1 != FULL_CONTROL {
        return refused(format!("the zone's ACE grants {:#x}, not full control", live.aces[0].1));
    }

    Ok(())
}

/// The account this host runs as.
pub fn current_user() -> Result<String, StorageError> {
    resolve_user_sid().map_err(|error| StorageError::Refused(error.to_string()))
}
