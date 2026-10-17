// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { createInventory } = require("../core/protected.cjs");
const { isObject } = require("../core/json.cjs");
const completion = require("./completion.cjs");
const policy = require("./policy.cjs");
const { openRepo, SYMLINK_PREFIX, contentOf } = require("./repo.cjs");
const state = require("./state.cjs");

const { GuardError } = state;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_MESSAGE = 2000;
const MAX_TRANSCRIPT_PATH = 4096;
const CLAUDE_GUARD_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "ConfigChange", "Stop"];
const USER_FILES = ["config.toml", "hooks.json"];
const HOOKS_OFF = /^\s*(?:codex_)?hooks\s*=\s*false\b/m;

const RESTORED =
  "Writing these files directly is forbidden for agents: {paths}. They were restored. Use the documented commands (pnpm run deps:add, pnpm run deps:remove, pnpm run deps:upgrade, pnpm run format) or ask the user to make or approve the change.";
const DRIFT =
  "Protected project state changed outside an agent call: {paths}. Stop and ask the user whether they made this change; `git diff` shows it. If they did and want to keep it, they approve `node scripts/bootstrap.cjs guard-accept`.";
const ENVIRONMENT_DRIFT =
  "The dependency environment changed outside an approved command. Run `node scripts/bootstrap.cjs repair` to rebuild it from the frozen lock, or ask the user to approve `node scripts/bootstrap.cjs guard-accept` if they made the change.";
const OPERATION_HELD =
  "A merge, rebase or cherry-pick changed protected files it could not settle: {paths}. They were left as they are. Stop and ask the user to resolve them and finish the operation, then to approve `node scripts/bootstrap.cjs guard-accept`.";
const BUSY = "Another call that can change protected files is running. Retry after it finishes.";
const BACKGROUND = "Run the project's commands in the foreground, so the guard can check their changes.";

/**
 * @typedef {import("./repo.cjs").Repo} Repo
 * @typedef {import("./state.cjs").State} State
 * @typedef {import("./policy.cjs").Allowance} Allowance
 * @typedef {import("./policy.cjs").GuardPolicy} GuardPolicy
 * @typedef {{ repo: Repo, policy: GuardPolicy, inventory: ReturnType<typeof createInventory>, client: string, policyText: Buffer }} Context
 * @typedef {Record<string, unknown>} Output
 */

/** @param {unknown} value @returns {string} the value when it is a string, otherwise empty */
const textOf = (value) => (typeof value === "string" ? value : "");

/** @param {Context} context @returns {completion.Environment} where this machine's host keeps the transcripts that show a call finished */
const transcripts = (context) => ({ codexHome: context.repo.codexHome, files: context.repo.files });

/** @param {unknown} value @returns {string | null} the transcript path a host named, when it is a usable absolute path */
const transcriptOf = (value) => (typeof value === "string" && value.length <= MAX_TRANSCRIPT_PATH && nodePath.isAbsolute(value) ? value : null);

/** @param {string} template @param {string} paths @returns {string} */
const fill = (template, paths) => template.replace("{paths}", paths);

/** @param {string} reason @returns {Output} a PreToolUse refusal both hosts understand */
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** @param {State["approved"]} approved @param {string} path @param {string | null} id */
function approve(approved, path, id) {
  const history = (approved[path] ??= []);
  if (!history.includes(id)) history.push(id);
}

/**
 * @param {Record<string, string | null>} ids
 * @param {Record<string, string | null>} reference
 * @param {State["approved"]} approved
 * @returns {string[]} paths whose content is neither the reference content nor previously approved
 */
function unapproved(ids, reference, approved) {
  return Object.entries(ids)
    .filter(([path, id]) => id !== (reference[path] ?? null) && !(approved[path] ?? []).includes(id))
    .map(([path]) => path);
}

/** @param {Context} context @param {State | null} baseline @returns {string[]} */
const candidates = (context, baseline) => context.repo.candidates(Object.keys(baseline?.files ?? {}));

