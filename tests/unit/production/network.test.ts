import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type Network = typeof import("../../../scripts/testing/network.cjs");
const network = createRequire(import.meta.url)("../../../scripts/testing/network.cjs") as Network;
type Host = NonNullable<Parameters<Network["isolation"]>[0]>;

function host(overrides: Partial<Host> & { found?: Record<string, string> } = {}) {
  const probes: { command: string; args: string[] }[] = [];
  const { found = { unshare: "/usr/bin/unshare", ip: "/usr/sbin/ip" }, ...rest } = overrides;
  const value: Host = {
    platform: "linux",
    pathValue: "/usr/bin:/bin",
    which: (name, pathValue) => (name === "ip" && !pathValue.includes("/usr/sbin") ? null : (found[name] ?? null)),
    probe: (command, args) => {
      probes.push({ command, args });
      return { status: 0, output: "" };
    },
    ...rest,
  };
  return { value, probes };
}

describe("running a command without outbound network", () => {
  test("is proved by a probe run the same way the command will be", () => {
    const { value, probes } = host();
    const result = network.isolation(value);
    expect(result.available).toBe(true);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.command).toBe("/usr/bin/unshare");
    expect(probes[0]?.args.slice(0, 4)).toEqual(["--user", "--map-root-user", "--net", "sh"]);
    expect(probes[0]?.args).toContain(network.PROBE);
  });

  test("wraps a command so that only loopback is raised and every value stays a literal argument", () => {
    const result = network.isolation(host().value);
    if (!result.available) throw new Error("expected isolation");
    const wrapped = result.wrap("/node", ["next", "build; rm -rf /", "$(id)"]);
    expect(wrapped).toEqual({
      command: "/usr/bin/unshare",
      args: [
        "--user",
        "--map-root-user",
        "--net",
        "sh",
        "-c",
        '"$1" link set lo up && shift && exec "$@"',
        "sh",
        "/usr/sbin/ip",
        "/node",
        "next",
        "build; rm -rf /",
        "$(id)",
      ],
    });
  });

  test("finds ip in the system directories that a user's PATH often leaves out", () => {
    expect(network.isolation(host({ pathValue: "/usr/bin" }).value).available).toBe(true);
  });

  test.each([
    ["on another platform", { platform: "darwin" }, /not available on darwin/],
    ["without unshare", { found: { ip: "/usr/sbin/ip" } }, /unshare is not installed/],
    ["without ip", { found: { unshare: "/usr/bin/unshare" } }, /ip is not installed/],
    [
      "when the namespace cannot be created",
      { probe: () => ({ status: 1, output: "unshare: unshare failed: Operation not permitted" }) },
      /could not be proved: unshare: unshare failed: Operation not permitted/,
    ],
    ["when the probe says nothing", { probe: () => ({ status: null, output: "" }) }, /could not be proved: exit null/],
  ])("is reported unavailable %s", (_name, overrides, reason) => {
    const result = network.isolation(host(overrides).value);
    expect(result.available).toBe(false);
    expect(result.available ? "" : result.reason).toMatch(reason);
  });
});
