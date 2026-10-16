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

## What is tested (21 tests)

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