/** @param {Context} context @returns {State["user"]} copies of the user-level Codex files as they are now */
function storeUserFiles(context) {
  return Object.fromEntries(
    USER_FILES.map((name) => {
      const { content } = context.repo.userFile(name);
      return [name, content === null ? null : context.repo.storeContent(content)];
    }),
  );
}

/**
 * Records the current protected state as the approved baseline, keeping the approval history and the
 * calls that are still reserved.
 * @param {Context} context @param {State | null} previous
 * @returns {State}
 */
function snapshot(context, previous) {
  const { repo } = context;
  const paths = candidates(context, previous);
  /** @type {State["files"]} */
  const files = Object.fromEntries(paths.map((path) => [path, repo.capture(path)]));
  const approved = previous?.approved ?? {};
  for (const ids of [files, repo.indexIds(paths)]) for (const [path, id] of Object.entries(ids)) approve(approved, path, id);
  const hooks = repo.hooks(true);
  const user = storeUserFiles(context);
  const policyId = repo.storeContent(context.policyText);
  repo.prune([...Object.values(files), ...Object.values(hooks.scripts).map((entry) => entry.split(":")[0] ?? null), ...Object.values(user), policyId]);
  return {
    version: state.STATE_VERSION,
    policy: policyId,
    files,
    approved,
    head: repo.head(),
    hooks,
    environment: repo.environment(),
    environmentBlocked: false,
    user,
    blocked: null,
    inflight: previous?.inflight ?? {},
    window: [],
    needsEvaluation: false,
  };
}

/** @param {Context} context @param {State} baseline @returns {string[]} protected state that differs from the baseline */
function drift(context, baseline) {
  const { repo } = context;
  const paths = candidates(context, baseline);
  const current = repo.worktreeIds(paths);
  const changed = paths.filter((path) => current[path] !== (baseline.files[path] ?? null));
  const staged = unapproved(repo.indexIds(paths), repo.treeIds(paths), baseline.approved);
  changed.push(...staged.map((path) => `${path} (staged)`));
  if (JSON.stringify(repo.hooks(false)) !== JSON.stringify(baseline.hooks)) changed.push("Git hooks");
  return changed;
}

/** @param {Context} context @returns {boolean} whether protected files or their staged copies differ from HEAD */
function driftFromHead(context) {
  const { repo } = context;
  const paths = candidates(context, null);
  const committed = repo.treeIds(paths);
  const worktree = repo.worktreeIds(paths);
  const staged = repo.indexIds(paths);
  return paths.some((path) => worktree[path] !== committed[path] || staged[path] !== committed[path]);
}

/**
 * Accepts approved changes to protected files, restores the rest, or holds them mid-operation.
 * @param {Context} context @param {State} baseline @param {string[]} paths @param {Record<string, string | null>} committed @param {boolean} hold
 * @returns {{ restored: string[], held: string[], failed: string[] }}
 */
function checkFiles(context, baseline, paths, committed, hold) {
  const { repo } = context;
  const current = repo.worktreeIds(paths);
  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const held = [];
  /** @type {string[]} */
  const failed = [];
  for (const path of paths) {
    const now = current[path] ?? null;
    if (now === (baseline.files[path] ?? null)) continue;
    const allowed = policy.fileAllowed(baseline.window, {
      path,
      before: repo.readBlob(baseline.files[path] ?? null),
      after: repo.readWorktree(path),
      beforeId: baseline.files[path] ?? null,
      afterId: now,
      committedId: committed[path] ?? null,
      history: baseline.approved[path] ?? [],
    });
    if (allowed) {
      baseline.files[path] = repo.capture(path);
      approve(baseline.approved, path, baseline.files[path] ?? null);
    } else if (hold) {
      held.push(path);
    } else {
      try {
        repo.restore(path, baseline.files[path] ?? null);
        restored.push(path);
      } catch (error) {
        failed.push(`${path} (${/** @type {Error} */ (error).message})`);
      }
    }
  }
  return { restored, held, failed };
}

/** @param {Context} context @param {State} baseline @param {string[]} paths @param {Record<string, string | null>} committed @returns {string[]} */
function checkIndex(context, baseline, paths, committed) {
  const staged = unapproved(context.repo.indexIds(paths), committed, baseline.approved);
  context.repo.resetIndex(staged);
  return staged.length === 0 ? [] : [`Unstaged unapproved changes to ${staged.join(", ")}; they cannot be committed.`];
}

