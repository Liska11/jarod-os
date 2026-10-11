# @herald-os/client

How Jarod-OS talks to a Hermes backend (`hermes serve`). It is source-only (no build step) and
consumed by `apps/desktop` through a Vite alias.

`import { ... } from '@herald-os/client'` gives you:

- upstream's `JsonRpcGatewayClient`, event hub, reconnect backoff, slash-command parser and fuzzy
  ranking (`src/index.ts`);
- the generated wire types: `RpcMethods`, `SessionCreateParams`, `ToolStartPayload`, ...
  (`src/contract.ts`);
- `createHermesRest`, a small REST client over an injected `fetch` (`src/rest.ts`).

Almost everything is re-exported, unchanged, from the pinned upstream snapshot in
`upstream/hermes-agent/apps/shared/src` (see [upstream/README.md](../../upstream/README.md)). That
folder is not committed: `npm run bootstrap` (or `npm run sync-upstream`) fetches it, and
`npm run typecheck` fails until it exists. When upstream changes a field, `tsc` fails here instead
of the shell drifting at runtime.

The REST client takes an injected `fetch` because the renderer never holds the backend token:
Electron main performs every REST call on its behalf.
