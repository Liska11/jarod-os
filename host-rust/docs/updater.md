# Updater (phase 2.5): A/B slots, a signature that cannot be skipped, a rollback that is tested

`crates/host-updater`. The host never updates itself in place: it prepares the new version next to the running
one, switches with one atomic write, watches the new version run, and goes back if it is not healthy.

```
<root>/slot-a/      an installed version: payload + manifest.json + manifest.sig (+ markers)
<root>/slot-b/      the other one
<root>/state.json   current, previous (last known good), the open trial, blocked versions, history
```

## The bundle and its trust

A bundle is a directory: `manifest.json` (`c10-update-manifest`, provisional), `manifest.sig` and the files the
manifest lists. The signature is ECDSA P-256 over the **exact bytes** of the manifest, base64 DER — what
`cosign sign-blob` produces — checked against the public key already committed for the images
(`linux/image/cosign.pub`; a test loads the real file). The private half is not in the repository and is not
needed here: **signing is a CI step and an action reserved to the human** (the keys are the ones of the
`COSIGN_PRIVATE_KEY` / `COSIGN_PASSWORD` secrets of phase 0a). Tests sign with a key generated in memory for
each test and never written anywhere.

Before anything is installed, in this order:

1. the signature verifies (against any of the trusted keys; none at all is an error, not a bypass);
2. the manifest validates against the contract and the rules the schema cannot state: plain relative paths, no
   device name, no two paths that differ only by case, the entry is one of the files, a total size bound;
3. the bundle holds **exactly** what was signed: no extra file, none missing, no link, every size and SHA-256 right;
4. the version is strictly newer than the installed one (compared as numbers: `0.10.0 > 0.9.0`) and has not
   already failed its trial here.

`stable` and `edge` are both signed. There is no unsigned channel, no environment variable and no flag that
turns the check off (unlike the development build of the Linux image, which has its own, labelled, local-only
path and is not an update).

## The flow

| Step | What happens | What is guaranteed |
|---|---|---|
| `stage` | verify, copy into the **other** slot hashing as it copies, replace that slot as a whole | the running version is byte for byte untouched; a crash leaves a `staging` directory that is removed at the next open and never used |
| `activate` | one atomic write of `state.json`: current = new slot, previous = old; a trial opens | a state that does not read back as consistent stops the host instead of being guessed |
| `begin_boot` | the launcher asks what to run; during a trial the start is counted | an expired or exhausted trial is rolled back *before* anything is run; a slot whose files no longer verify does not run |
| `confirm_healthy` | trial closes, slot validated (`.validated`), the old version stays as the previous one | |
| `report_failure` | back to the previous slot, the failed version blocked, the reason recorded | the previous slot must itself still verify, or the rollback is refused (never a switch to something broken) |

A trial ends in a rollback three ways: the new version reports failure; it never confirms within
`health_deadline_ms` (a hang, a power cut); it was started `max_trial_boots` times without confirming (a crash
loop). The first install has nothing to fall back to, so it runs without a trial, and a failure there is
reported as `NoFallback`. While a trial is open no other update can be staged.

`.current` and `.validated` markers are kept in the slots: they are what the storage purge reads
(`host-storage`, tier 5) so that the last working version is never removed even if the updater's root lives in
the updates zone.

## What is tested (21 tests, plus 5 on the binary below)

Real directories, real hashes, real signatures: an unsigned, wrongly signed, edited-after-signing or
garbage-signed bundle installs nothing and touches nothing; a changed, longer, missing, extra or
directory-for-file entry is refused; a junction inside a bundle is refused; a signed manifest with a climbing,
absolute, device-named, case-duplicated or entry-less list is refused; only a newer version installs; the first
install; the A/B hand-over with the running slot's payload hashed before and after; a failed health check; a
deadline; a crash loop; a tampered running slot falling back to the previous one (and refusing to run when there
is none); a rollback refused because the last good no longer verifies; state surviving a restart; a crash between
staging and activating not leaving a previous slot that holds an unvalidated update; leftovers cleaned at open;
five kinds of inconsistent `state.json`; atomic replacement; a bounded history. Five mutations were applied
(signature always accepted, rollback without checking the fallback, the staged slot still counted as the
previous one, same version allowed, hash check removed) and each is caught (the last one by the copy's own hash
check and by the dedicated `verify_bundle` test).

## Not done here

Downloading a bundle (a network seam of its own, with TLS but, as in 0a, TLS is not a substitute for the
signature); the launcher process that reads `state.json`, runs the entry of the plan and calls the health check
(a Windows binary can only be replaced while it is not running, so the host needs a small stable launcher);
producing and signing bundles in CI; delta updates; an update of the updater's own trust keys (rotation is
supported by trusting several keys, distributing a new one is a signed update like any other).

## The binary and the shell (V-21, 2026-10-24)