/**
 * Blocks when new commits carry protected content no approved route produced.
 * @param {Context} context @param {State} baseline @param {string[]} paths @returns {string[]}
 */
function checkHead(context, baseline, paths) {
  const { repo } = context;
  const current = repo.head();
  const previous = baseline.head;
  baseline.head = current;
  const routes = baseline.window.filter((entry) => entry.head);
  if (current === previous || current === null) return [];
  if (routes.some((entry) => entry.files === "history")) return [];
  // Files that exist only in a commit are invisible to the worktree and index listing.
  const all = [...new Set([...paths, ...repo.treePaths(current), ...(previous ? repo.treePaths(previous) : [])])].sort();
  const after = repo.treeIds(all);
  const before = previous ? repo.treeIds(all, previous) : Object.fromEntries(all.map((path) => [path, null]));
  const unapprovedPaths = unapproved(after, before, baseline.approved).filter((path) => {
    if (!routes.some((entry) => entry.files === "version")) return true;
    return !policy.scopeAccepts("version", path, readBlobFromGit(repo, before[path] ?? null), readBlobFromGit(repo, after[path] ?? null));
  });
  if (unapprovedPaths.length === 0) return [];
  baseline.blocked = `A commit recorded unapproved changes to ${unapprovedPaths.join(", ")}. Stop and ask the user to review and undo it, or to approve \`node scripts/bootstrap.cjs guard-accept\`.`;
  return [baseline.blocked];
}

/** @param {Repo} repo @param {string | null} id @returns {Buffer | null} committed content is read from the object store, not from the approved copies */
function readBlobFromGit(repo, id) {
  return id === null || id.startsWith(SYMLINK_PREFIX) ? null : repo.readObject(contentOf(id));
}

/** @param {Context} context @param {State} baseline @returns {string[]} */
function checkHooks(context, baseline) {
  const current = context.repo.hooks(false);
  if (JSON.stringify(current) === JSON.stringify(baseline.hooks)) return [];
  if (baseline.window.some((entry) => entry.hooks)) {
    baseline.hooks = context.repo.hooks(true);
    return [];
  }
  context.repo.restoreHooks(baseline.hooks);
  if (current.path !== baseline.hooks.path) {
    baseline.blocked = "core.hooksPath changed. Stop and ask the user to restore the Git hooks configuration.";
    return [baseline.blocked];
  }
  return ["The Git hooks were changed and have been restored; they run the project's checks."];
}

/** @param {Context} context @param {State} baseline @returns {string[]} */
function checkEnvironment(context, baseline) {
  const current = context.repo.environment();
  const kinds = baseline.window.map((entry) => entry.environment);
  // A rebuild lifts the block whether or not the fingerprint happens to equal the old one.
  if (kinds.includes("rebuild")) {
    baseline.environment = current;
    baseline.environmentBlocked = false;
    return [];
  }
  if (current === baseline.environment) return [];
  if (kinds.includes("change")) {
    baseline.environment = current;
    return [];
  }
  baseline.environmentBlocked = true;
  return [ENVIRONMENT_DRIFT];
}

/**
 * @param {string} name @param {Buffer | null} content @param {string} root
 * @returns {boolean} whether a user-level Codex file switches hooks off or untrusts the project
 */
function disablesHooks(name, content, root) {
  if (content === null) return false;
  const text = content.toString("utf8");
  if (name === "hooks.json") {
    try {
      JSON.parse(text);
    } catch {
      return true;
    }
    return false;
  }
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return HOOKS_OFF.test(text) || new RegExp(`\\[projects\\."${escaped}"\\][^\\[]*trust_level\\s*=\\s*"(?!trusted")`).test(text);
}

