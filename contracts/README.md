# Jarod-OS contracts

The boundaries of Jarod-OS written down as data: JSON Schema (draft 2020-12) files, golden examples,
and tests in both languages that fail when the code and a schema disagree. The Rust host (phase 0c
onwards) will consume these same files. A developer implementing it should need nothing but this
folder: `v1/*.schema.json`, `v1/fixtures/`, `v1/index.json` and this README. [INVENTORY.md](INVENTORY.md)
ties each contract to the code that implements it today and lists what the tests found.

```
contracts/
  README.md            this file
  INVENTORY.md         contract -> source file:line -> tests, and the divergences found
  v1/
    index.json         the registry: id, status, schema, fixtures, source, tests; and what is NOT frozen
    <id>.schema.json   one JSON Schema 2020-12 file per contract
    fixtures/<id>/     valid-*.json (must be accepted) and invalid-*.json (must be rejected)
```

## What a frozen contract is

A contract is **frozen** when four things hold:

1. its schema is in `v1/` and describes what the code produces and accepts at the commit that added it;
2. every fixture in `fixtures/<id>/` is validated, in the TypeScript suites **and** in the Python suite,
   from the same files (a `valid-` fixture must be accepted, an `invalid-` one rejected);
3. live tests feed the real code (the adjudicator, the journal writers, the policy parser, the
   environment filter, the CLI's trust functions) and validate what comes out against the schema, so the
   suites fail when the code drifts from the schema and not only when two fixtures drift;
4. changing it follows the rules below.

**Provisional** means the schema exists and is tested but may change without a `v2` (the C7 tool
envelopes today). **Not frozen** means there is no schema at all, and `index.json` says why.

## Statuses at this revision

| Id | Status |
|---|---|
| `c1-control-request`, `c1-control-decision`, `c1-control-endpoint` | frozen |
| `c2-authorization-matrix` | frozen |
| `c3-control-audit-entry`, `c3-bridge-audit-entry` | frozen |
| `c4-permissions-policy`, `c4-never-always` | frozen |
| `c5-control-env-names` | frozen |
| `c6-plugin-manifest` | frozen |
| `c7-tool-call`, `c7-guarded-tool-result`, `c7-tool-audit-entry`, `c7-bridge-tool-result` | **provisional** |
| `c8-image-trust`, `c8-trust-journal-entry` | frozen |

## Running the tests

```bash
npm run test --workspace apps/desktop -- electron/shell/contracts.test.ts         # TypeScript, shell side
(cd jarod-core/packages/plugins/agent && npx vitest run test/contracts.test.ts)    # TypeScript, kernel side
npm run test:bridge                                                                # Python (needs jsonschema)
(cd host-rust && cargo test)                                                       # Rust (the host, phase 0c)
```

**Portability rule.** A schema pattern must compile in ECMAScript (ajv), Python `re` (jsonschema) and Rust
`regex` (the host). The Rust consumer found the first violation (`\0` in a character class, now
`\u0000`): when in doubt, spell a character as `\uXXXX` and avoid look-around and back-references.

The Python suites need `jsonschema`: `scripts/test-bridge.sh` / `.ps1` and the CI job already ask for it.
The TypeScript suites use `ajv` (2020-12 build, strict mode), which is hoisted at the workspace root and
not yet declared by the packages that import it (see INVENTORY, "Limits").

## Versioning: v1 is additive only

A consumer written against `v1` must keep working against every later revision of `v1`.

**Allowed in v1** (and recorded in the commit message, because the schema file is the single source):
- add an **optional** property to an object schema, with a fixture that uses it;
- add a value to an **open vocabulary** (audit `code`, bridge `decision`);
- add a member to a **closed set** that the contract states as exact (a control variable name in C5, a
  tool in C4 `NEVER_ALWAYS`, a command in C2) *only* by editing the schema, the golden fixture and the
  code in the same commit: the tests compare all three, so a half-done change cannot pass;
- tighten a description, add a fixture, add a contract.

**Never in v1** (a change like this is a `v2`):
- remove or rename a property, a command, a tier, a code, a variable name;
- make an optional property required, or narrow a type or a pattern that a producer may already emit;
- change what a value means (a tier ladder reordered, a refusal code reused);
- relax a prohibition: `token`, `capability` and `nonce` fields never appear in a journal; no TCP endpoint;
  no bypass on the published image channels; an empty installer pin installs nothing.

**Adding `v2` without breaking `v1`:** create `contracts/v2/` with its own `index.json`, copy the
schemas that change and edit the copies; leave `v1/` untouched. Both folders keep being tested until the
last producer and consumer of `v1` is gone. A producer that speaks `v2` says so in a field the schema
defines; a consumer never guesses the version from the shape. Nothing in `v1` is renamed or deleted to
make room.

Readers are tolerant, contracts are strict: the code often ignores an unknown key (a policy typo falls
back to the default and never widens access), while the schema rejects it so that a validator can
catch the typo. Journals are the exception in the other direction: their field set is **closed** on
purpose, because there must be no field in which a credential could be written.

## Journals never hold a credential

`c3-control-audit-entry` and `c3-bridge-audit-entry` are the contracts that matter most. They are
protected in three layers, from the strongest:

1. **Structure.** `additionalProperties: false`: there is no `token`, `capability` or `nonce` property to
   write into, and the approval is a 12-hex fingerprint, never the capability. A new field must be added
   to the schema (and reviewed) before any code can ship it.
2. **Redaction.** Bridge arguments whose name contains `password`, `passphrase`, `secret`, `token` or
   `psk` must be `[redacted]` (an empty or null value is written as is, exactly as the code does).
3. **Shape heuristic.** Free-text fields reject a run of 32 or more base64url characters, the shape of
   the per-launch tokens. This is defence in depth, not proof: it can reject a legitimate line whose
   caller-chosen text is long and token-like, and it cannot recognise a secret of another shape. The live
   tests therefore mint real tokens, run the real journal writer and assert the tokens are absent.

The `invalid-*token*`, `invalid-*capability*` and `invalid-*nonce*` fixtures are rejected by both
suites. See INVENTORY for a case where layer 3 catches something the code itself does not prevent.

## What is NOT frozen, and why

These have no schema (or only a provisional one). `v1/index.json` carries the same list under `notFrozen`.

- **The control reply envelope** (`{ok, code, error, result, capability, requestId}`). It was not in the
  0b list and its `result` is the open output of every registry command; the approval-granted reply
  carries a capability object whose fields were not re-derived. To freeze with the transport in 0c.
- **Per-command argument grammar of the shell surface.** Only the *tier* of each command is frozen. The
  validators (branding JSON, plugin URL schemes, panel names, voice actions) are code, pinned by
  `control-authz.test.ts`; the Rust host must reproduce them from those tests until they become schemas.
- **The registry command catalogue** (`ui` / `run` command ids, arguments, tiers). It is registered at
  run time by the renderer and changes with the UI.
- **The tool catalogue and per-tool argument schemas.** Dozens of built-in, MCP, plugin and skill tools,
  each with its own schema fragment. Only the call, result and audit envelopes are covered, and they are
  provisional.
- **User-facing wording**: tool result text, refusal `reason` strings, the French audit `decision`
  literals. Tests assert codes and tiers, never prose.
- **Open vocabularies**: audit `code` values and bridge `decision` values. Their lexical shape is frozen,
  their members are not.
- **Capability / approval record layout** (`control-capability.ts`): internal to the host; only the
  journal fingerprint is frozen.
- **Vault, approvals broker, supervisor, updater, D: volume**: not yet behind a seam (phases 1 to 4).
- **Windows installer signing (Authenticode)**: a different trust chain, out of scope. `c8-image-trust`
  is about the Linux image signature (cosign) and the pinned Hermes installer script. TLS is not a
  substitute for either.

## For a Rust implementer

1. Read `v1/index.json`, then each schema. Validate your output and your input against them with any
   JSON Schema 2020-12 validator.
2. Treat `fixtures/c2-authorization-matrix/valid-current.json` as the table to reproduce: two tokens,
   two surfaces, the allow-lists, the retired commands, the tier of every shell command.
3. Reproduce the decision order of `adjudicate` from the live tests in
   `apps/desktop/electron/shell/contracts.test.ts` (who may open which door, which code a refusal
   carries) and from `control-authz.test.ts`. The schemas say what a decision looks like; the tests say
   when each one is made.
4. Emit endpoints exactly as `c1-control-endpoint` states (`pipe://herald-os-<16 lowercase hex>`);
   consumers are more tolerant than that, you must not be.
5. Never write into a journal a field the journal schemas do not name.
