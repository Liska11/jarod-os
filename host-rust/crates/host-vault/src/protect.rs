//! Sealing: what turns a value into something that is safe to leave on disk.

use std::fmt;

#[derive(Debug)]
pub struct ProtectorError(pub String);

impl fmt::Display for ProtectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProtectorError {}

/// Seals and opens a value. `entropy` is bound into the seal: opening with a different one fails.
pub trait Protector: Send + Sync {
    fn protect(&self, plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ProtectorError>;
    fn unprotect(&self, sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ProtectorError>;
}

/// DPAPI, current-user scope: only this account (on this machine) can open what it sealed. No UI, ever.
#[cfg(windows)]
#[derive(Debug, Default, Clone, Copy)]
pub struct DpapiProtector;

#[cfg(windows)]
mod dpapi {
    use super::*;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData};

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    /// Copies the OS-allocated output, wipes it, frees it.
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }

        // SAFETY: Windows allocated `cbData` bytes at `pbData` (LocalAlloc); they are copied, overwritten
        // with zeros through volatile writes so the compiler keeps them, and freed exactly once.
        unsafe {
            let copy = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();

            for offset in 0..out.cbData as usize {
                std::ptr::write_volatile(out.pbData.add(offset), 0);
            }

            LocalFree(out.pbData as _);

            copy
        }
    }

    impl Protector for DpapiProtector {
        fn protect(&self, plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ProtectorError> {
            let input = blob(plaintext);
            let extra = blob(entropy);
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

            // SAFETY: the input and entropy blobs point at slices that outlive the call; `out` is a valid out parameter.
            let ok = unsafe { CryptProtectData(&input, std::ptr::null(), &extra, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };

            if ok == 0 {
                return Err(ProtectorError(format!("CryptProtectData failed: {}", std::io::Error::last_os_error())));
            }

            Ok(take(out))
        }

        fn unprotect(&self, sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, ProtectorError> {
            let input = blob(sealed);
            let extra = blob(entropy);
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

            // SAFETY: as above; the description output is not requested.
            let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), &extra, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };

            if ok == 0 {
                return Err(ProtectorError(format!("CryptUnprotectData failed: {}", std::io::Error::last_os_error())));
            }

            Ok(take(out))
        }
    }
}