/** @param {Context} context @param {State} baseline @returns {string[]} */
function checkUserFiles(context, baseline) {
  const restored = [];
  for (const name of USER_FILES) {
    const { path, content } = context.repo.userFile(name);
    const id = content === null ? null : context.repo.blobId(content);
    if (id === (baseline.user[name] ?? null)) continue;
    const previous = context.repo.readBlob(baseline.user[name] ?? null);
    if (disablesHooks(name, content, context.repo.root) && previous !== null) {
      context.repo.writeUserFile(name, previous);
      restored.push(path);
    } else {
      baseline.user[name] = content === null ? null : context.repo.storeContent(content);
    }
  }
  return restored.length === 0 ? [] : [`Restored ${restored.join(", ")}: agents may not switch the project's hooks off.`];
}

/**
 * Compares the worktree with the baseline after the last running call ended.
 * @param {Context} context @param {State} baseline @returns {string[]}
 */
function evaluate(context, baseline) {
  const { repo } = context;
  baseline.needsEvaluation = false;
  const paths = candidates(context, baseline);
  const committed = repo.treeIds(paths);
  const hold = (repo.operationInProgress() || repo.unmerged(paths).size > 0) && baseline.window.some((entry) => entry.files === "history");
  const { restored, held, failed } = checkFiles(context, baseline, paths, committed, hold);
  /** @type {string[]} */
  const problems = [];
  if (restored.length > 0) problems.push(fill(RESTORED, restored.join(", ")));
  if (held.length > 0) {
    baseline.blocked = fill(OPERATION_HELD, held.join(", "));
    problems.push(baseline.blocked);
  }
  if (failed.length > 0) {
    baseline.blocked = `Protected files could not be restored: ${failed.join("; ")}. Stop and ask the user to restore them.`;
    problems.push(baseline.blocked);
  }
  problems.push(
    ...checkIndex(
      context,
      baseline,
      paths.filter((path) => !held.includes(path)),
      committed,
    ),
  );
  problems.push(...checkHead(context, baseline, paths));
  problems.push(...checkHooks(context, baseline));
  problems.push(...checkEnvironment(context, baseline));
  problems.push(...checkUserFiles(context, baseline));
  baseline.window = [];
  return problems;
}

/**
 * One tool call, classified once from its tool name and input.
 * @param {Context} context @param {Record<string, unknown>} payload
 */
function classify(context, payload) {
  const { repo, inventory } = context;
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const shell = policy.SHELL_TOOLS.has(tool);
  const command = shell && typeof input.command === "string" ? input.command : "";
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : repo.root;
  const words = command === "" ? null : policy.simpleWords(command);
  const background = input.run_in_background === true || tool === "Monitor";
  const atRoot = repo.realpath(nodePath.resolve(cwd)) === repo.root;
  const route = atRoot ? policy.matchCommand(context.policy, words) : null;
  const kind = words ? policy.gitKind(words) : null;
  const isProtected = (/** @type {string} */ relative) => inventory.isProtectedFile(relative) || inventory.isShadowOverride(relative);
  const rawPath = textOf(input.file_path) || textOf(input.notebook_path);
  const edit = policy.EDIT_TOOLS.has(tool) ? policy.protectedTarget(repo.root, rawPath, cwd, repo.realpath, isProtected) : null;
  const digest = createHash("sha256")
    .update(JSON.stringify([tool, command, rawPath]))
    .digest("hex");
  return { tool, input, shell, command, cwd, words, background, route, kind, edit, digest, isProtected, exclusive: Boolean(route || kind || edit) };
}

/** @param {Context} context @param {State} baseline @param {string | null} route @returns {string | null} why a call is refused while protected state differs from the baseline */
function preDriftRefusal(context, baseline, route) {
  baseline.user = storeUserFiles(context);
  if (baseline.blocked) return baseline.blocked;
  const changed = drift(context, baseline);
  if (changed.length > 0) return fill(DRIFT, changed.join(", "));
  if (context.repo.environment() !== baseline.environment) baseline.environmentBlocked = true;
  if (baseline.environmentBlocked && route !== "repair") return ENVIRONMENT_DRIFT;
  const problems = checkHead(context, baseline, candidates(context, baseline));
  return problems.length > 0 ? problems.join(" ") : null;
}

