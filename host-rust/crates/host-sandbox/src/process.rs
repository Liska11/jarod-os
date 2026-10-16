//! Starting a command in its AppContainer, and everything around that.
//!
//! The order matters and is fail-closed at every step: validate the workspace, resolve the program, create
//! the profile, grant the workspace (and the tool's own folders, read-only), build a Job Object, start the
//! process **suspended** with the AppContainer's security attributes and exactly three inherited handles, put
//! it in the job, resume it, wait with a timeout, read its output with a bound. Any step that fails stops
//! the run before the command has executed a single instruction, and whatever was granted is revoked.

use crate::acl::{Grants, MODIFY, READ_EXECUTE};
use crate::appcontainer::{AppContainer, wide};
use crate::command::{ConfinedCommand, Output, SandboxError};
use crate::policy::{Policy, check_workspace};
use host_storage::path::{create_dir_checked, is_reparse};
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::time::Instant;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation, WAIT_TIMEOUT};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

/// `UILIMIT_*`: no handles to windows outside the job, no clipboard, no system parameters, no display
/// settings, no global atoms, no desktop switching, no logging off.
const UI_RESTRICTIONS: u32 = 0x0000_00FF;
/// The Internet Client capability, given only when the policy says so.
const INTERNET_CLIENT: &str = "S-1-15-3-1";
const SE_GROUP_ENABLED: u32 = 0x0000_0004;
const WORKSPACE_TEMP: &str = ".tmp";

/// A handle that is closed when it goes out of scope.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the handle is owned and closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

impl Owned {
    fn take(&mut self) -> HANDLE {
        std::mem::replace(&mut self.0, std::ptr::null_mut())
    }
}

/// `CommandLineToArgvW` quoting: what `cmd.exe /c "a b"` and every ordinary Windows program parse back to the same argument.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_string();
    }

    let mut out = String::from("\"");
    let mut backslashes = 0;

    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            other => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(other);
                backslashes = 0;
            }
        }
    }

    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');

    out
}

/// A verbatim path (the `\\?\` prefix `canonicalize` gives) shown as the ordinary form that Windows programs,
/// `cmd.exe` included, expect. UNC paths keep theirs.
pub fn plain(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();

    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => text,
    }
}

/// The command line Windows gets: the program, then its arguments, quoted.
pub fn command_line(program: &Path, args: &[String], raw_tail: Option<&str>) -> String {
    let mut parts: Vec<String> = std::iter::once(quote_arg(&plain(program))).chain(args.iter().map(|arg| quote_arg(arg))).collect();

    parts.extend(raw_tail.map(str::to_string));

    parts.join(" ")
}

/// A bare environment block: sorted, NUL-separated, double-NUL-terminated.
fn environment_block(vars: &BTreeMap<String, String>) -> Vec<u16> {
    let mut entries: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    entries.sort_by_key(|(name, _)| name.to_ascii_uppercase());

    let mut block = Vec::new();

    for (name, value) in entries {
        block.extend(format!("{name}={value}").encode_utf16());
        block.push(0);
    }

    block.push(0);

    if block.len() == 1 {
        block.push(0);
    }

    block
}

/// The environment a confined command has: what it was given, plus the few names Windows programs need to start
/// (never the user's `PATH`), with `TEMP` and `TMP` inside the workspace.
fn build_environment(command: &ConfinedCommand, workspace: &Path, read_roots: &[PathBuf]) -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());

    vars.insert("SystemRoot".into(), windows.clone());
    vars.insert("windir".into(), windows.clone());
    vars.insert("SystemDrive".into(), std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()));
    // The system folders, then the tool folders the policy made readable (a tool nobody may read cannot be on the PATH).
    let tools: String = read_roots.iter().map(|root| format!(";{}", plain(root))).collect();

    vars.insert("PATH".into(), format!(r"{windows}\System32;{windows}{tools}"));
    vars.insert("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into());
    vars.insert("ComSpec".into(), format!(r"{windows}\System32\cmd.exe"));

    for (name, value) in &command.env {
        vars.insert(name.clone(), value.clone());
    }

    let temp = plain(&workspace.join(WORKSPACE_TEMP));

    vars.insert("TEMP".into(), temp.clone());
    vars.insert("TMP".into(), temp);

    // An explicit environment block for an AppContainer must carry `LOCALAPPDATA` or Windows refuses to create the
    // process (error 203). The real one would hand the command the user's profile path, so these point inside the
    // workspace instead: whatever a tool writes to its "profile" by default lands where the run is contained.
    let home = workspace.join(WORKSPACE_TEMP).join("home");

    vars.entry("LOCALAPPDATA".into()).or_insert_with(|| plain(&home.join("AppData").join("Local")));
    vars.entry("APPDATA".into()).or_insert_with(|| plain(&home.join("AppData").join("Roaming")));
    vars.entry("USERPROFILE".into()).or_insert_with(|| plain(&home));

    vars
}

