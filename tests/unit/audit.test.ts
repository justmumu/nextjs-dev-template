import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const audit = createRequire(import.meta.url)("../../scripts/audit.cjs") as typeof import("../../scripts/audit.cjs");

const decision = {
  id: "GHSA-aaaa-bbbb-cccc",
  package: "left-pad",
  severity: "high",
  installed: ["1.0.0", "1.0.1"],
  graphs: ["development", "tools"],
  paths: [".>tool>left-pad@1.0.0", ".>tool>left-pad@1.0.1"],
  via: "tool>left-pad",
  reachability: "never called",
  remediation: "wait for a release",
  reviewed: "2026-10-17",
  reviewBy: "2027-01-15",
};
const policy = { schema: "nextjs-dev-template/audit-policy", protocol: 1, advisories: [decision] };

function advisory(over: Record<string, unknown> = {}, versions = ["1.0.0"]) {
  return {
    github_advisory_id: decision.id,
    module_name: decision.package,
    severity: decision.severity,
    findings: versions.map((version) => ({ version, paths: [`.>tool>left-pad@${version}`] })),
    ...over,
  };
}

function answer(advisories: unknown[], status = advisories.length > 0 ? 1 : 0) {
  return { status, stdout: JSON.stringify({ advisories: Object.fromEntries(advisories.map((entry, index) => [String(index), entry])), metadata: {} }) };
}

const clean = answer([]);

/** An audit host that answers each graph by the flags it was asked with. */
function hostFor(answers: Partial<Record<"runtime" | "development" | "tools", { status: number | null; stdout: string }>>, over: Record<string, unknown> = {}) {
  const sink = capture();
  const asked: string[] = [];
  const host = {
    audit: (dir: string, args: readonly string[]) => {
      const graph = args.includes("--prod") ? "runtime" : args.includes("--dev") ? "development" : "tools";
      asked.push(`${dir} ${args.join(" ")}`);
      return answers[graph] ?? clean;
    },
    readPolicy: () => policy,
    now: () => new Date("2026-11-01T00:00:00Z"),
    io: sink.io,
    ...over,
  };
  return { host, sink, asked };
}

const project = [{ label: "project", dir: "." }];

