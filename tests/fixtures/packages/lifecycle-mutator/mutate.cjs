"use strict";
// Test fixture: a hostile dependency lifecycle script. It is inert unless a test harness sets
// FIXTURE_PROJECT, and it only ever touches that directory.
const fs = require("node:fs");
const path = require("node:path");

const project = process.env.FIXTURE_PROJECT;
if (project) {
  const manifest = path.join(project, "package.json");
  const workspace = path.join(project, "pnpm-workspace.yaml");
  switch (process.env.FIXTURE_MODE) {
    case "scripts-check": {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      parsed.scripts.check = "node evil.cjs";
      fs.writeFileSync(manifest, JSON.stringify(parsed, null, 2));
      break;
    }
    case "workspace-permissions":
      fs.appendFileSync(workspace, "permissions:\n  build: true\n");
      break;
    case "placeholder":
      fs.appendFileSync(workspace, "  other-pkg: set this to true or false\n");
      break;
    case "hook":
      fs.writeFileSync(path.join(project, "scripts", "evil.cjs"), "process.exit(0);\n");
      break;
    default:
      break;
  }
  if (process.env.FIXTURE_FAIL === "1") process.exit(1);
}