fn job_with(limits: &crate::command::Limits) -> Result<Owned, SandboxError> {
    // SAFETY: no attributes, no name; the structs are zeroed, filled and passed with their own sizes.
    unsafe {
        let job = Owned(CreateJobObjectW(std::ptr::null(), std::ptr::null()));

        if job.0.is_null() {
            return Err(SandboxError::Refused("cannot create the job object".into()));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();

        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        info.BasicLimitInformation.ActiveProcessLimit = limits.max_processes.max(1);

        if let Some(bytes) = limits.memory_bytes {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = bytes as usize;
        }

        if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
            == 0
        {
            return Err(SandboxError::Refused("cannot set the job's limits".into()));
        }

        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS { UIRestrictionsClass: UI_RESTRICTIONS };

        if SetInformationJobObject(job.0, JobObjectBasicUIRestrictions, &ui as *const _ as *const c_void, std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32) == 0 {
            return Err(SandboxError::Refused("cannot set the job's UI restrictions".into()));
        }

        Ok(job)
    }
}

/// A pipe whose child end is inheritable and whose host end is not.
fn pipe(child_reads: bool) -> Result<(Owned, Owned), SandboxError> {
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
    let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());

    // SAFETY: valid out pointers and attributes; the host's end is then made non-inheritable.
    unsafe {
        if CreatePipe(&mut read, &mut write, &attributes, 0) == 0 {
            return Err(SandboxError::Refused("cannot create a pipe".into()));
        }

        let (read, write) = (Owned(read), Owned(write));
        let host_end = if child_reads { write.0 } else { read.0 };

        if SetHandleInformation(host_end, HANDLE_FLAG_INHERIT, 0) == 0 {
            return Err(SandboxError::Refused("cannot keep the host's end of a pipe private".into()));
        }

        Ok((read, write))
    }
}

/// Reads to the end, keeping at most `limit` bytes; the rest is read and thrown away so the child never blocks.
fn drain(handle: HANDLE, limit: usize) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    let raw = handle as usize;

    std::thread::spawn(move || {
        // SAFETY: the handle is a pipe read end owned by this thread from here on.
        let mut file = unsafe { File::from_raw_handle(raw as HANDLE) };
        let mut kept = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 16 * 1024];

        loop {
            match file.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = limit.saturating_sub(kept.len());

                    kept.extend_from_slice(&buffer[..read.min(room)]);
                    truncated |= read > room;
                }
            }
        }

        (kept, truncated)
    })
}

/// Resolves a program that is not an absolute path against the system folders only.
pub fn resolve_program(program: &Path) -> Result<PathBuf, SandboxError> {
    let candidate = if program.is_absolute() {
        program.to_path_buf()
    } else {
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let name = program.to_string_lossy().to_string();
        let name = if Path::new(&name).extension().is_none() { format!("{name}.exe") } else { name };
        let found = [format!(r"{windows}\System32\{name}"), format!(r"{windows}\{name}")].into_iter().map(PathBuf::from).find(|p| p.exists());

        found.ok_or_else(|| SandboxError::Invalid(format!("{} is not an absolute path and is not in the Windows folders", program.display())))?
    };
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| SandboxError::Invalid(format!("the program {} cannot be read: {error}", candidate.display())))?;

    if !metadata.is_file() || is_reparse(&metadata) && fs::canonicalize(&candidate).is_err() {
        return Err(SandboxError::Invalid(format!("{} is not a program", candidate.display())));
    }

    Ok(fs::canonicalize(&candidate)?)
}

