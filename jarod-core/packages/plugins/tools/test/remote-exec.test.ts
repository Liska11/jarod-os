import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@jarod/contracts";
import { DEFAULT_POLICY, type NetworkPolicy } from "@jarod/kernel/network";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/registry.js";
import {
  controlJournalSink,
  REMOTE_EXEC_OUTPUT_CAP,
  type RemoteExecJournalEntry,
  remoteCommandProblem,
  remoteExecTool,
} from "../src/remote-exec.js";
import { type SshCommand, type SshProcessOutcome, SshService, spawnSshCommand } from "../src/ssh.js";
import { SshHostsService } from "../src/ssh-hosts.js";
import { makeCore } from "./helpers.js";

/*
 * No test here starts `ssh` or opens a socket: the SSH transport is simulated and records every argv it is handed. That record is what
 * proves a refusal connects nothing, and that an approved call runs exactly the command that was shown.
 */

const KEY = "C:/Users/tester/.ssh/id_ed25519";

function reply(partial: Partial<SshProcessOutcome> = {}): SshProcessOutcome {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, deathConfirmed: true, binaryMissing: false, spawnError: "", ...partial };
}

interface Asked {
  call: ToolCall;
  description: string;
}

async function setup(opts: { answer?: boolean; reply?: Partial<SshProcessOutcome>; trusted?: boolean; policy?: NetworkPolicy; enable?: boolean } = {}) {
  const core = await makeCore();
  const commands: SshCommand[] = [];
  const ssh = new SshService({
    keyExists: () => true,
    transport: async (command) => {
      commands.push(command);
      return reply(opts.reply);
    },
  });
  const hosts = new SshHostsService(core.settings, ssh);
  const [pc2] = hosts.add({ name: "pc2", host: "100.64.0.2", username: "ops", port: 22, keyPath: KEY });
  hosts.add({ name: "nas", host: "100.64.0.3", username: "admin", port: 2222, keyPath: KEY });
  if (opts.enable !== false) hosts.setExecEnabled(pc2!.id, true);
  const journal: RemoteExecJournalEntry[] = [];
  const keyChecks: string[] = [];
  const tool = remoteExecTool({
    hosts,
    ssh,
    journal: (entry) => journal.push(entry),
    policy: () => opts.policy ?? DEFAULT_POLICY,
    hostKeyTrusted: async (host, port) => {
      keyChecks.push(`${host}:${port}`);
      return opts.trusted !== false;
    },
  });
  const asked: Asked[] = [];
  const ctx: ToolContext = {
    sessionId: "s1",
    workspace: null,
    approve: async (_sid, call, description) => {
      asked.push({ call, description });
      return opts.answer ?? true;
    },
  };
  return { core, hosts, tool, ctx, commands, journal, asked, keyChecks, pc2: pc2! };
}

describe("remote_exec — off by default", () => {
  it("is registered in the real core but not offered to the model while no machine is enabled", async () => {
    const core = await makeCore();
    expect(core.tools.get("remote_exec")).toBeDefined();
    expect(core.tools.specs([]).map((s) => s.name)).not.toContain("remote_exec");
    expect(core.settings.get("sshExecHosts")).toBeUndefined();
  });

  it("is offered only once a declared machine is enabled, and withdrawn when it is turned off or removed", async () => {
    const { tool, hosts, pc2 } = await setup({ enable: false });
    expect(tool.available?.()).toBe(false);
    hosts.setExecEnabled(pc2.id, true);
    expect(tool.available?.()).toBe(true);
    hosts.setExecEnabled(pc2.id, false);
    expect(tool.available?.()).toBe(false);
    hosts.setExecEnabled(pc2.id, true);
    hosts.remove(pc2.id);
    expect(tool.available?.()).toBe(false);
    expect(hosts.execEnabledIds()).toEqual([]);
  });

  it("is not offered, and refuses, without a control journal", async () => {
    const { hosts, ctx } = await setup();
    const ssh = { exec: async () => Promise.reject(new Error("must not run")) };
    const tool = remoteExecTool({ hosts, ssh, journal: null, hostKeyTrusted: async () => true });
    expect(tool.available?.()).toBe(false);
    await expect(tool.run({ machine: "pc2", command: "uptime" }, ctx)).rejects.toThrow(/control journal/);
  });

  it("refuses a declared machine that is not enabled, without asking or connecting", async () => {
    const { tool, ctx, commands, asked, journal } = await setup();
    await expect(tool.run({ machine: "nas", command: "uptime" }, ctx)).rejects.toThrow(/not enabled/);
    expect(asked).toEqual([]);
    expect(commands).toEqual([]);
    expect(journal.at(-1)).toMatchObject({ allowed: false, code: "refused-disabled", machine: "nas" });
  });

  it("refuses an unknown machine", async () => {
    const { tool, ctx, commands } = await setup();
    await expect(tool.run({ machine: "elsewhere", command: "uptime" }, ctx)).rejects.toThrow(/No declared machine/);
    expect(commands).toEqual([]);
  });
});

