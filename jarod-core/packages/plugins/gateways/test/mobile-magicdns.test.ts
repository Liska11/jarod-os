// The MagicDNS name of this computer, from `tailscale status --json`, and the rule that decides
// whether a name may be listed to a phone (the same rule as the phone's own check).
import { describe, expect, it } from "vitest";
import { isMagicDnsName, magicDnsNameFrom } from "../src/mobile.js";

describe("MagicDNS names", () => {
  it("accepts machine.tailnet.ts.net and nothing else", () => {
    expect(isMagicDnsName("hp-z2i.tailb39d55.ts.net")).toBe(true);
    expect(isMagicDnsName("HP-Z2I.TAILB39D55.TS.NET")).toBe(true);
    for (const bad of [
      "ts.net",
      "tailb39d55.ts.net",
      "evil.com",
      "hp.tailb39d55.ts.net.evil.com",
      "ts.net.evil.com",
      "hp.tailb39d55.xts.net",
      "hp.tailb39d55.ts.net.",
      "-hp.tail.ts.net",
      "hp_z.tail.ts.net",
      "hp..tail.ts.net",
      "",
      `${"a".repeat(64)}.tail.ts.net`,
    ]) {
      expect(isMagicDnsName(bad), bad).toBe(false);
    }
  });

  it("reads the name from a running Tailscale, without the final dot", () => {
    expect(magicDnsNameFrom({ BackendState: "Running", Self: { DNSName: "hp-z2i.tailb39d55.ts.net." } })).toBe("hp-z2i.tailb39d55.ts.net");
  });

  it("gives none when Tailscale is stopped, logged out, or says something odd", () => {
    expect(magicDnsNameFrom({ BackendState: "Stopped", Self: { DNSName: "hp-z2i.tailb39d55.ts.net." } })).toBeNull();
    expect(magicDnsNameFrom({ BackendState: "NeedsLogin" })).toBeNull();
    expect(magicDnsNameFrom({ BackendState: "Running", Self: {} })).toBeNull();
    expect(magicDnsNameFrom({ BackendState: "Running", Self: { DNSName: "jarod.example.org." } })).toBeNull();
    expect(magicDnsNameFrom({ BackendState: "Running", Self: { DNSName: 42 } })).toBeNull();
    expect(magicDnsNameFrom(null)).toBeNull();
    expect(magicDnsNameFrom("nimporte")).toBeNull();
  });
});
