#!/usr/bin/env node
// Usage: node scripts/autonomy/lot.mjs start <lot-id> | check <lot-id> | status
// Local, optional, removable (delete scripts/autonomy and autonomy/). Never commits, pushes or resets.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, start, status } from "./lot-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [cmd, id] = process.argv.slice(2);

if (cmd === "status") {
  for (const row of status(root)) console.log(`${row.priority ?? "-"}\t${row.lot}\t${row.attempts}\t${row.id}\t${row.title}`);
} else if ((cmd === "start" || cmd === "check") && id) {
  const result = (cmd === "start" ? start : check)(root, id);

  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
} else {
  console.error("usage: lot.mjs start <id> | check <id> | status");
  process.exit(2);
}