/** @param {Context} context @param {Record<string, unknown>} payload @returns {Output} */
function preTool(context, payload) {
  const call = classify(context, payload);
  if (call.command !== "") {
    const reason = policy.switchOffReason(call.command, { words: call.words, route: call.route, kind: call.kind });
    if (reason) return deny(reason);
  }
  if (policy.EDIT_TOOLS.has(call.tool) && textOf(call.input.file_path).includes(policy.STATE_DIR_NAME))
    return deny("Refused: the guard's baseline belongs to the guard.");
  if (call.tool === "apply_patch") {
    const patch = textOf(call.input.command);
    const touches = policy
      .patchPaths(patch)
      .some((path) => policy.protectedTarget(context.repo.root, path, call.cwd, context.repo.realpath, call.isProtected) !== null);
    if (touches)
      return deny(
        "Agents may not patch protected files. Ask the user to make this change; for dependencies use pnpm run deps:add, deps:remove or deps:upgrade.",
      );
  }
  if (call.route && call.background) return deny(BACKGROUND);
  const identity = state.identityOf(payload, context.client);
  return context.repo.locked(() => {
    let baseline = context.repo.readState();
    if (baseline === null) {
      // The accept route creates the baseline itself once the user approves it; Claude runs this hook
      // before asking, so nothing may be recorded here.
      if (call.route?.allowance === "accept") return {};
      if (driftFromHead(context)) return deny(fill(DRIFT, "protected files differ from HEAD on the guard's first run"));
      baseline = snapshot(context, null);
    }
    const environment = transcripts(context);
    const ancestry = completion.createAncestry(environment);
    const others = completion.liveCalls(baseline, environment, ancestry);
    const idle = Object.keys(others).length === 0;
    // Only a call that may change protected files defers judging them: a long-running ordinary call, such
    // as a development server, is not an exclusive writer and gives no allowance, so it cannot postpone the check.
    const quiet = completion.exclusiveCalls(others).length === 0;
    if (quiet && (baseline.window.length > 0 || baseline.needsEvaluation)) {
      // Calls that ended without a result (a denied permission) left changes to judge.
      const problems = evaluate(context, baseline);
      if (problems.length > 0) {
        context.repo.writeState(baseline);
        return deny(problems.join(" "));
      }
    }
    if (!idle && (call.exclusive || !quiet)) {
      context.repo.writeState(baseline);
      return deny(BUSY);
    }
    if (quiet && call.route?.allowance !== "accept") {
      const refusal = preDriftRefusal(context, baseline, call.route?.id ?? null);
      if (refusal) {
        context.repo.writeState(baseline);
        return deny(refusal);
      }
    }
    const reserved = state.reserve(baseline, identity.id, {
      client: identity.client,
      session: identity.session,
      turn: identity.turn,
      digest: call.digest,
      exclusive: call.exclusive,
      route: call.route?.id ?? null,
      completion: "result",
      shell: call.shell,
      transcript: transcriptOf(payload.transcript_path),
      allowances: {
        success: policy.allowanceFor({
          route: call.route,
          kind: call.kind,
          edit: call.edit,
          client: context.client,
          failed: false,
          background: call.background,
        }),
        failure: policy.allowanceFor({
          route: call.route,
          kind: call.kind,
          edit: call.edit,
          client: context.client,
          failed: true,
          background: call.background,
        }),
      },
    });
    // History before the admission is skipped, so only what the call itself does can finish it.
    const admitted = reserved ? baseline.inflight[identity.id] : undefined;
    if (admitted) completion.commandCompletion(admitted, identity.id, { environment, ancestry, starting: true });
    context.repo.writeState(baseline);
    return reserved ? {} : deny(BUSY);
  });
}

