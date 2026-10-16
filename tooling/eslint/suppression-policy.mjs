import ts from "typescript";

// A suppression is accepted only as `eslint-disable-next-line <rule>[, <rule>] -- <concrete reason>`.
// File-wide, same-line and re-enabling directives, inline configuration comments, a missing rule and
// a missing or token reason are errors. Whether a suppression is still needed is enforced separately
// by `reportUnusedDisableDirectives`.
//
// This is a processor, not a rule: a rule can be switched off by `/* eslint <rule>: "off" */` or
// hidden by `/* eslint-disable */` in the file it checks, but the messages a processor appends after
// linting are out of reach of every inline comment. Comments are found by parsing the file, so words
// inside strings, templates, regular expressions and JSX text are not directives.

const RULE_ID = "suppression-policy/require-specific-reason";
const DIRECTIVE = /^\s*(eslint-disable(?:-next-line|-line)?|eslint-enable|eslint-env|eslint)(?=\s|$)([\s\S]*)$/;
const RULE_LIST = /^[@a-z0-9/_-]+(?:\s*,\s*[@a-z0-9/_-]+)*$/;
const MIN_REASON_LENGTH = 20;

/** @param {string} rest the text after the directive name @returns {string | null} what is wrong, or null */
function problem(rest) {
  const separator = rest.indexOf(" -- ");
  const rules = (separator === -1 ? rest : rest.slice(0, separator)).trim();
  const reason = separator === -1 ? "" : rest.slice(separator + 4).trim();
  if (!RULE_LIST.test(rules)) return "name the exact rule(s) being suppressed";
  if (reason.length < MIN_REASON_LENGTH)
    return `explain why in at least ${String(MIN_REASON_LENGTH)} characters after " -- " (upstream issue, third-party limitation or approved architecture)`;
  return null;
}

/** @param {string} name @returns {ts.ScriptKind} */
function scriptKind(name) {
  if (/\.[cm]?ts$/.test(name)) return ts.ScriptKind.TS;
  if (name.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.JS;
}

/**
 * Every comment of a file, found through the TypeScript parser. A comment is trivia before some
 * token, so visiting every token reaches all of them; JSX text is skipped because its `//` is text.
 * @param {string} text
 * @param {string} name
 * @returns {{ source: ts.SourceFile, found: { pos: number, end: number, kind: ts.CommentKind }[] }}
 */
function comments(text, name) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, scriptKind(name));
  /** @type {Map<number, { pos: number, end: number, kind: ts.CommentKind }>} */
  const found = new Map();
  /** @param {ts.CommentRange[] | undefined} ranges */
  const collect = (ranges) => {
    for (const { pos, end, kind } of ranges ?? []) found.set(pos, { pos, end, kind });
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    if (node.getChildCount(source) === 0) {
      collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
      collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    }
    for (const child of node.getChildren(source)) if (!ts.isJSDoc(child)) visit(child);
  };
  visit(source);
  return { source, found: [...found.values()].sort((a, b) => a.pos - b.pos) };
}

/**
 * @param {string} text
 * @param {string} name
 * @returns {import("eslint").Linter.LintMessage[]}
 */
function refusals(text, name) {
  /** @type {import("eslint").Linter.LintMessage[]} */
  const messages = [];
  const { source, found } = comments(text, name);
  for (const { pos, end, kind } of found) {
    const body = text.slice(pos + 2, kind === ts.SyntaxKind.MultiLineCommentTrivia ? end - 2 : end);
    const match = DIRECTIVE.exec(body);
    if (!match?.[1]) continue;
    const detail =
      match[1] === "eslint-disable-next-line"
        ? problem(match[2] ?? "")
        : match[1] === "eslint-disable" || match[1] === "eslint-disable-line" || match[1] === "eslint-enable"
          ? "only eslint-disable-next-line for a named rule is allowed"
          : "inline ESLint configuration is not allowed; change the reviewed configuration instead";
    if (detail === null) continue;
    const start = source.getLineAndCharacterOfPosition(pos);
    messages.push({
      ruleId: RULE_ID,
      severity: 2,
      message: `Suppression refused: ${detail}.`,
      line: start.line + 1,
      column: start.character + 1,
    });
  }
  return messages;
}

// The refusals are computed from the text in preprocess and appended in postprocess, which ESLint
// calls in pairs for one file at a time (once more per pass when fixing).
/** @type {Map<string, import("eslint").Linter.LintMessage[]>} */
const pending = new Map();

/** @type {import("eslint").Linter.Processor} */
const processor = {
  meta: { name: "suppression-policy", version: "1.0.0" },
  supportsAutofix: true,
  preprocess(text, filename) {
    pending.set(filename, refusals(text, filename));
    return [text];
  },
  postprocess(messageLists, filename) {
    const refused = pending.get(filename) ?? [];
    pending.delete(filename);
    return [...messageLists.flat(), ...refused];
  },
};

const plugin = { processors: { enforce: processor } };

export default plugin;
