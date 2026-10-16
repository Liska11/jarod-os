//! Proof that the confinement works on *this* machine, before it is relied on.
//!
//! The TypeScript guard has always used a mechanism only after checking that it exists and actually runs;
//! this is the same rule. The self-test starts two real confined commands in a throwaway workspace: one that
//! writes inside it (must succeed) and one that tries to write in a sibling folder it was not given (must be
//! refused by the kernel). A machine where the second one *succeeds* is reported as not confining, and the
//! host must not run anything with `writeScope: workspace` there.

use crate::command::{ConfinedCommand, Limits};
use crate::policy::Policy;
use crate::process::run;
use host_control::secrets::random_hex;
use std::fs;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct SelfTest {
    pub confining: bool,
    /// One line per check, for the person and for a log.
    pub checks: Vec<(String, bool)>,
    pub detail: String,
}

fn check(checks: &mut Vec<(String, bool)>, name: &str, ok: bool) -> bool {
    checks.push((name.to_string(), ok));

    ok
}

pub fn self_test() -> SelfTest {
    let mut checks = Vec::new();
    let id = random_hex(6).unwrap_or_else(|_| "x".into());
    let root = std::env::temp_dir().join(format!("herald-sandbox-selftest-{id}"));
    let (inside, outside) = (root.join("workspace"), root.join("outside"));
    let finish = |checks: Vec<(String, bool)>, detail: String| {
        let _ = fs::remove_dir_all(&root);

        SelfTest { confining: !checks.is_empty() && checks.iter().all(|(_, ok)| *ok), checks, detail }
    };

    if let Err(error) = fs::create_dir_all(&inside).and_then(|_| fs::create_dir_all(&outside)) {
        return finish(checks, format!("cannot prepare the self-test folders: {error}"));
    }

    let mut policy = Policy::new(&inside);

    policy.limits = Limits { timeout: Duration::from_secs(30), ..Limits::default() };

    let cmd = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join("System32").join("cmd.exe");

    // 1. It can write where it was given the right to.
    let allowed = run(&policy, &ConfinedCommand::new(&cmd).args(["/D", "/C", "echo inside> probe.txt"]));

    match &allowed {
        Ok(out) => {
            check(&mut checks, "starts confined and exits normally", out.exit_code == Some(0));
            check(&mut checks, "writes inside the workspace", inside.join("probe.txt").exists());
        }
        Err(error) => {
            check(&mut checks, "starts confined and exits normally", false);

            return finish(checks, error.to_string());
        }
    }

    // 2. It cannot write anywhere it was not given, though the folder is the user's own and next door.
    let denied = run(&policy, &ConfinedCommand::new(&cmd).args(["/D", "/C", r"echo outside> ..\outside\probe.txt"]));

    match &denied {
        Ok(out) => {
            check(&mut checks, "a write outside the workspace fails", out.exit_code != Some(0));
            check(&mut checks, "and nothing was created there", !outside.join("probe.txt").exists());
        }
        Err(error) => {
            check(&mut checks, "a write outside the workspace fails", false);

            return finish(checks, error.to_string());
        }
    }

    // 3. Nothing is left behind: the grant was taken back.
    check(&mut checks, "the workspace grant was revoked", crate::selftest::no_container_ace(&inside));

    finish(checks, String::new())
}

/// No ACE for an AppContainer SID (`S-1-15-2-…`) remains on the folder.
pub(crate) fn no_container_ace(dir: &std::path::Path) -> bool {
    host_storage::acl::read_zone_dacl(dir).map(|dacl| !dacl.aces.iter().any(|(sid, _)| sid.starts_with("S-1-15-2-"))).unwrap_or(false)
}
