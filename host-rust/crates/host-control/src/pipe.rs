//! The Windows named pipe the control plane listens on (R3.2, done natively).
//!
//! `net.createServer().listen` in Node cannot hand `CreateNamedPipe` a security descriptor, so the
//! shell creates the pipe with the creating token's default DACL (Everyone and Anonymous can read it)
//! and repairs it afterwards through PowerShell. Here the pipe is **created with the explicit,
//! protected DACL** — there is no moment at which the implicit one exists — and the DACL is then read
//! back off the live object and compared to what was asked for. Any mismatch, or any failure to
//! measure, and the host does not serve:
//!
//! - the principals are the logon SID of this session when the token carries one, and the user otherwise;
//! - the ACE is `FRFW` (generic read + write, `0x12019f`), the smallest grant a client needs to speak
//!   JSON lines and the server needs to keep accepting instances;
//! - `Everyone`, `Anonymous`, `SYSTEM`, `Administrators` and the other broad principals are never named;
//! - `FILE_FLAG_FIRST_PIPE_INSTANCE` denies a process that claims the name before the host does, and
//!   remote clients are rejected.
//!
//! Nothing here is a credential: the pipe still needs the per-run token.

use crate::endpoint::PipeEndpoint;
use crate::wire::{HostService, serve_connection};
use std::ffi::c_void;
use std::fmt;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions};
use tokio::sync::Notify;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetSecurityDescriptorControl, GetTokenInformation, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, TOKEN_GROUPS, TOKEN_QUERY, TOKEN_USER, TokenLogonSid, TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Generic read + generic write, as the platform reports it back for `FRFW`.
pub const PIPE_ACE_MASK: u32 = 0x0012_019f;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ERROR_PIPE_BUSY: i32 = 231;

#[derive(Debug)]
pub struct PipeError(pub String);

impl fmt::Display for PipeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PipeError {}

fn refused<T>(message: impl Into<String>) -> Result<T, PipeError> {
    Err(PipeError(message.into()))
}

/// A SID as SDDL spells it: never a name and never a wildcard.
fn is_sid(value: &str) -> bool {
    let mut parts = value.split('-');

    parts.next() == Some("S") && {
        let rest: Vec<&str> = parts.collect();

        rest.len() >= 2 && rest.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    }
}

/// The principals an ACE of this module must never name, whatever a caller passes: Everyone,
/// Anonymous, SYSTEM, Administrators, Users, Authenticated Users, the network and local groups.
const FORBIDDEN_SIDS: &[&str] = &[
    "S-1-0-0",
    "S-1-1-0",
    "S-1-2-0",
    "S-1-3-0",
    "S-1-5-2",
    "S-1-5-7",
    "S-1-5-11",
    "S-1-5-18",
    "S-1-5-32-544",
    "S-1-5-32-545",
    "S-1-5-32-546",
    "S-1-5-32-547",
    "S-1-5-32-555",
    "S-1-5-32-562",
    "S-1-16-0",
    "S-1-16-4096",
    "S-1-16-8192",
    "S-1-16-12288",
    "S-1-16-16384",
];

/// `D:P(A;;FRFW;;;<sid>)…`: protected (no inherited ACE), one allow ACE per principal, nothing else.
pub fn control_pipe_sddl(sids: &[String]) -> Result<String, PipeError> {
    if sids.is_empty() {
        return refused("a pipe policy needs at least one principal");
    }

    let mut sddl = String::from("D:P");

    for sid in sids {
        if !is_sid(sid) {
            return refused(format!("{sid:?} is not a SID"));
        }

        if FORBIDDEN_SIDS.contains(&sid.as_str()) {
            return refused(format!("{sid} is a broad principal the control pipe never names"));
        }

        sddl.push_str(&format!("(A;;FRFW;;;{sid})"));
    }

    Ok(sddl)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn sid_to_string(sid: *mut c_void) -> Result<String, PipeError> {
    let mut text: *mut u16 = std::ptr::null_mut();

    // SAFETY: `sid` points at a valid SID inside a buffer or ACL the caller keeps alive; the string
    // Windows allocates is copied and freed with `LocalFree` below.
    unsafe {
        if ConvertSidToStringSidW(sid, &mut text) == 0 || text.is_null() {
            return refused("cannot print a SID");
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

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: the handle came from `OpenProcessToken` and is closed exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn token_info(token: &Token, class: i32) -> Result<Vec<u8>, PipeError> {
    // SAFETY: the first call only asks for the size; the buffer of that size receives the data.
    unsafe {
        let mut needed = 0u32;

        GetTokenInformation(token.0, class, std::ptr::null_mut(), 0, &mut needed);

        if needed == 0 {
            return refused("the token does not say how large its information is");
        }

        let mut buffer = vec![0u8; needed as usize];

        if GetTokenInformation(token.0, class, buffer.as_mut_ptr() as *mut c_void, needed, &mut needed) == 0 {
            return refused("cannot read the token");
        }

        Ok(buffer)
    }
}

/// The principals the pipe's ACEs may name: the logon SID of this session when the token carries one,
/// and the user's SID otherwise. A logon SID separates "a process in the session the person is using"
/// from "any process holding this user's credentials".
pub fn resolve_principals() -> Result<Vec<String>, PipeError> {
    // SAFETY: `OpenProcessToken` is given this process's pseudo-handle and a valid out pointer.
    let token = unsafe {
        let mut handle: HANDLE = std::ptr::null_mut();

        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) == 0 {
            return refused("cannot open this process's token");
        }

        Token(handle)
    };

    let user = token_info(&token, TokenUser)?;
    // SAFETY: the buffer holds a TOKEN_USER whose SID points inside the same buffer.
    let user_sid = sid_to_string(unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid })?;

    if let Ok(groups) = token_info(&token, TokenLogonSid) {
        // SAFETY: the buffer holds a TOKEN_GROUPS; a logon SID token has exactly one group.
        let logon = unsafe {
            let groups = groups.as_ptr() as *const TOKEN_GROUPS;

            if (*groups).GroupCount >= 1 { Some(sid_to_string((*groups).Groups[0].Sid)?) } else { None }
        };

        if let Some(logon) = logon {
            return Ok(vec![logon]);
        }
    }

    Ok(vec![user_sid])
}

/// The security descriptor handed to `CreateNamedPipe`, freed when the server is done.
struct Descriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is immutable after creation and only read by the kernel.
unsafe impl Send for Descriptor {}
unsafe impl Sync for Descriptor {}

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by `ConvertStringSecurityDescriptorToSecurityDescriptorW` (LocalAlloc).
        unsafe {
            LocalFree(self.0);
        }
    }
}

