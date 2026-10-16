//! A Windows Job Object that kills everything in it when it closes.
//!
//! A child that spawns children (a shell tool, a model server, a browser) leaves a tree. The tree must not
//! outlive the host: every child is assigned to a job created with `KILL_ON_JOB_CLOSE`, so when the host
//! dies — cleanly, by a crash or by being killed — Windows closes the handle and terminates the whole tree.
//! Dropping the [`Job`] does the same on purpose, which is how a finished or restarted child leaves no orphan.

use std::io;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};

pub struct Job(HANDLE);

// SAFETY: a job handle is a kernel object handle; the calls made on it are thread safe.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> io::Result<Job> {
        // SAFETY: no security attributes and no name: an anonymous job owned by this handle.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };

        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        let job = Job(handle);
        // SAFETY: a zeroed struct is a valid starting value; the size passed is the struct's own.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };

        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let set = unsafe {
            SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        };

        if set == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(job)
    }

    /// Puts a process (and so everything it will start) in the job.
    pub fn assign(&self, process: &impl AsRawHandle) -> io::Result<()> {
        // SAFETY: both handles are live; the process handle comes from the caller's `Child`.
        if unsafe { AssignProcessToJobObject(self.0, process.as_raw_handle() as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(())
    }

    /// Ends every process in the job now.
    pub fn terminate(&self) {
        // SAFETY: the handle is live; exit code 1 for whatever is still running.
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: closed exactly once; KILL_ON_JOB_CLOSE ends the members.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
