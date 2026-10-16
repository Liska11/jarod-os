# Plugin platform (phase 4)

Code: `jarod-core/packages/plugins/platform` (`@jarod/plugin-platform`). Tests: 21, including a mutation check
(removing the signature verification fails the install test).

## What it enforces

| Concern | Rule | Where |
|---|---|---|
| Manifest | Closed field list, closed permission list, quotas mandatory, `vramMb > 0` needs `gpu`. | `manifest.ts` |
| Signature | Ed25519 over the canonical manifest (payload SHA-256 included). No trusted key, unknown key, other key, or one altered byte: refused. | `manifest.ts` |
| Dependencies | `^ ~ >= exact` ranges; activation order (dependencies first); missing, out-of-range and cycles refused with the path (`a → b → a`). | `graph.ts` |
| Permissions | Declared, approved through an explicit channel (none wired = refused); a plugin never holds one it did not declare, and only while enabled. An update that adds one needs a new approval. | `platform.ts` |
| Quotas and budgets | Per plugin (memory, disk, VRAM) and per zone (sum of installed quotas against a cap). A usage report above the declared quota quarantines immediately. | `platform.ts` |
| Health | N consecutive failures (default 3) quarantine the plugin and disable its dependents; only an explicit `release` leaves quarantine. | `platform.ts` |
| Lifecycle | install / enable / disable / update / remove. Enable undoes what it started if any step fails. Disable and remove refuse while an active dependent needs the plugin (cascade is explicit). | `platform.ts` |
| Update and rollback | Version must rise; dependents' ranges must still hold; a failed activation or health check puts the previous version back; manual `rollback` keeps one previous version. | `platform.ts` |
| State | Written atomically, survives restart. The audit holds names, versions, statuses and reasons only. | `platform.ts` |

The manager loads nothing itself: it asks a `PluginHost` to `activate`, `deactivate` and report `health`. Wiring
that host to the kernel's loader is the next integration step; until then the `ctx.plugins` service refuses to
activate anything (no host, no trusted key).

## Skills on demand and by category

`SkillRegistry` already put only the name and description in the prompt and loaded the body through `load_skill`.
Added: each skill now knows its `category` (the folder path above it), `categories()` lists them, and
`promptSection({ categories })` limits the prompt to those categories (whole path segments, sub-categories
included) plus the flat skills. Without the option the prompt is unchanged.

## Not done, stated

- Sharing config / memory / skills between frontends: they already read the same profile data directory, but no
  test exercises two frontends on one profile at once (locking, concurrent writes). Backlog.
- The platform is not yet connected to the real kernel loader, and no plugin ships a signed manifest yet.
- No real memory / VRAM measurement: usage is reported to `reportUsage` by whoever measures it.