describe("remote_exec — confirmation", () => {
  it("refused by the person: nothing runs, and the refusal is journalled", async () => {
    const { tool, ctx, commands, asked, journal } = await setup({ answer: false });
    await expect(tool.run({ machine: "pc2", command: "rm -rf /tmp/build" }, ctx)).rejects.toThrow(/refused this command/);
    expect(asked).toHaveLength(1);
    expect(commands).toEqual([]);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ allowed: false, code: "approval-denied", machine: "pc2", target: "ops@100.64.0.2:22", remoteCommand: "rm -rf /tmp/build" });
  });

  it("an approval that throws counts as a refusal", async () => {
    const { tool, commands } = await setup();
    const ctx: ToolContext = { sessionId: "s1", workspace: null, approve: async () => Promise.reject(new Error("window gone")) };
    await expect(tool.run({ machine: "pc2", command: "uptime" }, ctx)).rejects.toThrow(/refused/);
    expect(commands).toEqual([]);
  });

  it("approved: the command shown, with the machine, is exactly the remote command that runs", async () => {
    const command = `df -h / && grep -c "error" /var/log/syslog | tee /tmp/count.txt`;
    const { tool, ctx, commands, asked, journal } = await setup({ reply: { stdout: "Filesystem  Size\n/dev/sda1  50G\n", exitCode: 0 } });
    const out = await tool.run({ machine: "pc2", command }, ctx);

    expect(asked).toHaveLength(1);
    expect(asked[0]!.call.name).toBe("remote_exec");
    expect(asked[0]!.call.args).toMatchObject({ machine: "pc2", target: "ops@100.64.0.2:22", command });
    expect(asked[0]!.description).toContain("pc2");
    expect(asked[0]!.description).toContain("ops@100.64.0.2:22");

    expect(commands).toHaveLength(1);
    const argv = commands[0]!.args;
    expect(argv.at(-1)).toBe(command);
    expect(argv.at(-2)).toBe("ops@100.64.0.2");
    for (const option of ["StrictHostKeyChecking=yes", "BatchMode=yes", "RequestTTY=no", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no"]) {
      expect(argv).toContain(option);
    }
    expect(argv).not.toContain("-L");
    expect(argv).not.toContain("-R");
    expect(argv).not.toContain("-D");
    expect(commands[0]!.maxOutputChars).toBe(REMOTE_EXEC_OUTPUT_CAP);
    expect(commands[0]!.timeoutMs).toBe(60_000);

    expect(out).toContain("exit code 0");
    expect(out).toContain("/dev/sda1");
    expect(out).toContain("untrusted data");
    expect(journal.map((e) => e.code)).toEqual(["approved", "ok"]);
    expect(journal[1]).toMatchObject({ allowed: true, exitCode: 0, machine: "pc2", cmd: "remote-exec", client: "backend", surface: "backend", tier: "destructive" });
    expect(journal[0]!.requestId).toBe(journal[1]!.requestId);
  });

  it("each call asks again: one approval never covers the next command", async () => {
    const { tool, ctx, commands, asked } = await setup();
    await tool.run({ machine: "pc2", command: "uptime" }, ctx);
    await tool.run({ machine: "PC2", command: "whoami" }, ctx);
    expect(asked.map((a) => a.call.args.command)).toEqual(["uptime", "whoami"]);
    expect(commands.map((c) => c.args.at(-1))).toEqual(["uptime", "whoami"]);
  });

  it("a non-zero exit is reported with its code, and journalled", async () => {
    const { tool, ctx, journal } = await setup({ reply: { exitCode: 3, stderr: "no such file" } });
    const out = await tool.run({ machine: "pc2", command: "cat /nope" }, ctx);
    expect(out).toContain("exit code 3");
    expect(out).toContain("no such file");
    expect(journal.at(-1)).toMatchObject({ code: "exit", exitCode: 3 });
  });

  it("refuses commands whose confirmation could differ from what runs, before asking", async () => {
    const { tool, ctx, asked, commands } = await setup();
    for (const command of ["ls\rrm -rf ~", "echo \u001b[2Kok", "ls \u202e fdp.exe", "a\u200bb", "x".repeat(4_001), "   "]) {
      await expect(tool.run({ machine: "pc2", command }, ctx)).rejects.toThrow(/Refused/);
    }
    expect(asked).toEqual([]);
    expect(commands).toEqual([]);
    expect(remoteCommandProblem("for f in *.log; do\n\tgzip \"$f\"\ndone")).toBeNull();
  });
});