/** @param {Context} context @param {Record<string, unknown>} payload @param {boolean} failed @returns {Output} */
function postTool(context, payload, failed) {
  const call = classify(context, payload);
  /** @type {string[]} */
  let problems = [];
  context.repo.locked(() => {
    const baseline = context.repo.readState();
    if (baseline === null) return;
    const environment = transcripts(context);
    const ancestry = completion.createAncestry(environment);
    try {
      const identity = state.identityOf(payload, context.client);
      const entry = state.owned(baseline, identity, call.digest);
      if (typeof entry !== "string") {
        // A Codex shell call is finished by its own transcript; its result may only be a yield. Only a call
        // the transcript cannot govern is settled by the result that names it.
        const verdict = completion.commandCompletion(entry, identity.id, { environment, ancestry });
        if (verdict === null) state.settle(baseline, identity, call.digest, failed ? "failure" : "success");
        else if (verdict !== "pending") completion.finishCall(baseline, identity.id, verdict);
      }
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
    }
    const live = completion.liveCalls(baseline, environment, ancestry);
    if (completion.exclusiveCalls(live).length === 0 && (baseline.window.length > 0 || baseline.needsEvaluation)) problems = evaluate(context, baseline);
    context.repo.writeState(baseline);
  });
  if (problems.length === 0) return {};
  const reason = problems.join(" ");
  return failed ? { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: reason } } : { decision: "block", reason };
}

/** @param {Context} context @param {Record<string, unknown>} payload @returns {Output} */
function stop(context, payload) {
  /** @type {string[]} */
  let changed = [];
  context.repo.locked(() => {
    const baseline = context.repo.readState();
    if (baseline === null) return;
    if (completion.exclusiveCalls(completion.liveCalls(baseline, transcripts(context))).length === 0) {
      if (baseline.window.length > 0 || baseline.needsEvaluation) changed = evaluate(context, baseline);
      const found = drift(context, baseline);
      if (found.length > 0) changed.push(fill(DRIFT, found.join(", ")));
    }
    context.repo.writeState(baseline);
  });
  if (changed.length === 0) return {};
  const message = changed.join(" ");
  return payload.stop_hook_active ? { systemMessage: message } : { decision: "block", reason: message };
}

/** @param {Record<string, unknown>} settings @returns {boolean} whether every guard event still runs the launcher */
function guardRegistered(settings) {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  return CLAUDE_GUARD_EVENTS.every((event) => JSON.stringify(hooks[event] ?? []).includes("scripts/hooks/launch.sh"));
}

/** @param {Context} context @param {Record<string, unknown>} payload @returns {Output} Blocks Claude settings changes that switch the guard off. */
function configChange(context, payload) {
  const source = textOf(payload.source);
  const { repo } = context;
  /** @type {Record<string, string>} */
  const files = {
    user_settings: nodePath.join(repo.userHome, ".claude", "settings.json"),
    project_settings: nodePath.join(repo.root, ".claude", "settings.json"),
    local_settings: nodePath.join(repo.root, ".claude", "settings.local.json"),
  };
  const path = textOf(payload.file_path) || files[source] || "";
  const text = repo.readText(path);
  if (text === null) return {};
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { decision: "block", reason: "Settings that cannot be parsed would drop the guard." };
  }
  const settings = isObject(raw) ? raw : {};
  if (settings.disableAllHooks) {
    if (repo.realpath(path) !== repo.realpath(nodePath.join(repo.root, ".claude", "settings.json"))) {
      Reflect.deleteProperty(settings, "disableAllHooks");
      repo.writeText(path, `${JSON.stringify(settings, null, 2)}\n`);
    }
    return { decision: "block", reason: "disableAllHooks would switch the protected-files guard off." };
  }
  if (source === "project_settings" && !guardRegistered(settings))
    return { decision: "block", reason: "The project settings must keep the protected-files guard hooks." };
  return {};
}

/**
 * Fails an agent's commit whose staged protected content was never approved.
 * @param {Context} context @param {(text: string) => unknown} err @returns {number}
 */
function preCommit(context, err = (text) => process.stderr.write(text)) {
  const message = context.repo.locked(() => {
    const baseline = context.repo.readState();
    if (baseline === null) return null;
    // Calls the transcripts show as finished are settled and kept for the next evaluation, not forgotten.
    const running = Object.values(completion.liveCalls(baseline, transcripts(context)));
    context.repo.writeState(baseline);
    if (running.length === 0) return null;
    if (running.some((entry) => entry.route === "release-bump")) return null;
    const paths = candidates(context, baseline);
    const staged = unapproved(context.repo.indexIds(paths), context.repo.treeIds(paths), baseline.approved);
    const overrides = context.repo.stagedNames("A").filter((path) => context.inventory.isShadowOverride(path));
    const problems = [...staged, ...overrides];
    return problems.length > 0 ? `Unapproved protected changes are staged: ${problems.join(", ")}.\n` : null;
  });
  if (message === null) return 0;
  err(message);
  return 1;
}

