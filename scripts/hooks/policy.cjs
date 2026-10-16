// @ts-check
"use strict";
// Pure guard decisions: how a shell command is read, which narrow route (if any) it is, and whether
// an observed change to a protected file is covered by what a finished call was allowed to do. No
// filesystem, no Git, no process: every decision here is judged from its arguments. Only `node:`
// modules and protected local .cjs files are loaded, so a broken dependency tree cannot disable it.
const nodePath = require("node:path");
const { parseArgs, UsageError } = require("../core/args.cjs");
const { manifestViolations, same, workspaceMeaning } = require("../core/dependency-policy.cjs");
const { isObject, parseObject } = require("../core/json.cjs");
const { FORMAT_EXTENSIONS, LINT_FIX_EXTENSIONS } = require("../core/quality.cjs");

/**
 * @typedef {{
 *   id: string,
 *   argv: string[],
 *   flags?: Record<string, string>,
 *   positional?: string[],
 *   allowance: string,
 *   userApproved?: boolean,
 * }} CommandRule one entry of the command grammar in tooling/policy.json
 * @typedef {{ commands: CommandRule[] }} GuardPolicy
 * @typedef {{
 *   files: "none" | "dependencies" | "format" | "lint-fix" | "version" | "history",
 *   edit: string | null,
 *   environment: "none" | "change" | "rebuild",
 *   hooks: boolean,
 *   head: boolean,
 *   accept: boolean,
 *   client: string,
 * }} Allowance what a finished call may have changed, recorded when it was admitted
 */

const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Monitor", "shell", "local_shell", "exec_command", "unified_exec"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HISTORY_COMMANDS = new Set(["switch", "checkout", "pull", "merge", "rebase", "reset", "restore", "stash", "cherry-pick"]);
const STATE_DIR_NAME = "protected-baseline";
const GUARD_FILES = ["entry.cjs", "guard.cjs", "policy.cjs", "state.cjs", "repo.cjs", "launch.sh", "recover-lock.cjs", "install.cjs"];
const SHELL_EXPANSION = /[`$\n\r{}]/;
const OPERATOR_CHARS = new Set([";", "&", "|", "<", ">", "(", ")"]);
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?^\t*\3[ \t]*$/gm;
const QUOTED = /((?:^|\s)(?:-c|-e|-p|--eval|--print|eval)\s+)?('[^']*'|"(?:\\.|[^"\\])*")/g;
const SUBSTITUTION = /\$\(|`/;
const INTERPRETERS = /(?:^|\/)(?:node[0-9.]*|exec|source|\.|sh|bash|zsh|env|launch\.sh)$/;
const CHECK_VARIABLES =
  "NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|ESLINT_USE_FLAT_CONFIG|HUSKY|HUSKY_SKIP_HOOKS|VITEST_[A-Z_]+|(?:npm|pnpm|NPM|PNPM)_config_[A-Za-z0-9_]+|COREPACK_[A-Z_]+";

/** @type {[RegExp, string][]} */
const SWITCH_OFF = [
  [/\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*\s-(?!-)[A-Za-z]*n[A-Za-z]*\b/, "`git commit -n` skips the Git hooks"],
  [/\bgit\b[^;&|\n]*\s--no-verify\b/, "`--no-verify` skips the Git hooks"],
  [/(?:^|[\s;&|(`'"])(?:SKIP|HUSKY)=|\bexport\s+(?:SKIP|HUSKY)\b/, "`SKIP=` and `HUSKY=` skip the Git hooks"],
  [/core\.hooks[Pp]ath/, "changing `core.hooksPath` disables the Git hooks"],
  [/\bGIT_CONFIG_(?:COUNT|KEY_\w*|VALUE_\w*|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM)\b/, "`GIT_CONFIG_*` variables override the repository's Git configuration"],
  [new RegExp(`\\b(?:${CHECK_VARIABLES})\\s*=|\\bexport\\s+(?:${CHECK_VARIABLES})\\b`), "these variables change how the checks run"],
  [
    /\bpnpm\b[^;&|\n]*\s(?:--config\.\S*|--dir\b|--prefix\b|--workspace-root\b|--ignore-workspace\b|-C\b)/,
    "pnpm configuration and directory overrides replace the project's package settings",
  ],
  [new RegExp(STATE_DIR_NAME.replace(/-/g, "\\-")), "the guard's baseline belongs to the guard"],
];
// `git [global options] commit`, but not `git commit-tree`.
const GIT_COMMIT = /\bgit(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+commit(?![\w-])/;
// Goals the user approves each time; only their exact standalone form reaches the prompt.
const USER_APPROVED_GOAL = /\b(?:bootstrap\.cjs\s+(guard-accept)|pnpm\s+(?:run\s+)?(release:(?:bump|tag)))\b/;

/**
 * Tokenizes without evaluating shell code. Operators are separate words; malformed quoting yields no words.
 * @param {string} command
 * @returns {string[]}
 */
function shellWords(command) {
  /** @type {string[]} */
  const words = [];
  let word = "";
  let started = false;
  let operator = false;
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
    operator = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index);
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      flush();
    } else if (OPERATOR_CHARS.has(char)) {
      if (started && !operator) flush();
      word += char;
      started = true;
      operator = true;
    } else {
      if (operator) flush();
      started = true;
      if (char === "\\") {
        index++;
        if (index >= command.length) return [];
        word += command.charAt(index);
      } else if (char === "'") {
        const end = command.indexOf("'", index + 1);
        if (end < 0) return [];
        word += command.slice(index + 1, end);
        index = end;
      } else if (char === '"') {
        index++;
        for (;;) {
          if (index >= command.length) return [];
          const inner = command.charAt(index);
          if (inner === '"') break;
          if (inner === "\\" && '"\\$`'.includes(command.charAt(index + 1))) {
            word += command.charAt(index + 1);
            index += 2;
          } else {
            word += inner;
            index++;
          }
        }
      } else {
        word += char;
      }
    }
  }
  flush();
  return words;
}