describe("remote_exec — host key and Internet switch", () => {
  it("refuses a machine whose host key is not trusted yet, without asking or connecting", async () => {
    const { tool, ctx, asked, commands, journal, keyChecks } = await setup({ trusted: false });
    await expect(tool.run({ machine: "pc2", command: "uptime" }, ctx)).rejects.toThrow(/host key/);
    expect(keyChecks).toEqual(["100.64.0.2:22"]);
    expect(asked).toEqual([]);
    expect(commands).toEqual([]);
    expect(journal.at(-1)).toMatchObject({ allowed: false, code: "refused-host-key" });
  });

  it("refuses while the Internet switch blocks the host", async () => {
    const offline: NetworkPolicy = { version: 1, internet: false, remoteMachines: false, remoteHosts: [], localCommands: false };
    const { tool, ctx, asked, commands, journal } = await setup({ policy: offline });
    await expect(tool.run({ machine: "pc2", command: "uptime" }, ctx)).rejects.toThrow(/Internet switch/);
    expect(asked).toEqual([]);
    expect(commands).toEqual([]);
    expect(journal.at(-1)).toMatchObject({ code: "refused-offline" });
  });

  it("runs while offline only through the remote-machines exception for that host", async () => {
    const policy: NetworkPolicy = { version: 1, internet: false, remoteMachines: true, remoteHosts: ["100.64.0.2"], localCommands: false };
    const { tool, ctx, commands } = await setup({ policy });
    await tool.run({ machine: "pc2", command: "uptime" }, ctx);
    expect(commands).toHaveLength(1);
  });

  it("checks again after the answer: a switch turned off meanwhile stops the command", async () => {
    let internet = true;
    const core = await makeCore();
    const commands: SshCommand[] = [];
    const ssh = new SshService({ keyExists: () => true, transport: async (c) => (commands.push(c), reply()) });
    const hosts = new SshHostsService(core.settings, ssh);
    const [pc2] = hosts.add({ name: "pc2", host: "100.64.0.2", username: "ops", keyPath: KEY });
    hosts.setExecEnabled(pc2!.id, true);
    const tool = remoteExecTool({ hosts, ssh, journal: () => {}, hostKeyTrusted: async () => true, policy: () => ({ ...DEFAULT_POLICY, internet }) });
    const ctx: ToolContext = {
      sessionId: "s",
      workspace: null,
      approve: async () => {
        internet = false;
        return true;
      },
    };
    await expect(tool.run({ machine: "pc2", command: "uptime" }, ctx)).rejects.toThrow(/Internet switch/);
    expect(commands).toEqual([]);
  });
});