/**
 * Records the current protected state as approved. The user runs or approves this; it never clears
 * a conflict that is still being resolved or the reservation of a call that has not finished.
 * @param {Context} context @param {(text: string) => unknown} out @returns {number}
 */
function accept(context, out) {
  return context.repo.locked(() => {
    /** @type {State | null} */
    let previous;
    try {
      previous = context.repo.readState();
    } catch (error) {
      out(
        `Not accepted: the guard state cannot be read (${/** @type {Error} */ (error).message}). Stop all sessions and have the user inspect ${context.repo.stateDir}.\n`,
      );
      return 1;
    }
    // A call its own transcript shows as finished no longer holds the user's approval back.
    if (previous) completion.liveCalls(previous, transcripts(context));
    const paths = candidates(context, previous);
    if (context.repo.operationInProgress() || context.repo.unmerged(paths).size > 0) {
      out("Not accepted: a merge, rebase, cherry-pick or revert is still waiting to be finished. Resolve it first.\n");
      return 1;
    }
    const pending = Object.entries(previous?.inflight ?? {}).filter(([, entry]) => entry.route !== "guard-accept");
    if (pending.length > 0) {
      out(`Not accepted: ${pending.length} call(s) that may change protected files have not finished.\n`);
      return 1;
    }
    const changed = previous ? drift(context, previous) : [];
    context.repo.writeState(snapshot(context, previous));
    out(`Accepted the current protected state${changed.length > 0 ? `: ${changed.join(", ")}` : ""}.\n`);
    return 0;
  });
}

/**
 * Chooses the policy the guard enforces: the copy recorded in the baseline when there is one, so an
 * edited working copy cannot shrink what is protected, and the working copy on the first run or when
 * the user accepts.
 * @param {{ baseline: State | null, stored: Buffer | null, working: () => Buffer }} sources
 * @returns {Buffer}
 */
function choosePolicy({ baseline, stored, working }) {
  if (baseline === null) return working();
  if (stored === null) throw new GuardError("the baseline's policy copy is missing; the user must run guard-accept again after inspecting the project");
  return stored;
}

/** @param {Buffer} policyText @returns {{ inventory: Context["inventory"], guardPolicy: GuardPolicy }} what the policy declares */
function parsePolicy(policyText) {
  /** @type {unknown} */
  const declared = JSON.parse(policyText.toString("utf8"));
  if (!isObject(declared)) throw new GuardError("tooling/policy.json must be an object");
  return { inventory: createInventory(declared.protected), guardPolicy: policy.parseGuardPolicy(declared.guard) };
}

/**
 * The context of an event on this machine.
 * @param {string} start @param {{ codexHome?: string, workingPolicy?: boolean }} [options] `workingPolicy` is for the user's accept, which adopts the policy in the working tree
 * @returns {{ context: (client: string) => Context }}
 */
function runtimeFor(start, options = {}) {
  const located = state.locateGit(start);
  const stateDir = nodePath.join(located.gitDir, state.STATE_DIR_NAME);
  const baseline = options.workingPolicy ? null : state.readState(stateDir);
  const policyText = choosePolicy({
    baseline,
    stored: baseline ? state.readBlob(stateDir, baseline.policy) : null,
    working: () => fs.readFileSync(nodePath.join(located.root, "tooling", "policy.json")),
  });
  const { inventory, guardPolicy } = parsePolicy(policyText);
  const repo = openRepo(located.root, inventory, options);
  return { context: (client) => ({ repo, policy: guardPolicy, inventory, client, policyText }) };
}

