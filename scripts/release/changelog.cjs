// @ts-check
"use strict";
// The changelog of a release: the sections of CHANGELOG.md, which commits a new section is made of,
// and the template snapshot commits that are never among them. The text decisions are pure; the
// section itself is written by conventional-changelog, bound to an explicit package, version and
// commit range so that nothing is guessed from the nearest package.json or from an origin remote.
const { STATE_FILE } = require("../template/state.cjs");
const { verifyLineage } = require("../template/provenance.cjs");
const { ReleaseError, latestTag, tagOf } = require("./metadata.cjs");

const CHANGELOG_FILE = "CHANGELOG.md";
const TITLE = "# Changelog";
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** @param {string} tag @returns {RegExp} the heading of exactly this tag: nothing may follow it but a parenthesised date */
const headingOf = (tag) => new RegExp(`^## ${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\([^\\n]*\\))?$`);

/** @param {string} version @param {string} date @returns {string} */
const heading = (version, date) => `## ${tagOf(version)} (${date})`;

/** @param {string} text @param {string} tag @returns {number[]} the line numbers at which a section for the tag starts */
function startsOf(text, tag) {
  const pattern = headingOf(tag);
  return text
    .split("\n")
    .map((line, index) => (pattern.test(line) ? index : -1))
    .filter((index) => index >= 0);
}

/** @param {string} text @param {string} tag @returns {boolean} */
const hasSection = (text, tag) => startsOf(text, tag).length > 0;

/**
 * @param {string} text the changelog @param {string} tag
 * @returns {string} the one section of this tag, from its heading to the next section
 */
function extractSection(text, tag) {
  const starts = startsOf(text, tag);
  const lines = text.split("\n");
  const [start] = starts;
  if (starts.length !== 1 || start === undefined) throw new ReleaseError(`${CHANGELOG_FILE} must contain exactly one section for ${tag}.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return `${lines
    .slice(start, next === -1 ? lines.length : next)
    .join("\n")
    .trim()}\n`;
}

/**
 * @param {string | null} existing the changelog as it is, or null when the project has none
 * @param {string} section the new section, whose first line is its heading
 * @returns {string} the changelog with the new section above every earlier one; the earlier ones are not touched
 */
function compose(existing, section) {
  const tag = /^## (v\S+)/.exec(section)?.[1];
  if (tag === undefined) throw new ReleaseError("a changelog section starts with its heading");
  if (existing !== null && hasSection(existing, tag)) throw new ReleaseError(`${CHANGELOG_FILE} already has a section for ${tag}.`);
  const rest = existing === null ? "" : existing;
  const first = rest.split("\n").findIndex((line) => line.startsWith("## "));
  const head = first === -1 ? rest : rest.split("\n").slice(0, first).join("\n");
  const earlier = first === -1 ? "" : rest.split("\n").slice(first).join("\n");
  const title = head.trim() === "" ? TITLE : head.trimEnd();
  return `${title}\n\n${section.trim()}\n${earlier === "" ? "" : `\n${earlier}`}`;
}

/**
 * The transform conventional-changelog applies to every commit before the writer: the snapshot
 * commits of the template lineage are removed by their ids, and every other commit keeps the default
 * treatment of its date and tag. A real feature commit is never judged by its author, message or position.
 * @param {ReadonlySet<string>} excluded
 * @returns {import("conventional-changelog").CommitTransformFunction}
 */
function keepCommit(excluded) {
  return async (commit, params) => {
    if (typeof commit.hash === "string" && excluded.has(commit.hash)) return null;
    const { defaultCommitTransform } = await import("conventional-changelog");
    return defaultCommitTransform(commit, params);
  };
}

/** @typedef {import("../template/provenance.cjs").LineageGit & Pick<ReturnType<typeof import("../template/git.cjs").createGit>, "out">} LineageGit */

/**
 * The commits that belong to the template and not to the application: every baseline snapshot any
 * committed template state proves, everything below those snapshots, and the enrollment commit that
 * adds only the state to the initial baseline. Later application commits may also edit the state.
 * @param {LineageGit} git @param {string} root
 * @returns {{ excluded: Set<string>, baselines: string[], enrollments: string[] }}
 */
function snapshotLineage(git, root) {
  const carriers = [
    ...new Set(
      git
        .out(root, ["log", "--full-history", "-m", "-z", "--format=%H", "--", STATE_FILE])
        .split("\0")
        .filter((id) => id !== ""),
    ),
  ];
  /** @type {Set<string>} */
  const baselines = new Set();
  /** @type {string[]} */
  const enrollments = [];
  for (const commit of carriers) {
    try {
      const { state: parsed } = verifyLineage({ git: { ...git, head: () => commit }, root });
      baselines.add(parsed.baseline.commit);
      if (parsed.upstream === undefined) {
        const parents = git.out(root, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ").slice(1);
        if (parents.length === 1 && parents[0] === parsed.baseline.commit) {
          const changed = git.out(root, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", parsed.baseline.commit, commit]);
          if (changed === `${STATE_FILE}\0`) enrollments.push(commit);
        }
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "not-enrolled") continue;
      throw new ReleaseError(`the template state of commit ${commit.slice(0, 12)} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const below = baselines.size === 0 ? [] : git.out(root, ["rev-list", ...baselines]).split("\n");
  return { excluded: new Set([...below, ...enrollments].filter((id) => id !== "")), baselines: [...baselines], enrollments };
}

/**
 * Where the new section starts: after the latest release tag of the application itself (a tag on a
 * template commit is the template's), else after the enrollment commit, else at the first commit.
 * @param {LineageGit} git @param {string} root @param {{ excluded: ReadonlySet<string>, enrollments: readonly string[] }} lineage
 * @returns {string | null}
 */
function boundary(git, root, lineage) {
  const tags = git
    .out(root, ["tag", "--merged", "HEAD", "--list", "v*"])
    .split("\n")
    .filter((tag) => RELEASE_TAG.test(tag));
  const owned = tags.filter((tag) => !lineage.excluded.has(git.out(root, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim()));
  const latest = latestTag(owned);
  if (latest !== null) return `refs/tags/${latest}`;
  return lineage.enrollments.length === 1 ? (lineage.enrollments[0] ?? null) : null;
}

/**
 * The section for `version`, made by conventional-changelog from the Conventional Commits in
 * `from..HEAD` of the repository at `cwd` that are not template snapshots.
 * @param {{ cwd: string, name: string, version: string, date: string, from: string | null, excluded: ReadonlySet<string> }} input
 * @returns {Promise<string>} the section, headed `## vX.Y.Z (date)`
 */
async function generateSection({ cwd, name, version, date, from, excluded }) {
  const { ConventionalChangelog } = await import("conventional-changelog");
  const { default: createPreset } = await import("conventional-changelog-conventionalcommits");
  const generator = new ConventionalChangelog(cwd)
    .config(/** @type {import("conventional-changelog").Preset} */ (/** @type {unknown} */ (createPreset())))
    .package(/** @type {import("conventional-changelog").Package} */ (/** @type {unknown} */ ({ name, version })))
    .context({ version, date, linkReferences: false })
    .options({ transformCommit: keepCommit(excluded) })
    .commits({ ...(from === null ? {} : { from }), to: "HEAD" });
  let body = "";
  for await (const chunk of generator.write()) body += chunk;
  return `${[heading(version, date), ...body.split("\n").slice(1)].join("\n").trim()}\n`;
}

module.exports = {
  CHANGELOG_FILE,
  boundary,
  compose,
  extractSection,
  generateSection,
  hasSection,
  heading,
  keepCommit,
  snapshotLineage,
};