impl Descriptor {
    fn from_sddl(sddl: &str) -> Result<Descriptor, PipeError> {
        let text = wide(sddl);
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();

        // SAFETY: `text` is NUL-terminated and outlives the call; the out pointer is valid.
        let converted = unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) };

        if converted == 0 || descriptor.is_null() {
            return refused(format!("cannot build the pipe's security descriptor from {sddl}"));
        }

        Ok(Descriptor(descriptor))
    }
}

/// What the live pipe object grants: `(sid, mask)` of every ACE, and whether the DACL is protected.
pub struct LiveDacl {
    pub aces: Vec<(String, u32)>,
    pub protected: bool,
}

pub fn read_dacl(object: &impl AsRawHandle) -> Result<LiveDacl, PipeError> {
    let handle = object.as_raw_handle() as HANDLE;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();

    // SAFETY: `handle` is a live pipe handle; every out pointer is valid; the descriptor Windows
    // allocates is freed below, and the ACL pointer is read only while it is alive.
    unsafe {
        let status =
            GetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl, std::ptr::null_mut(), &mut descriptor);

        if status != 0 || dacl.is_null() {
            if !descriptor.is_null() {
                LocalFree(descriptor);
            }

            return refused(format!("cannot read the pipe's DACL back (error {status}); a null DACL would grant everyone"));
        }

        let result = (|| -> Result<LiveDacl, PipeError> {
            let mut control = 0u16;
            let mut revision = 0u32;

            if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
                return refused("cannot read the DACL's control flags");
            }

            let mut size = std::mem::zeroed::<ACL_SIZE_INFORMATION>();

            if GetAclInformation(dacl, &mut size as *mut _ as *mut c_void, std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) == 0 {
                return refused("cannot read the DACL's size");
            }

            let mut aces = Vec::new();

            for index in 0..size.AceCount {
                let mut ace: *mut c_void = std::ptr::null_mut();

                if GetAce(dacl, index, &mut ace) == 0 || ace.is_null() {
                    return refused("cannot read an ACE");
                }

                // ACE_HEADER { AceType: u8, AceFlags: u8, AceSize: u16 }, then Mask: u32, then the SID.
                let header = ace as *const u8;

                if *header != ACCESS_ALLOWED_ACE_TYPE {
                    return refused("the pipe's DACL holds an ACE that is not an allow ACE");
                }

                let mask = *(header.add(4) as *const u32);
                let sid = sid_to_string(header.add(8) as *mut c_void)?;

                aces.push((sid, mask));
            }

            Ok(LiveDacl { aces, protected: control & SE_DACL_PROTECTED != 0 })
        })();

        LocalFree(descriptor);

        result
    }
}

/// The live DACL is exactly what was asked for: protected, one `FRFW` ACE per principal, nothing more.
pub fn assert_dacl(live: &LiveDacl, principals: &[String]) -> Result<(), PipeError> {
    if !live.protected {
        return refused("the pipe's DACL is not protected: it can inherit entries");
    }

    let mut got: Vec<&str> = live.aces.iter().map(|(sid, _)| sid.as_str()).collect();
    let mut want: Vec<&str> = principals.iter().map(String::as_str).collect();

    got.sort_unstable();
    want.sort_unstable();

    if got != want {
        return refused(format!("the pipe's DACL names {got:?}, not the {want:?} it was created for"));
    }

    if let Some((sid, mask)) = live.aces.iter().find(|(_, mask)| *mask != PIPE_ACE_MASK) {
        return refused(format!("the pipe's ACE for {sid} grants {mask:#x}, not {PIPE_ACE_MASK:#x}"));
    }

    Ok(())
}