/** @param {number} fd @returns {Buffer} the whole input, read within a size limit */
function readInput(fd) {
  const chunks = [];
  let size = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let read;
    try {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    size += read;
    if (size > MAX_INPUT_BYTES) throw new GuardError("hook input is too large");
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

/** @param {Buffer | string} input @returns {Record<string, unknown>} the validated protocol envelope */
function parsePayload(input) {
  if (input.length > MAX_INPUT_BYTES) throw new GuardError("hook input is too large");
  /** @type {unknown} */
  const raw = JSON.parse(input.toString("utf8"));
  if (!isObject(raw)) throw new GuardError("hook payload must be an object");
  if ("tool_input" in raw && !isObject(raw.tool_input)) throw new GuardError("tool_input must be an object");
  return raw;
}

/**
 * What differs from the approved baseline, for the relock that must judge a manifest the user
 * already approved. A project with no approved baseline has nothing to compare with and is an error.
 * @param {string} root
 * @returns {string[]}
 */
function approvedDrift(root) {
  const context = runtimeFor(root).context("claude");
  const baseline = context.repo.readState();
  if (baseline === null) throw new GuardError("the guard has no approved baseline");
  return drift(context, baseline);
}

const EVENTS = ["pre", "post", "post-failure", "stop", "config-change", "pre-commit", "accept"];

/**
 * @param {string[]} argv
 * @returns {{ client: string, event: string } | null}
 */
function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name !== "--client" && name !== "--event") || value === undefined || Object.hasOwn(flags, name)) return null;
    flags[name] = value;
  }
  const client = flags["--client"] ?? "claude";
  const event = flags["--event"] ?? "";
  return (client === "claude" || client === "codex") && EVENTS.includes(event) ? { client, event } : null;
}

/**
 * Runs one hook event. Input the guard cannot evaluate blocks instead of passing.
 * @param {string[]} argv
 * @param {{ cwd?: string, stdin?: number, input?: () => Buffer | string, open?: (cwd: string, client: string, workingPolicy: boolean) => Context, stdout?: (text: string) => unknown, stderr?: (text: string) => unknown }} [io] `input` and `open` let a test answer from memory
 * @returns {number} the exit code
 */
function main(argv, io = {}) {
  const stdout = io.stdout ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((/** @type {string} */ text) => process.stderr.write(text));
  const parsed = parseArgv(argv);
  if (!parsed) {
    stderr(`usage: guard.cjs [--client claude|codex] --event ${EVENTS.join("|")}\n`);
    return 2;
  }
  try {
    const cwd = io.cwd ?? process.cwd();
    const open =
      io.open ??
      ((/** @type {string} */ start, /** @type {string} */ client, /** @type {boolean} */ workingPolicy) =>
        runtimeFor(start, { workingPolicy }).context(client));
    if (parsed.event === "pre-commit") return preCommit(open(cwd, parsed.client, false), stderr);
    if (parsed.event === "accept") return accept(open(cwd, parsed.client, true), stdout);
    const payload = parsePayload(io.input ? io.input() : readInput(io.stdin ?? 0));
    const context = open(typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : cwd, parsed.client, false);
    /** @type {Output} */
    let output;
    if (parsed.event === "pre") output = preTool(context, payload);
    else if (parsed.event === "post" || parsed.event === "post-failure") output = postTool(context, payload, parsed.event === "post-failure");
    else if (parsed.event === "stop") output = stop(context, payload);
    else output = configChange(context, payload);
    if (Object.keys(output).length > 0) stdout(JSON.stringify(output));
    return 0;
  } catch (error) {
    stderr(`Protected-files guard cannot evaluate this event: ${/** @type {Error} */ (error).message.slice(0, MAX_MESSAGE)}\n`);
    // Blocking a Stop would re-prompt the agent every turn while the error lasts.
    return parsed.event === "stop" ? 1 : 2;
  }
}

module.exports = {
  accept,
  approvedDrift,
  configChange,
  disablesHooks,
  drift,
  driftFromHead,
  evaluate,
  guardRegistered,
  choosePolicy,
  main,
  parseArgv,
  parsePayload,
  parsePolicy,
  postTool,
  preCommit,
  preTool,
  snapshot,
  stop,
  unapproved,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