describe("the audit policy", () => {
  test("accepts complete decisions", () => {
    expect(audit.decisionsOf(policy)).toEqual({ decisions: [decision], problems: [] });
  });

  test.each([
    ["not an object", null],
    ["another schema", { ...policy, schema: "other" }],
    ["another protocol", { ...policy, protocol: 2 }],
    ["no advisory list", { schema: policy.schema, protocol: 1 }],
  ])("rejects a file that is %s", (_name, value) => {
    expect(audit.decisionsOf(value).problems).toHaveLength(1);
    expect(audit.decisionsOf(value).decisions).toEqual([]);
  });

  test.each([
    ["a non-object entry", "x"],
    ["no reachability", { ...decision, reachability: "" }],
    ["an unknown severity", { ...decision, severity: "urgent" }],
    ["an unknown graph", { ...decision, graphs: ["everything"] }],
    ["no installed version", { ...decision, installed: [] }],
    ["no reviewed dependency path", { ...decision, paths: [] }],
    ["a malformed review date", { ...decision, reviewBy: "soon" }],
  ])("rejects an entry with %s", (_name, entry) => {
    const { decisions, problems } = audit.decisionsOf({ ...policy, advisories: [entry] });
    expect(decisions).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  test("rejects the same advisory decided twice", () => {
    expect(audit.decisionsOf({ ...policy, advisories: [decision, decision] }).problems).toEqual([expect.stringContaining("twice")]);
  });
});

describe("reading an audit answer", () => {
  test("lists the advisories with their versions and paths", () => {
    expect(audit.parseAudit(answer([advisory({}, ["1.0.1", "1.0.0"])]))).toEqual({
      findings: [
        { id: decision.id, package: "left-pad", severity: "high", versions: ["1.0.0", "1.0.1"], paths: [".>tool>left-pad@1.0.1", ".>tool>left-pad@1.0.0"] },
      ],
    });
  });

  test("a clean report has no findings", () => {
    expect(audit.parseAudit(clean)).toEqual({ findings: [] });
  });

  test.each(
    [[], [{}], [3], [{ paths: [".>tool>left-pad"] }], [{ version: "1.0.0" }], [{ version: "1.0.0", paths: [] }], [{ version: "1.0.0", paths: [3] }]].map(
      (findings) => ({ findings }),
    ),
  )("rejects incomplete findings: %j", ({ findings }) => {
    expect(audit.parseAudit(answer([advisory({ findings })]))).toHaveProperty("failure");
  });

  test.each([
    ["an exit status other than 0 and 1", { status: 2, stdout: clean.stdout }],
    ["a missing exit status", { status: null, stdout: clean.stdout }],
    ["text instead of JSON", { status: 1, stdout: "ERR_PNPM_AUDIT_BAD_RESPONSE" }],
    ["an error object", { status: 1, stdout: JSON.stringify({ error: { code: "ENOTFOUND" } }) }],
    ["an advisory that cannot be read", answer([{ module_name: "x" }])],
    ["a failure that reports nothing", { status: 1, stdout: clean.stdout }],
  ])("is a failure, not a clean report, for %s", (_name, result) => {
    expect(audit.parseAudit(result)).toHaveProperty("failure");
  });
});

describe("matching an advisory to a reviewed decision", () => {
  const finding = { id: decision.id, package: "left-pad", severity: "high", versions: ["1.0.0"], paths: [".>tool>left-pad@1.0.0"] };

  test("covers the same advisory, package, severity, graph and installed versions", () => {
    expect(audit.decisionFor(finding, [decision], "development")).toBe(decision);
  });

  test.each([
    ["another advisory", { ...finding, id: "GHSA-zzzz-zzzz-zzzz" }, "development"],
    ["another package", { ...finding, package: "right-pad" }, "development"],
    ["a raised severity", { ...finding, severity: "critical" }, "development"],
    ["a version that was not reviewed", { ...finding, versions: ["1.0.0", "2.0.0"] }, "development"],
    ["a graph the decision does not name", finding, "runtime"],
    ["a new dependency path", { ...finding, paths: [...finding.paths, ".>network-client>left-pad@1.0.0"] }, "development"],
  ])("does not cover %s", (_name, other, graph) => {
    expect(audit.decisionFor(other, [decision], graph)).toBeNull();
  });
});

describe("the report", () => {
  test("a clean project passes and every graph of it was audited", () => {
    const { host, sink, asked } = hostFor({});
    expect(audit.report(project, host)).toBe(0);
    expect(asked).toEqual([". audit --json --prod", ". audit --json --dev", ". audit --json"]);
    expect(sink.out()).toContain("project runtime: 0 advisories");
    expect(sink.err()).toBe("");
  });

  test("a reviewed advisory passes and is still reported as not fixed", () => {
    const { host, sink } = hostFor({ development: answer([advisory()]), tools: answer([advisory()]) });
    expect(audit.report(project, host)).toBe(0);
    expect(sink.out()).toContain(
      `reviewed, not fixed: ${decision.id} left-pad@1.0.0,1.0.1 (high) via tool>left-pad; reviewed 2026-10-17, review again by 2027-01-15`,
    );
  });

  test("an advisory in the runtime graph is not covered by a development decision", () => {
    const { host, sink } = hostFor({ runtime: answer([advisory()]) });
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain(`project runtime: ${decision.id} left-pad@1.0.0 (high) has no reviewed decision`);
  });

  test("an unknown advisory fails and is named", () => {
    const { host, sink } = hostFor({ tools: answer([advisory({ github_advisory_id: "GHSA-new-new-new" })]) });
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain("GHSA-new-new-new");
    expect(sink.err()).toContain("audit failed: 1 problem(s)");
  });

  test("a known advisory on a new dependency path fails the report", () => {
    const { host, sink } = hostFor({ tools: answer([advisory({ findings: [{ version: "1.0.0", paths: [".>network-client>left-pad@1.0.0"] }] })]) });
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain("has no reviewed decision");
  });

  test("a decision past its review date fails", () => {
    const { host, sink } = hostFor({ development: answer([advisory()]) }, { now: () => new Date("2027-01-16T00:00:00Z") });
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain("reviewed until 2027-01-15; review it again");
  });

  test("a decision is current on its review date", () => {
    const { host } = hostFor({ development: answer([advisory()]), tools: answer([advisory()]) }, { now: () => new Date("2027-01-15T23:59:59Z") });
    expect(audit.report(project, host)).toBe(0);
  });

  test("a graph whose audit could not be completed fails instead of passing", () => {
    const { host, sink } = hostFor({ development: { status: 1, stdout: "network down" } });
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain("project development: pnpm audit did not answer with a JSON report; the graph was not audited");
  });

  test("every project is audited and one failing graph does not hide the others", () => {
    const { host, sink, asked } = hostFor({ runtime: answer([advisory()]) });
    const status = audit.report([...project, { label: "application seed", dir: "template/app" }], host);
    expect(status).toBe(1);
    expect(asked).toHaveLength(6);
    expect(sink.err()).toContain("project runtime");
    expect(sink.err()).toContain("application seed runtime");
  });

  test("fails without auditing when the policy cannot be read", () => {
    const { host, sink, asked } = hostFor(
      {},
      {
        readPolicy: () => {
          throw new Error("gone");
        },
      },
    );
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain("is not an audit policy");
    expect(asked).toEqual([]);
  });

  test("fails without auditing when a decision is malformed", () => {
    const { host, sink, asked } = hostFor({}, { readPolicy: () => ({ ...policy, advisories: [{ ...decision, via: "" }] }) });
    expect(audit.report(project, host)).toBe(1);
    expect(sink.err()).toContain("needs id");
    expect(asked).toEqual([]);
  });
});

describe("the projects audited", () => {
  test("an application audits its own graph; the generator also audits the seed every application is rendered from", () => {
    expect(audit.projectsFor("application")).toEqual([{ label: "project", dir: "." }]);
    expect(audit.projectsFor("generator")).toEqual([
      { label: "project", dir: "." },
      { label: "application seed", dir: "template/app" },
    ]);
  });
});