/**
 * Drops heredoc bodies and quoted data, keeping only text the shell would run. Quoted code handed
 * to `sh -c`, `eval` or `node -e` stays, because it is executed, and so does a command substitution
 * inside double quotes or inside an unquoted heredoc, which the shell expands and runs.
 * @param {string} command
 * @returns {string}
 */
function executableText(command) {
  const withoutBodies = command.replace(HEREDOC, (/** @type {string} */ match, /** @type {string} */ header, /** @type {string} */ quote) =>
    quote === "" && SUBSTITUTION.test(match) ? match : header,
  );
  return withoutBodies.replace(QUOTED, (/** @type {string} */ match, /** @type {string | undefined} */ executed) =>
    executed || (match.startsWith('"') && SUBSTITUTION.test(match)) ? match : "''",
  );
}

/** @param {string} command @returns {string[] | null} the words of a command with no evaluation, chaining or redirection; otherwise null */
function simpleWords(command) {
  const words = shellWords(command);
  if (words.length === 0 || SHELL_EXPANSION.test(command)) return null;
  return words.some((word) => /^[;&|<>()]+$/.test(word)) ? null : words;
}

/** @param {string} value @param {boolean} bare whether a version selector is refused @returns {boolean} whether it is one literal package specifier the dependency commands accept */
function validSpec(value, bare) {
  try {
    const { parseSpec } = require("../dependencies.cjs");
    const parsed = parseSpec(value);
    return !bare || parsed.selector === null;
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string>} flags the declared flags of a command: `spec`, `name`, `group`; a trailing `?` makes one optional
 * @returns {Record<string, { required?: boolean, values?: readonly string[] }>}
 */
function flagSchema(flags) {
  return Object.fromEntries(
    Object.entries(flags).map(([name, kind]) => [name, { required: !kind.endsWith("?"), ...(kind === "group" ? { values: ["prod", "dev"] } : {}) }]),
  );
}

/**
 * The one command route a foreground, literal, root-run command is: exact argv, declared flags only,
 * no expansion, no chaining. Everything else, including a prefix or a chain, is not a route.
 * @param {GuardPolicy} policy
 * @param {string[] | null} words the words of a simple command
 * @returns {CommandRule | null}
 */
function matchCommand(policy, words) {
  if (words === null) return null;
  for (const rule of policy.commands) {
    if (rule.argv.length > words.length || rule.argv.some((part, index) => words[index] !== part)) continue;
    const rest = words.slice(rule.argv.length);
    if (rule.positional) {
      const [only, ...extra] = rest;
      if (only !== undefined && extra.length === 0 && rule.positional.includes(only)) return rule;
      continue;
    }
    try {
      const flags = parseArgs(rest, flagSchema(rule.flags ?? {}));
      const kinds = rule.flags ?? {};
      const bad = Object.entries(flags).some(([name, value]) => {
        const kind = (kinds[name] ?? "").replace("?", "");
        return typeof value === "string" && (kind === "spec" || kind === "name") && !validSpec(value, kind === "name");
      });
      if (!bad) return rule;
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
    }
  }
  return null;
}

/** @param {string[]} words @returns {"commit" | "history" | null} */
function gitKind(words) {
  if (words.length < 2 || words[0] !== "git") return words.slice(0, 3).join(" ") === "gh pr checkout" ? "history" : null;
  if (words[1] === "commit") return "commit";
  return HISTORY_COMMANDS.has(words[1] ?? "") ? "history" : null;
}

/** @param {string} command @returns {boolean} whether the command executes a guard file rather than mentioning it */
function runsGuard(command) {
  const text = executableText(command);
  const words = shellWords(text);
  const names = GUARD_FILES.map((name) => `hooks/${name}`);
  const mentions = (/** @type {string} */ value) => names.some((name) => value.includes(name));
  if (words.length === 0) return mentions(text);
  return words.some((word, index) => mentions(word) && (index === 0 || INTERPRETERS.test(words[index - 1] ?? "") || /require|import|exec/.test(word)));
}

/**
 * @param {string} command
 * @param {{ words: string[] | null, route: CommandRule | null, kind: string | null }} call what the command was read as
 * @returns {string | null} why the command is refused, or null
 */
function switchOffReason(command, call) {
  const text = executableText(command);
  for (const [pattern, reason] of SWITCH_OFF) {
    if (pattern.test(text)) return `Refused: ${reason}. Run the checks as the project defines them.`;
  }
  if (runsGuard(command)) return "Refused: the guard runs only from its hooks and `node scripts/bootstrap.cjs guard-accept`.";
  if (GIT_COMMIT.test(text) && call.kind !== "commit")
    return "Refused: run `git commit` as a standalone command with no chaining or `$(...)`, e.g. `git commit -F <message-file>`, so the guard can check what it commits.";
  const goal = USER_APPROVED_GOAL.exec(text);
  if (goal && !(call.route?.userApproved === true))
    return `Refused: run \`${goal[1] ? "node scripts/bootstrap.cjs guard-accept" : `pnpm run ${goal[2] ?? ""}`}\` as a standalone command with no other goals or variables, so the user is asked.`;
  return null;
}

/** @param {string} patch @returns {string[]} every source and destination path of an apply_patch body */
function patchPaths(patch) {
  const prefixes = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
  return patch.split("\n").flatMap((line) => prefixes.filter((prefix) => line.startsWith(prefix)).map((prefix) => line.slice(prefix.length).trim()));
}

/**
 * @param {Partial<Allowance> & { client: string }} partial
 * @returns {Allowance}
 */
function allowance(partial) {
  return { files: "none", edit: null, environment: "none", hooks: false, head: false, accept: false, ...partial };
}

/**
 * What a call may change, derived from the route it is. Nothing a command merely mentions grants anything.
 * @param {{ route: CommandRule | null, kind: string | null, edit: string | null, client: string, failed: boolean, background: boolean }} call
 * @returns {Allowance}
 */
function allowanceFor({ route, kind, edit, client, failed, background }) {
  if (edit) return allowance({ client, edit });
  if (kind === "commit") return allowance({ client, files: "format", head: true });
  if (kind === "history") return allowance({ client, files: "history", head: true });
  if (!route || background) return allowance({ client });
  const kindOf = route.allowance;
  return allowance({
    client,
    files: kindOf === "dependencies" || kindOf === "format" || kindOf === "lint-fix" || kindOf === "version" ? kindOf : "none",
    environment: failed ? "none" : kindOf === "repair" ? "rebuild" : kindOf === "dependencies" || kindOf === "setup" ? "change" : "none",
    hooks: kindOf === "setup",
    head: kindOf === "version",
    accept: kindOf === "accept" && !failed,
  });
}

/** @param {Buffer | null} content @returns {import("../core/json.cjs").JsonObject | null} */
function manifestOf(content) {
  if (content === null) return null;
  try {
    return parseObject(content.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Formatting may re-flow, re-indent and re-mark prose; it may not change a word of it. The two texts
 * are equal once whitespace and markdown punctuation are dropped.
 * @param {Buffer} before @param {Buffer} after @returns {boolean}
 */
function sameProse(before, after) {
  /** @param {Buffer} content */
  const words = (content) => content.toString("utf8").replace(/[\s*_+|:#>`\\-]/g, "");
  return words(before) === words(after);
}

/**
 * The part of formatting and lint fixing that can be checked without a parser for the file type:
 * prose keeps its words and JSON keeps its meaning. Code, styles and YAML are rewritten by the
 * trusted tool the route names; what bounds them is the route, the file types and the protected set.
 * The lock belongs to pnpm, so no formatting route covers it. The workspace file carries dependency
 * and build policy (KTD11): its layout may change, but every key and value must stay.
 * @param {string[]} extensions the file types the route's tool rewrites
 * @param {string} path @param {Buffer} before @param {Buffer} after
 * @returns {boolean}
 */
function toolRewrites(extensions, path, before, after) {
  const extension = nodePath.extname(path).slice(1);
  const name = nodePath.basename(path);
  if (name === "pnpm-lock.yaml" || !extensions.includes(extension)) return false;
  if (name === "pnpm-workspace.yaml") {
    const was = workspaceMeaning(before.toString("utf8"));
    return was !== null && was === workspaceMeaning(after.toString("utf8"));
  }
  if (extension === "md") return sameProse(before, after);
  if (extension !== "json") return true;
  try {
    return same(JSON.parse(before.toString("utf8")), JSON.parse(after.toString("utf8")));
  } catch {
    return false;
  }
}

/**
 * Whether one change to a protected file stays inside what a field-level allowance covers.
 * @param {Allowance["files"]} scope
 * @param {string} path project-relative posix path
 * @param {Buffer | null} before the approved content
 * @param {Buffer | null} after the content found now
 * @returns {boolean}
 */
function scopeAccepts(scope, path, before, after) {
  if (after === null || before === null) return false;
  if (scope === "dependencies") {
    if (path === "pnpm-lock.yaml") return true;
    if (path !== "package.json") return false;
    const was = manifestOf(before);
    const now = manifestOf(after);
    return was !== null && now !== null && manifestViolations(was, now, { action: "approved-edit" }).length === 0;
  }
  if (scope === "format") return toolRewrites(FORMAT_EXTENSIONS, path, before, after);
  if (scope === "lint-fix") return toolRewrites(LINT_FIX_EXTENSIONS, path, before, after);
  if (scope === "version") {
    if (path !== "package.json") return false;
    const was = manifestOf(before);
    const now = manifestOf(after);
    if (was === null || now === null || typeof now.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(now.version)) return false;
    const { version: ignoredBefore, ...restBefore } = was;
    const { version: ignoredAfter, ...restAfter } = now;
    return ignoredBefore !== undefined && typeof ignoredAfter === "string" && same(restBefore, restAfter);
  }
  return false;
}

/** @param {string | null} before @param {string | null} after @returns {boolean} whether both are plain files of the same mode: a scoped tool rewrites content, not modes or links */
function sameKind(before, after) {
  const plain = (/** @type {string | null} */ id) => id !== null && !id.startsWith("symlink:");
  return plain(before) && plain(after) && (before ?? "").endsWith(":x") === (after ?? "").endsWith(":x");
}

/**
 * Decides whether any finished call in the window was allowed to make this change to the worktree.
 * @param {Allowance[]} window
 * @param {{ path: string, before: Buffer | null, after: Buffer | null, beforeId: string | null, afterId: string | null, committedId: string | null, history: (string | null)[] }} change
 * @returns {boolean}
 */
function fileAllowed(window, change) {
  return window.some((entry) => {
    if (entry.edit === change.path) return true;
    if (entry.files === "history") return change.afterId === change.committedId || change.history.includes(change.afterId);
    return sameKind(change.beforeId, change.afterId) && scopeAccepts(entry.files, change.path, change.before, change.after);
  });
}

/**
 * Whether a protected path was a symlink or is one now is decided by the repo; this tells whether a
 * tool-supplied path, resolved against its directory, names a protected target.
 * @param {string} root the real project root
 * @param {string} raw the path the tool received
 * @param {string} cwd
 * @param {(absolute: string) => string} realpath resolves symlinks through the deepest existing ancestor
 * @param {(relative: string) => boolean} isProtected
 * @returns {string | null} the protected project-relative path, or null
 */
function protectedTarget(root, raw, cwd, realpath, isProtected) {
  if (!raw) return null;
  const absolute = nodePath.resolve(cwd, raw.replace(/\\/g, "/"));
  for (const candidate of [absolute, realpath(absolute)]) {
    const relative = nodePath.relative(root, candidate).split(nodePath.sep).join("/");
    if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative)) continue;
    if (isProtected(relative) || isProtected(relative.toLowerCase())) return relative;
  }
  return null;
}

/** @param {unknown} value @returns {GuardPolicy} the validated guard section of tooling/policy.json */
function parseGuardPolicy(value) {
  if (!isObject(value) || !Array.isArray(value.commands)) throw new Error("tooling/policy.json: guard must declare commands");
  const commands = value.commands.map((rule) => {
    if (
      !isObject(rule) ||
      typeof rule.id !== "string" ||
      typeof rule.allowance !== "string" ||
      !Array.isArray(rule.argv) ||
      !rule.argv.every((word) => typeof word === "string")
    )
      throw new Error("tooling/policy.json: every guard command needs an id, an argv and an allowance");
    return /** @type {CommandRule} */ (rule);
  });
  return { commands };
}

module.exports = {
  EDIT_TOOLS,
  SHELL_TOOLS,
  STATE_DIR_NAME,
  allowanceFor,
  executableText,
  fileAllowed,
  gitKind,
  matchCommand,
  parseGuardPolicy,
  patchPaths,
  protectedTarget,
  runsGuard,
  scopeAccepts,
  shellWords,
  simpleWords,
  switchOffReason,
};
