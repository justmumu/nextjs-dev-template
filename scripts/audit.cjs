// @ts-check
"use strict";
// `pnpm run audit:dependencies`: a read-only report of the known advisories of the runtime, development
// and tool graphs, judged against the reviewed decisions in tooling/audit-policy.json. It never fixes,
// overrides or merges anything. An advisory that has no reviewed decision, a decision whose review date
// has passed, and an audit that could not be completed are all failures; none is reported as clean.
const nodePath = require("node:path");
const { parseArgs } = require("./core/args.cjs");
const { isObject, parseObject, readObject } = require("./core/json.cjs");
const { run } = require("./core/process.cjs");
const { readRole } = require("./core/toolchain.cjs");

const POLICY_FILE = nodePath.join("tooling", "audit-policy.json");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
/** The three graphs of a project: what ships, what builds and tests it, and everything installed including optional packages. */
const GRAPHS = Object.freeze([
  { name: "runtime", args: ["--prod"] },
  { name: "development", args: ["--dev"] },
  { name: "tools", args: [] },
]);

/**
 * @typedef {{ id: string, package: string, severity: string, installed: string[], graphs: string[], paths: string[], via: string, reachability: string, remediation: string, reviewed: string, reviewBy: string }} Decision
 * @typedef {{ id: string, package: string, severity: string, versions: string[], paths: string[] }} Finding
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{
 *   audit: (dir: string, args: readonly string[]) => { status: number | null, stdout: string },
 *   readPolicy: () => unknown,
 *   now: () => Date,
 *   io: Io,
 * }} Host what the report needs from the outside: the package manager's audit of a directory, the policy file, the clock and the output
 */

/** @param {unknown} value @returns {value is string} */
const text = (value) => typeof value === "string" && value !== "";

/**
 * Reads the reviewed decisions. A malformed file is a failure, never an empty policy.
 * @param {unknown} policy
 * @returns {{ decisions: Decision[], problems: string[] }}
 */
function decisionsOf(policy) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(policy) || policy.schema !== "nextjs-dev-template/audit-policy" || policy.protocol !== 1 || !Array.isArray(policy.advisories)) {
    return { decisions: [], problems: [`${POLICY_FILE} is not an audit policy (schema nextjs-dev-template/audit-policy, protocol 1)`] };
  }
  /** @type {Decision[]} */
  const decisions = [];
  for (const [index, entry] of policy.advisories.entries()) {
    const where = `${POLICY_FILE} advisories[${String(index)}]`;
    if (!isObject(entry)) {
      problems.push(`${where} is not an object`);
      continue;
    }
    const { id, package: name, severity, installed, graphs, paths, via, reachability, remediation, reviewed, reviewBy } = entry;
    const complete =
      text(id) &&
      text(name) &&
      text(severity) &&
      SEVERITIES.has(severity) &&
      Array.isArray(installed) &&
      installed.length > 0 &&
      installed.every(text) &&
      Array.isArray(graphs) &&
      graphs.length > 0 &&
      graphs.every((graph) => GRAPHS.some(({ name: known }) => known === graph)) &&
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.every(text) &&
      text(via) &&
      text(reachability) &&
      text(remediation) &&
      text(reviewed) &&
      DATE.test(reviewed) &&
      text(reviewBy) &&
      DATE.test(reviewBy);
    if (!complete)
      problems.push(`${where} needs id, package, severity, installed versions, graphs, paths, via, reachability, remediation, reviewed and reviewBy dates`);
    else
      decisions.push({
        id,
        package: name,
        severity,
        installed: installed.filter(text),
        graphs: graphs.filter(text),
        paths: paths.filter(text),
        via,
        reachability,
        remediation,
        reviewed,
        reviewBy,
      });
  }
  const seen = new Set();
  for (const { id, package: name } of decisions) {
    const key = `${id} ${name}`;
    if (seen.has(key)) problems.push(`${POLICY_FILE} decides ${id} for ${name} twice`);
    seen.add(key);
  }
  return { decisions, problems };
}

/**
 * The advisories of one `pnpm audit --json` answer. Anything but a complete advisory report is a
 * transport or format failure: a failed audit must never read as an empty one.
 * @param {{ status: number | null, stdout: string }} result
 * @returns {{ findings: Finding[] } | { failure: string }}
 */
function parseAudit(result) {
  if (result.status !== 0 && result.status !== 1) return { failure: `pnpm audit exited with status ${String(result.status)}` };
  /** @type {unknown} */
  let report;
  try {
    report = parseObject(result.stdout);
  } catch {
    return { failure: "pnpm audit did not answer with a JSON report" };
  }
  if (!isObject(report) || !isObject(report.advisories) || !isObject(report.metadata)) return { failure: "pnpm audit answered without an advisory report" };
  /** @type {Finding[]} */
  const findings = [];
  for (const advisory of Object.values(report.advisories)) {
    if (
      !isObject(advisory) ||
      !text(advisory.github_advisory_id) ||
      !text(advisory.module_name) ||
      !text(advisory.severity) ||
      !SEVERITIES.has(advisory.severity) ||
      !Array.isArray(advisory.findings) ||
      advisory.findings.length === 0
    ) {
      return { failure: "pnpm audit reported an advisory that cannot be read" };
    }
    /** @type {{ version: string, paths: string[] }[]} */
    const found = [];
    for (const finding of advisory.findings) {
      if (!isObject(finding) || !text(finding.version) || !Array.isArray(finding.paths) || finding.paths.length === 0 || !finding.paths.every(text)) {
        return { failure: "pnpm audit reported a finding without complete versions and dependency paths" };
      }
      found.push({ version: finding.version, paths: finding.paths.filter(text) });
    }
    findings.push({
      id: advisory.github_advisory_id,
      package: advisory.module_name,
      severity: advisory.severity,
      versions: [...new Set(found.map((finding) => finding.version))].sort(),
      paths: found.flatMap((finding) => finding.paths),
    });
  }
  if (result.status === 1 && findings.length === 0) return { failure: "pnpm audit failed without reporting an advisory" };
  return { findings };
}