`src/bin/jarod-updater.rs`: `status`, `verify`, `install` (stage then activate), `boot`, `confirm`, `rollback --reason`; one JSON line each,
exit 0 done, 1 refused (`{"ok":false,"error":KIND,"detail":...}`), 2 bad command line. The trusted key is `linux/image/cosign.pub`,
compiled in. A **debug** build also accepts `--test-key FILE` (a public key made for one test); a release build refuses it as an unknown
option (checked: `{"error":"usage","detail":"unknown option --test-key"}`). The contracts come from `--contracts` or
`JAROD_OS_CONTRACTS_DIR`. `tests/cli.rs` (5 tests) runs the real process: first install without trial, trial confirmed, rollback that
blocks the version, a foreign signature, an edited file, a downgrade, the committed key alone refusing a test-signed bundle, usage errors.

The shell calls it from Système › Mises à jour **only when `JAROD_HOST_UPDATER=1`** (`apps/desktop/electron/host-updater.ts`,
`electron/ipc/host-updater.ts`, `src/features/system/HostUpdaterSection.tsx`); the binary is found through `JAROD_UPDATER_BIN` or PATH;
the slots live in `<config>/host-updater`. Install: the person picks a folder, the bundle is verified, a native question names the
version, then `install`. A trial is closed by the person ("Cette version fonctionne" / "Revenir à la précédente", the latter confirmed
natively). Flag off: every channel answers `enabled: false` and nothing runs.

## The launcher, the package, a real A/B run (V-21 consolidation, 2026-10-24)

`src/bin/jarod-launcher.rs` (windows subsystem in release): `[--root DIR] [--contracts DIR] [--test-key FILE (debug)] [-- app args]`.
Root by default `%LOCALAPPDATA%\Jarod-OS\updates`, contracts by default `contracts/v1` next to the launcher. It calls `begin_boot`, runs
the entry of the chosen slot with `JAROD_HOST_UPDATER=1`, `JAROD_UPDATER_ROOT`, `JAROD_UPDATER_BIN` (the sibling `jarod-updater.exe`),
`JAROD_UPDATER_SLOT`, `JAROD_UPDATER_VERSION`, `JAROD_OS_CONTRACTS_DIR`, and `JAROD_UPDATER_TRIAL=1` during a trial. A trial that exits
non-zero is reported as a failure only if that slot is still pending (so an app that confirmed itself then crashed is kept). Exit 3
nothing can start, 4 the program could not be spawned, else the app's code; every step goes to `launcher.log` in the root.
`tests/launcher.rs` (Windows, 5 tests, a copy of `cmd.exe` as the app): nothing installed; a crash in trial rolls back and blocks the
version; a trial that confirmed itself is kept even if it then exits 5; a crash loop gives up after 3 starts; an edited slot does not run.

The app confirms its own trial: launched on trial, it calls `jarod-updater confirm` the first time its kernel reaches `ready`
(`confirmTrialWhenReady`, `electron/ipc/host-updater.ts`). It uses the same root as the launcher (`updaterRoot`: `JAROD_UPDATER_ROOT`,
else local app data on Windows, else `<config>/host-updater`, always the latter in an isolated profile) and finds the binary through
`JAROD_UPDATER_BIN`, then the copy shipped in `resources/updater`, then PATH.

Package: `npm run dist:win` runs `scripts/bundle-updater.mjs` (`cargo build --release --locked`, stops the packaging without cargo), which
puts `jarod-updater.exe`, `jarod-launcher.exe` and `contracts/v1` in `resources/updater`. `scripts/make-update-bundle.mjs` turns a built
app folder into a bundle (manifest checked against c10 before writing); without `--key` it prints the `cosign sign-blob` command instead of
signing: signing with Jarod's key is a human or CI step.

Real run: `node scripts/probes/ab-update-probe.mjs` on the packaged `win-unpacked` (10 061 files, 500 MB), isolated profile, a key made
for the run, so the debug binaries. Passed 5/5 on 2026-10-24: 1.0.0 installed without trial; 1.0.1 installed on trial; started by the
launcher, the real app confirmed its trial in 16 s, and killing it afterwards did not roll back; a 1.0.2 that crashes on start went back to
1.0.1 and was blocked; the launcher then started 1.0.1 not on trial. No process and no folder left behind.

Decided (2026-10-24): the installer's shortcut starts `Jarod-OS.exe`, not the launcher. The launcher only starts a slot installed in its
root; a fresh install has none (exit 3), and A/B is off by default. It moves to the launcher when A/B is on by default and the installer
seeds the first slot. Still not done: the release
binaries have not run a full cycle (that needs a bundle signed with the real key); a download channel; signing bundles in CI; CI running
`cargo test` (the shell's end-to-end tests skip when no binary was built); the trial confirmation is not locked across processes, and a
second start while the app runs counts as one more trial start.
