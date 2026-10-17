//! Granting an AppContainer access to a folder, and taking it back.
//!
//! The grant is an inheritable ACE added to the folder's DACL; Windows propagates it to what is already
//! inside, so an existing file can be edited in place. It is explicit (not a blanket "everyone can") and it is
//! revoked when the run ends, again with propagation. A child whose own DACL is protected does not inherit
//! it, which is the safe way for that to fail.

use crate::appcontainer::wide;
use crate::command::SandboxError;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, REVOKE_ACCESS, SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

/// Read, write, execute, delete and delete-child: everything a command needs inside its workspace, and neither
/// `WRITE_DAC` nor `WRITE_OWNER`: it cannot hand the folder to anyone else.
pub const MODIFY: u32 = 0x0012_0089 | 0x0012_0116 | 0x0012_00A0 | 0x0001_0000 | 0x0000_0040;
/// Read and execute: a tool's own folder.
pub const READ_EXECUTE: u32 = 0x0012_00A9;

/// `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`: the ACE applies to files and to folders below.
const SUB_CONTAINERS_AND_OBJECTS_INHERIT: u32 = 3;

/// Win32 5 (access denied) and 1314 (privilege not held) mean the folder is not ours to share: say so, because
/// "error 5" tells nobody that the folder belongs to another account or to the system (e.g. Program Files).
pub(crate) fn hint(code: u32) -> &'static str {
    match code {
        5 | 1314 => " - this folder is not owned by your account, so JAROD-OS may not change who can read it; copy the tool into a folder you own and list that one",
        _ => "",
    }
}

fn change(path: &Path, sid: *mut c_void, rights: u32, mode: i32) -> Result<(), SandboxError> {
    let target = wide(&path.to_string_lossy());
    let mut old: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let access = EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: mode,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        },
    };

    // SAFETY: `target` is NUL-terminated and outlives every call below; `sid` is a valid SID kept alive by the
    // caller; the descriptor and the new ACL are LocalAlloc'd by Windows and freed exactly once, after use.
    unsafe {
        let status = GetNamedSecurityInfoW(
            target.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut old,
            std::ptr::null_mut(),
            &mut descriptor,
        );

        if status != 0 {
            return Err(SandboxError::Refused(format!("cannot read the DACL of {} (error {status}{})", path.display(), hint(status))));
        }

        let mut updated: *mut ACL = std::ptr::null_mut();
        let built = SetEntriesInAclW(1, &access, old, &mut updated);

        if built != 0 {
            LocalFree(descriptor);

            return Err(SandboxError::Refused(format!("cannot build the new DACL of {} (error {built}{})", path.display(), hint(built))));
        }

        // Not marked protected or unprotected: whatever the folder already says stays, and the change propagates.
        let applied =
            SetNamedSecurityInfoW(target.as_ptr() as *mut u16, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), updated, std::ptr::null());

        LocalFree(updated as *mut c_void);
        LocalFree(descriptor);

        if applied != 0 {
            return Err(SandboxError::Refused(format!("cannot set the DACL of {} (error {applied}{})", path.display(), hint(applied))));
        }
    }

    Ok(())
}

pub fn grant(path: &Path, sid: *mut c_void, rights: u32) -> Result<(), SandboxError> {
    change(path, sid, rights, GRANT_ACCESS)
}

pub fn revoke(path: &Path, sid: *mut c_void) -> Result<(), SandboxError> {
    change(path, sid, 0, REVOKE_ACCESS)
}

/// The grants of one run, taken back when this is dropped (and on demand, to see whether it worked).
pub struct Grants {
    sid: *mut c_void,
    paths: Vec<PathBuf>,
}

impl Grants {
    pub fn new(sid: *mut c_void) -> Grants {
        Grants { sid, paths: Vec::new() }
    }

    pub fn add(&mut self, path: &Path, rights: u32) -> Result<(), SandboxError> {
        // Recorded before the change is made, so that a half-applied grant is still revoked.
        self.paths.push(path.to_path_buf());

        grant(path, self.sid, rights)
    }

    /// Revokes every grant; returns the paths where that failed.
    pub fn revoke_all(&mut self) -> Vec<PathBuf> {
        let mut failed = Vec::new();

        for path in self.paths.drain(..).rev() {
            if revoke(&path, self.sid).is_err() {
                failed.push(path);
            }
        }

        failed
    }
}

impl Drop for Grants {
    fn drop(&mut self) {
        let _ = self.revoke_all();
    }
}

#[cfg(test)]
mod tests {
    use super::hint;

    #[test]
    fn access_denied_explains_the_folder_is_not_the_users() {
        assert!(hint(5).contains("not owned by your account"));
        assert!(hint(1314).contains("copy the tool"));
        assert_eq!(hint(87), "");
    }
}