/**
 * @param {Finding} finding @param {Decision[]} decisions @param {string} graph
 * @returns {Decision | null} the reviewed decision that covers this advisory, package, severity, installed versions and dependency paths in this graph
 */
function decisionFor(finding, decisions, graph) {
  return (
    decisions.find(
      (decision) =>
        decision.id === finding.id &&
        decision.package === finding.package &&
        decision.severity === finding.severity &&
        decision.graphs.includes(graph) &&
        finding.versions.every((version) => decision.installed.includes(version)) &&
        finding.paths.every((path) => decision.paths.includes(path)),
    ) ?? null
  );
}

/**
 * Judges every graph of every project against the decisions.
 * @param {{ label: string, dir: string }[]} projects
 * @param {Host} host
 * @returns {number} 0 only when every audit completed and every advisory has a current reviewed decision
 */
function report(projects, host) {
  const { io } = host;
  /** @type {unknown} */
  let policy;
  try {
    policy = host.readPolicy();
  } catch {
    policy = null;
  }
  const { decisions, problems } = decisionsOf(policy);
  if (problems.length > 0) {
    for (const problem of problems) io.stderr(`audit: ${problem}\n`);
    return 1;
  }
  const today = host.now().toISOString().slice(0, 10);
  /** @type {string[]} */
  const failures = [];
  /** @type {Map<string, Decision>} */
  const accepted = new Map();
  for (const { label, dir } of projects) {
    for (const graph of GRAPHS) {
      const outcome = parseAudit(host.audit(dir, ["audit", "--json", ...graph.args]));
      const where = `${label} ${graph.name}`;
      if ("failure" in outcome) {
        io.stderr(`audit: ${where}: ${outcome.failure}; the graph was not audited\n`);
        failures.push(`${where}: audit incomplete`);
        continue;
      }
      let unreviewed = 0;
      for (const finding of outcome.findings) {
        const decision = decisionFor(finding, decisions, graph.name);
        if (decision === null) {
          unreviewed += 1;
          io.stderr(`audit: ${where}: ${finding.id} ${finding.package}@${finding.versions.join(",")} (${finding.severity}) has no reviewed decision\n`);
          failures.push(`${where}: ${finding.id} unreviewed`);
        } else if (decision.reviewBy < today) {
          unreviewed += 1;
          io.stderr(`audit: ${where}: ${finding.id} ${finding.package} was reviewed until ${decision.reviewBy}; review it again\n`);
          failures.push(`${where}: ${finding.id} review expired`);
        } else accepted.set(`${finding.id} ${finding.package}`, decision);
      }
      io.stdout(
        `audit: ${where}: ${String(outcome.findings.length)} advisories, ${String(outcome.findings.length - unreviewed)} reviewed, ${String(unreviewed)} not\n`,
      );
    }
  }
  for (const decision of accepted.values()) {
    io.stdout(
      `audit: reviewed, not fixed: ${decision.id} ${decision.package}@${decision.installed.join(",")} (${decision.severity}) via ${decision.via}; reviewed ${decision.reviewed}, review again by ${decision.reviewBy}\n`,
    );
  }
  if (failures.length > 0) io.stderr(`audit failed: ${String(failures.length)} problem(s)\n`);
  return failures.length > 0 ? 1 : 0;
}

/**
 * The generator carries a second dependency graph: the application seed that every project is rendered from.
 * @param {string} role
 * @returns {{ label: string, dir: string }[]}
 */
function projectsFor(role) {
  return [{ label: "project", dir: "." }, ...(role === "generator" ? [{ label: "application seed", dir: nodePath.join("template", "app") }] : [])];
}

/** @param {string} root @returns {Host["audit"]} */
function pnpmAudit(root) {
  return (dir, args) => {
    const result = run("pnpm", args, { cwd: nodePath.resolve(root, dir) });
    return { status: result.status, stdout: result.stdout };
  };
}

/**
 * @param {readonly string[]} args
 * @param {{ root: string, io: Io, host?: Partial<Host> }} context
 * @returns {number}
 */
function auditCommand(args, { root, io, host }) {
  parseArgs(args, {});
  return report(projectsFor(readRole(root)), {
    audit: pnpmAudit(root),
    readPolicy: () => readObject(nodePath.join(root, POLICY_FILE)),
    now: () => new Date(),
    io,
    ...host,
  });
}

module.exports = { GRAPHS, POLICY_FILE, auditCommand, decisionFor, decisionsOf, parseAudit, projectsFor, report };
