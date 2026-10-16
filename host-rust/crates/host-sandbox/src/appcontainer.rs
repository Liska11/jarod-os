//! An AppContainer profile: an identity with no rights of its own.
//!
//! Each run gets a fresh one (`jarod-os.sb.<16 hex>`), so two sandboxes cannot reach each other's
//! workspace and nothing survives a run: the profile is deleted when this value is dropped.

use crate::command::SandboxError;
use host_control::secrets::random_hex;
use std::ffi::c_void;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::FreeSid;
use windows_sys::Win32::Security::Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile};

pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct AppContainer {
    pub name: String,
    sid: *mut c_void,
    pub sid_string: String,
}

// SAFETY: the SID is immutable after creation and freed once.
unsafe impl Send for AppContainer {}

impl AppContainer {
    /// A new profile. Failing to create one is a refusal: nothing is run without it.
    pub fn create() -> Result<AppContainer, SandboxError> {
        let name = format!("jarod-os.sb.{}", random_hex(8).map_err(|error| SandboxError::Refused(error.to_string()))?);
        let (wname, display, description) = (wide(&name), wide("Jarod-OS sandbox"), wide("A confined command started by the Jarod-OS host."));
        let mut sid: *mut c_void = std::ptr::null_mut();

        // SAFETY: the strings are NUL-terminated and outlive the call; no capabilities are requested for the
        // profile itself; `sid` receives an allocation freed in `Drop`.
        let result = unsafe { CreateAppContainerProfile(wname.as_ptr(), display.as_ptr(), description.as_ptr(), std::ptr::null(), 0, &mut sid) };

        if result != 0 || sid.is_null() {
            return Err(SandboxError::Refused(format!("CreateAppContainerProfile failed (HRESULT {result:#010x})")));
        }

        let sid_string = match sid_to_string(sid) {
            Ok(text) => text,
            Err(error) => {
                // SAFETY: the profile and SID were just created and are not used again.
                unsafe {
                    DeleteAppContainerProfile(wname.as_ptr());
                    FreeSid(sid);
                }

                return Err(error);
            }
        };

        Ok(AppContainer { name, sid, sid_string })
    }

    pub fn sid(&self) -> *mut c_void {
        self.sid
    }
}

impl Drop for AppContainer {
    fn drop(&mut self) {
        let name = wide(&self.name);

        // SAFETY: the profile exists, the SID was allocated by `CreateAppContainerProfile`; both are released once.
        unsafe {
            DeleteAppContainerProfile(name.as_ptr());
            FreeSid(self.sid);
        }
    }
}

pub(crate) fn sid_to_string(sid: *mut c_void) -> Result<String, SandboxError> {
    let mut text: *mut u16 = std::ptr::null_mut();

    // SAFETY: `sid` is a valid SID; the string Windows allocates is copied and freed.
    unsafe {
        if ConvertSidToStringSidW(sid, &mut text) == 0 || text.is_null() {
            return Err(SandboxError::Refused("cannot print a SID".into()));
        }

        let mut length = 0;

        while *text.add(length) != 0 {
            length += 1;
        }

        let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));

        LocalFree(text as *mut c_void);

        Ok(value)
    }
}