/// Runs `command` confined as `policy` says. Nothing is started unless every step of the confinement worked.
pub fn run(policy: &Policy, command: &ConfinedCommand) -> Result<Output, SandboxError> {
    let workspace = check_workspace(&policy.workspace)?;
    let program = resolve_program(&command.program)?;
    let cwd = match &command.cwd {
        Some(cwd) => {
            let cwd = if cwd.is_absolute() { cwd.clone() } else { workspace.join(cwd) };
            let canonical = fs::canonicalize(&cwd).map_err(|error| SandboxError::Invalid(format!("the working directory {} cannot be used: {error}", cwd.display())))?;

            if !canonical.starts_with(&workspace) {
                return Err(SandboxError::Invalid(format!("the working directory {} is outside the workspace", canonical.display())));
            }

            canonical
        }
        None => workspace.clone(),
    };

    // The workspace's own temp folder, made without following a link someone may have planted.
    for names in [vec![WORKSPACE_TEMP], vec![WORKSPACE_TEMP, "home", "AppData", "Local"], vec![WORKSPACE_TEMP, "home", "AppData", "Roaming"]] {
        create_dir_checked(&workspace, &names).map_err(|error| SandboxError::Refused(format!("cannot prepare the workspace's temp folder: {error}")))?;
    }

    let container = AppContainer::create()?;
    let mut grants = Grants::new(container.sid());

    grants.add(&workspace, MODIFY)?;

    let mut read_roots = Vec::new();

    for root in &policy.read_roots {
        let root = fs::canonicalize(root).map_err(|error| SandboxError::Invalid(format!("the read root {} cannot be used: {error}", root.display())))?;

        grants.add(&root, READ_EXECUTE)?;
        read_roots.push(root);
    }

    let job = job_with(&policy.limits)?;
    let (stdin_read, stdin_write) = pipe(true)?;
    let (stdout_read, stdout_write) = pipe(false)?;
    let (stderr_read, stderr_write) = pipe(false)?;
    let environment = environment_block(&build_environment(command, &workspace, &read_roots));
    let mut cmdline = wide(&command_line(&program, &command.args, command.raw_tail.as_deref()));
    let (application, directory) = (wide(&plain(&program)), wide(&plain(&cwd)));

    // The capability list: none, unless the policy gives the network.
    let mut capability_sid: *mut c_void = std::ptr::null_mut();
    let mut capabilities: Vec<SID_AND_ATTRIBUTES> = Vec::new();

    if policy.network {
        let text = wide(INTERNET_CLIENT);

        // SAFETY: NUL-terminated string; the SID is LocalAlloc'd and freed after the process is created.
        if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut capability_sid) } == 0 {
            return Err(SandboxError::Refused("cannot build the Internet Client capability".into()));
        }

        capabilities.push(SID_AND_ATTRIBUTES { Sid: capability_sid, Attributes: SE_GROUP_ENABLED });
    }

    let mut security = SECURITY_CAPABILITIES {
        AppContainerSid: container.sid(),
        Capabilities: if capabilities.is_empty() { std::ptr::null_mut() } else { capabilities.as_mut_ptr() },
        CapabilityCount: capabilities.len() as u32,
        Reserved: 0,
    };
    let mut inherited: [HANDLE; 3] = [stdin_read.0, stdout_write.0, stderr_write.0];
    let started = Instant::now();
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    // SAFETY: the attribute list is sized by the first call, initialised, filled with two attributes whose
    // values outlive `CreateProcessW`, and deleted afterwards; `startup` and `info` are valid for the call.
    let created = unsafe {
        let mut size = 0usize;

        InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut size);

        let mut list = vec![0u8; size];
        let list_ptr = list.as_mut_ptr() as *mut c_void;

        if InitializeProcThreadAttributeList(list_ptr, 2, 0, &mut size) == 0 {
            return Err(SandboxError::Refused("cannot build the process attribute list".into()));
        }

        let attributes_ok = UpdateProcThreadAttribute(
            list_ptr,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &mut security as *mut _ as *const c_void,
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        ) != 0
            && UpdateProcThreadAttribute(
                list_ptr,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_mut_ptr() as *const c_void,
                std::mem::size_of_val(&inherited),
                std::ptr::null_mut(),
                std::ptr::null(),
            ) != 0;

        let result = if attributes_ok {
            let mut startup: STARTUPINFOEXW = std::mem::zeroed();

            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdin_read.0;
            startup.StartupInfo.hStdOutput = stdout_write.0;
            startup.StartupInfo.hStdError = stderr_write.0;
            startup.lpAttributeList = list_ptr;

            Some(CreateProcessW(
                application.as_ptr(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr() as *const c_void,
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            ))
        } else {
            None
        };

        DeleteProcThreadAttributeList(list_ptr);

        if !capability_sid.is_null() {
            LocalFree(capability_sid);
        }

        result
    };

    match created {
        None => return Err(SandboxError::Refused("cannot set the process attributes (AppContainer, inherited handles)".into())),
        Some(0) => return Err(SandboxError::Refused(format!("CreateProcessW failed for {}: {}", program.display(), std::io::Error::last_os_error()))),
        Some(_) => {}
    }

    let (process, thread) = (Owned(info.hProcess), Owned(info.hThread));

    // SAFETY: both handles are live. The process has not executed anything yet: it is put in the job first.
    unsafe {
        if AssignProcessToJobObject(job.0, process.0) == 0 {
            TerminateJobObject(job.0, 125);

            return Err(SandboxError::Refused(format!("cannot put the process in its job object: {}", std::io::Error::last_os_error())));
        }
    }

    // The child owns its three ends now: the host's copies are closed, so end-of-file arrives when it is gone.
    drop(stdin_read);
    drop(stdout_write);
    drop(stderr_write);

    let mut stdin_write = stdin_write;
    let mut stdout_read = stdout_read;
    let mut stderr_read = stderr_read;
    let limit = policy.limits.max_output_bytes;
    let out_thread = drain(stdout_read.take(), limit);
    let err_thread = drain(stderr_read.take(), limit);
    let input = command.stdin.clone();
    let in_handle = stdin_write.take() as usize;
    let in_thread = std::thread::spawn(move || {
        // SAFETY: the pipe's write end is owned by this thread from here on.
        let mut file = unsafe { File::from_raw_handle(in_handle as HANDLE) };

        let _ = file.write_all(&input);
    });

    // SAFETY: the thread handle is the process's initial thread, suspended; resuming it starts the command.
    unsafe {
        if ResumeThread(thread.0) == u32::MAX {
            TerminateJobObject(job.0, 125);

            return Err(SandboxError::Refused("cannot start the process".into()));
        }
    }

    let timeout_ms = policy.limits.timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
    // SAFETY: a live process handle.
    let waited = unsafe { WaitForSingleObject(process.0, if timeout_ms == 0 { INFINITE } else { timeout_ms }) };
    let timed_out = waited == WAIT_TIMEOUT;

    if timed_out {
        // SAFETY: the job is live; this ends the whole tree.
        unsafe {
            TerminateJobObject(job.0, 124);
            WaitForSingleObject(process.0, 5_000);
        }
    }

    let mut code = 0u32;
    // SAFETY: a live process handle and a valid out pointer.
    let have_code = unsafe { GetExitCodeProcess(process.0, &mut code) } != 0;

    // Whatever the command left running in its tree ends with it.
    // SAFETY: the job is live.
    unsafe {
        TerminateJobObject(job.0, 0);
    }

    let (stdout, stdout_truncated) = out_thread.join().unwrap_or_default();
    let (stderr, stderr_truncated) = err_thread.join().unwrap_or_default();
    let _ = in_thread.join();
    let name = container.name.clone();

    // The grants are taken back and the profile deleted before the result is handed over; if a grant cannot be
    // taken back, that is said, because a leftover grant is a leftover door.
    let failed = grants.revoke_all();

    drop(container);

    if !failed.is_empty() {
        return Err(SandboxError::Refused(format!("the command ran, but its access to {failed:?} could not be revoked")));
    }

    Ok(Output { exit_code: (have_code && !timed_out).then_some(code), stdout, stderr, stdout_truncated, stderr_truncated, timed_out, elapsed: started.elapsed(), container: name })
}
