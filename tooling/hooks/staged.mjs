import quality from "../../scripts/core/quality.cjs";

const { FORMAT_EXTENSIONS, LINT_FIX_EXTENSIONS } = quality;

const PRETTIER = "prettier --write --log-level=warn --ignore-unknown";
const LINTED = `*.{${LINT_FIX_EXTENSIONS.join(",")}}`;
const FORMATTED = `*.{${FORMAT_EXTENSIONS.filter((extension) => !LINT_FIX_EXTENSIONS.includes(extension)).join(",")}}`;

const config = {
  [LINTED]: ["eslint --max-warnings=0 --no-warn-ignored --fix", PRETTIER],
  [FORMATTED]: PRETTIER,
};

export default config;