/// A pipe that is created with its access policy and refuses to exist without it.
pub struct SecuredPipe {
    endpoint: PipeEndpoint,
    descriptor: Arc<Descriptor>,
    principals: Vec<String>,
}

/// What the host reports once the door is open: the endpoint to publish and the DACL that was verified.
#[derive(Clone, Debug)]
pub struct Serving {
    pub endpoint: String,
    pub principals: Vec<String>,
}

impl SecuredPipe {
    /// `principals` are the SIDs the ACEs may name (see [`resolve_principals`]).
    pub fn new(endpoint: PipeEndpoint, principals: Vec<String>) -> Result<SecuredPipe, PipeError> {
        let sddl = control_pipe_sddl(&principals)?;

        Ok(SecuredPipe { endpoint, descriptor: Arc::new(Descriptor::from_sddl(&sddl)?), principals })
    }

    fn instance(&self, first: bool) -> Result<NamedPipeServer, PipeError> {
        let mut attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: self.descriptor.0, bInheritHandle: 0 };

        // SAFETY: `attributes` and the descriptor it points to outlive the call; the DACL is explicit.
        let server = unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(self.endpoint.path(), &mut attributes as *mut _ as *mut c_void)
        }
        .map_err(|error| PipeError(format!("cannot create {}: {error}", self.endpoint.endpoint())))?;
        let live = read_dacl(&server)?;

        assert_dacl(&live, &self.principals)?;

        Ok(server)
    }

    /// Create the first instance (refusing if another process already holds the name) and verify its
    /// DACL. Only then is the door open and the endpoint worth publishing.
    pub fn bind(self, service: Arc<HostService>) -> Result<RunningPipe, PipeError> {
        let first = self.instance(true)?;
        let serving = Serving { endpoint: self.endpoint.endpoint(), principals: self.principals.clone() };
        let stop = Arc::new(Notify::new());
        let stopper = stop.clone();
        let task = tokio::spawn(async move {
            let mut next = first;

            loop {
                tokio::select! {
                    _ = stopper.notified() => return Ok(()),
                    connected = next.connect() => {
                        if let Err(error) = connected {
                            return Err(PipeError(format!("accept failed: {error}")));
                        }
                    }
                }

                let connection = next;

                // The next instance exists (and is verified) before this one is handed off, so there is
                // never a moment with no listener that another process could claim.
                next = self.instance(false)?;
                tokio::spawn(serve_connection(connection, service.clone()));
            }
        });

        Ok(RunningPipe { serving, stop, task })
    }
}

pub struct RunningPipe {
    pub serving: Serving,
    stop: Arc<Notify>,
    task: tokio::task::JoinHandle<Result<(), PipeError>>,
}

impl RunningPipe {
    /// Stop accepting and wait for the accept loop. A loop that ended on an error reports it.
    pub async fn stop(self) -> Result<(), PipeError> {
        self.stop.notify_one();

        match self.task.await {
            Ok(result) => result,
            Err(error) => refused(format!("the accept loop panicked: {error}")),
        }
    }

    /// Resolves if the accept loop ends by itself (an error): a host whose door closed must not stay up.
    pub async fn closed(&mut self) -> Result<(), PipeError> {
        match (&mut self.task).await {
            Ok(result) => result,
            Err(error) => refused(format!("the accept loop panicked: {error}")),
        }
    }
}

/// A client of the control pipe. The endpoint is parsed strictly: `tcp:`, `http:`, a path or a
/// near-miss name never reaches `CreateFile`.
pub struct PipeClient {
    pipe: NamedPipeClient,
    buffer: Vec<u8>,
}

impl PipeClient {
    pub async fn connect(endpoint: &str) -> Result<PipeClient, PipeError> {
        let endpoint = PipeEndpoint::parse(endpoint).map_err(|error| PipeError(error.to_string()))?;

        for _ in 0..40 {
            match ClientOptions::new().open(endpoint.path()) {
                Ok(pipe) => return Ok(PipeClient { pipe, buffer: Vec::new() }),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
                Err(error) => return refused(format!("cannot open {}: {error}", endpoint.endpoint())),
            }
        }

        refused(format!("{} stayed busy", endpoint.endpoint()))
    }

    /// Send one request line, read one reply line.
    pub async fn send_line(&mut self, line: &str) -> io::Result<String> {
        self.pipe.write_all(line.as_bytes()).await?;
        self.pipe.write_all(b"\n").await?;
        self.pipe.flush().await?;

        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let reply: Vec<u8> = self.buffer.drain(..=end).collect();

                return Ok(String::from_utf8_lossy(&reply[..reply.len() - 1]).to_string());
            }

            let mut chunk = [0u8; 8192];
            let read = self.pipe.read(&mut chunk).await?;

            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the host closed the connection"));
            }

            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }

    pub async fn send(&mut self, request: &serde_json::Value) -> io::Result<serde_json::Value> {
        let reply = self.send_line(&request.to_string()).await?;

        serde_json::from_str(&reply).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}