describe("remote_exec — timeout and output cap", () => {
  it("passes the timeout to ssh and reports a killed command", async () => {
    const { tool, ctx, commands, journal } = await setup({ reply: { timedOut: true, exitCode: null } });
    const out = await tool.run({ machine: "pc2", command: "sleep 999", timeout_seconds: 5 }, ctx);
    expect(commands[0]!.timeoutMs).toBe(5_000);
    expect(out).toMatch(/Timed out after 5 s/);
    expect(journal.at(-1)).toMatchObject({ code: "timeout", exitCode: null, timedOut: true });
  });

  it("clamps the timeout to its maximum", async () => {
    const { tool, ctx, commands } = await setup();
    await tool.run({ machine: "pc2", command: "uptime", timeout_seconds: 99_999 }, ctx);
    expect(commands[0]!.timeoutMs).toBe(300_000);
  });

  it("a session never hands back more than the cap, even from a transport that ignores it", async () => {
    const { tool, ctx } = await setup({ reply: { stdout: "y".repeat(REMOTE_EXEC_OUTPUT_CAP * 3) } });
    const out = await tool.run({ machine: "pc2", command: "yes | head -c 100000" }, ctx);
    expect(out.length).toBeLessThan(REMOTE_EXEC_OUTPUT_CAP + 2_000);
    expect(out).toContain("output cut");
  });

  it("the real transport keeps reading past the cap, keeps only the cap, and reports the cut", async () => {
    // A local Node child stands in for ssh: same spawn, pipes and cap, no network.
    const raw = await spawnSshCommand({ file: process.execPath, args: ["-e", "process.stdout.write('z'.repeat(300000)); process.stderr.write('e'.repeat(10))"], timeoutMs: 20_000, maxOutputChars: 1_000 });
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).toBe("z".repeat(1_000));
    expect(raw.stderr).toBe("e".repeat(10));
    expect(raw.outputTruncated).toBe(true);
  }, 30_000);

  it("a session timeout guard also holds when the transport never answers", async () => {
    const { hosts, ctx, pc2 } = await setup();
    const ssh = new SshService({ keyExists: () => true, transport: () => new Promise(() => {}) });
    const tool = remoteExecTool({ hosts, ssh, journal: () => {}, hostKeyTrusted: async () => true, policy: () => DEFAULT_POLICY });
    expect(pc2).toBeDefined();
    const out = await tool.run({ machine: "pc2", command: "hang", timeout_seconds: 1 }, ctx);
    expect(out).toMatch(/Timed out/);
  }, 10_000);
});

describe("remote_exec — control journal", () => {
  it("writes the attempt, the decision and the exit code as JSON lines in the shell's shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-rx-"));
    const file = join(dir, "control-audit.jsonl");
    const { hosts, ctx } = await setup();
    const ssh = new SshService({ keyExists: () => true, transport: async () => reply({ exitCode: 0, stdout: "ok" }) });
    const env = { JAROD_CONTROL_JOURNAL: file, HERALD_OS_CONTROL_TOKEN: "tok-0123456789abcdef" };
    const tool = remoteExecTool({ hosts, ssh, env, hostKeyTrusted: async () => true, policy: () => DEFAULT_POLICY });
    expect(tool.available?.()).toBe(true);
    await tool.run({ machine: "pc2", command: "echo tok-0123456789abcdef" }, ctx);
    const refuse: ToolContext = { ...ctx, approve: async () => false };
    await expect(tool.run({ machine: "pc2", command: "reboot" }, refuse)).rejects.toThrow();

    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RemoteExecJournalEntry);
    expect(lines.map((l) => [l.code, l.allowed])).toEqual([
      ["approved", true],
      ["ok", true],
      ["approval-denied", false],
    ]);
    expect(lines[1]).toMatchObject({ client: "backend", cmd: "remote-exec", command: "remote_exec", source: "agent", exitCode: 0, machine: "pc2" });
    expect(typeof lines[0]!.at).toBe("string");
    expect(readFileSync(file, "utf8")).not.toContain("tok-0123456789abcdef");
    expect(lines[2]!.remoteCommand).toBe("reboot");
  });

  it("a journal that cannot be written stops the command before it runs", async () => {
    const { hosts, ctx } = await setup();
    const commands: SshCommand[] = [];
    const ssh = new SshService({ keyExists: () => true, transport: async (c) => (commands.push(c), reply()) });
    const tool = remoteExecTool({
      hosts,
      ssh,
      journal: () => {
        throw new Error("disk full");
      },
      hostKeyTrusted: async () => true,
      policy: () => DEFAULT_POLICY,
    });
    await expect(tool.run({ machine: "pc2", command: "uptime" }, ctx)).rejects.toThrow(/journal could not be written/);
    expect(commands).toEqual([]);
  });

  it("the sink rotates at its limit, keeping one older generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-rx-"));
    const file = join(dir, "j.jsonl");
    const sink = controlJournalSink(file, 200);
    const entry = { at: "x", client: "backend", cmd: "remote-exec", command: "remote_exec", tier: "destructive", source: "agent", surface: "backend", allowed: true, reason: "r", code: "ok", requestId: "rx-1" } as const;
    for (let i = 0; i < 5; i++) sink({ ...entry, requestId: `rx-${i}` });
    expect(readFileSync(`${file}.1`, "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toContain("rx-4");
  });
});
