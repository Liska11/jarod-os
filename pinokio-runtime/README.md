# pinokio-runtime

Pinokio's engine, [pinokiod](https://github.com/pinokiocomputer/pinokiod) (MIT, © 2023 Pinokio),
as Jarod-OS ships it (docs/DECISIONS.md, ADR-022). This folder only pins the version
(`package.json`, `package-lock.json`); everything else is generated:

```bash
npm run bundle:pinokio --workspace apps/desktop
```

installs pinokiod without its install scripts, compiles better-sqlite3 for this checkout's
Electron, serves its terminal module with node-pty, prunes other platforms and writes `host.cjs`
(from `apps/desktop/electron/pinokio/host.ts`), the process Jarod-OS starts. electron-builder copies
the result to `resources/pinokiod`.

To move to a newer pinokiod: change the version in `package.json`, run
`npm install --package-lock-only --ignore-scripts --workspaces=false` here, then the command above,
and check that the Pinokio window and `pinokio_*` tools still work (the engine's HTTP/WebSocket API
is internal to Pinokio and can change).
