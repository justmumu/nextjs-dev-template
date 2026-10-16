import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

// One configuration for the generator and for generated applications. What differs between them is
// data in site.json; the version is the one in the project's own package.json; the base path comes
// from DOCS_BASE (for example /repo-name/). scripts/docs.cjs asks VitePress for the resolved values,
// so the link check never repeats them. Dead-link checking stays on: ignoreDeadLinks is never set.
const docs = createRequire(import.meta.url)("../../scripts/docs.cjs") as typeof import("../../scripts/docs.cjs");
const read = (path: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

interface Site {
  title: string;
  description: string;
  sidebar: { text: string; items: { text: string; link: string }[] }[];
}

const site = read("./site.json") as Site;
const version = docs.docsVersion(read("../../package.json"));

export default defineConfig({
  title: site.title,
  description: site.description,
  base: docs.siteBase(process.env.DOCS_BASE),
  cleanUrls: true,
  // Build output stays in the ignored dependency directory, away from the linters and formatters.
  outDir: fileURLToPath(new URL("../../node_modules/.cache/docs/site", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../node_modules/.cache/docs/vite", import.meta.url)),
  srcExclude: ["**/.compound-engineering/**", "**/.private/**"],
  themeConfig: {
    nav: [{ text: `v${version}`, link: "/" }],
    sidebar: site.sidebar,
    outline: { level: [2, 3] },
  },
});
