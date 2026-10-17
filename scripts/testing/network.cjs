// @ts-check
"use strict";
// A command run without outbound network. Linux network namespaces are used: the command gets a
// namespace of its own with only the loopback interface raised, because the tools need loopback
// (Next.js workers talk over it) and nothing else. Where this cannot be done the answer says so;
// the caller must not report an unisolated run as an offline proof.
const nodePath = require("node:path");
const { resolveOnPath } = require("../core/toolchain.cjs");
const { run } = require("../core/process.cjs");

// 192.0.2.1 is TEST-NET-1, reserved for documentation: nothing answers it, and a namespace without
// a route to it fails at once with ENETUNREACH instead of waiting for a timeout.
const PROBE = `
const net = require("node:net");
const outbound = net.connect({ host: "192.0.2.1", port: 80 });
outbound.setTimeout(3000, () => { console.error("outbound connection was not refused"); process.exit(1); });
outbound.on("connect", () => { console.error("outbound connection succeeded"); process.exit(1); });
outbound.on("error", (error) => {
  if (!["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EAI_AGAIN"].includes(error.code)) { console.error("unexpected outbound error " + error.code); process.exit(1); }
  const server = net.createServer((socket) => socket.end()).listen(0, "127.0.0.1", () => {
    net.connect(server.address().port, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1));
  });
});
`;

const SBIN = ["/usr/sbin", "/sbin"];

/**
 * @typedef {{ available: true, wrap: (command: string, args: readonly string[]) => { command: string, args: string[] } }
 *   | { available: false, reason: string }} Isolation
 * @typedef {{ platform: string, pathValue: string, which: (name: string, pathValue: string) => string | null, probe: (command: string, args: string[]) => { status: number | null, output: string } }} Host
 */

/** @returns {Host} */
function realHost() {
  return {
    platform: process.platform,
    pathValue: process.env.PATH ?? "",
    which: resolveOnPath,
    probe: (command, args) => {
      const result = run(command, args, { cwd: process.cwd() });
      return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
    },
  };
}

/**
 * @param {Host} [host]
 * @returns {Isolation} how to run a command without outbound network, proved by a probe that fails to connect outward and succeeds on loopback inside the same kind of namespace
 */
function isolation(host = realHost()) {
  if (host.platform !== "linux") return { available: false, reason: `network namespaces are not available on ${host.platform}` };
  const unshare = host.which("unshare", host.pathValue);
  if (unshare === null) return { available: false, reason: "unshare is not installed" };
  const ip = host.which("ip", [host.pathValue, ...SBIN].join(nodePath.delimiter));
  if (ip === null) return { available: false, reason: "ip is not installed" };
  /** @type {Isolation} */
  const candidate = {
    available: true,
    wrap: (command, args) => ({
      command: unshare,
      // The shell only raises the loopback interface and replaces itself with the command: every
      // value reaches the command as a literal argument.
      args: ["--user", "--map-root-user", "--net", "sh", "-c", '"$1" link set lo up && shift && exec "$@"', "sh", ip, command, ...args],
    }),
  };
  const probe = candidate.wrap(process.execPath, ["-e", PROBE]);
  const outcome = host.probe(probe.command, probe.args);
  return outcome.status === 0
    ? candidate
    : { available: false, reason: `an unprivileged network namespace could not be proved: ${outcome.output || `exit ${String(outcome.status)}`}` };
}

module.exports = { PROBE, isolation };
